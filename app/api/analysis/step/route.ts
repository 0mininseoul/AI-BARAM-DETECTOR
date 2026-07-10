import { supabaseAdmin } from '@/lib/supabase/admin';
import { createClient } from '@/lib/supabase/server';
import { NextResponse } from 'next/server';
import {
    getInstagramProfile,
    getFollowers,
    getFollowing,
    extractMutualFollows,
    classifyByPrivacy,
    getProfilesBatch,
} from '@/lib/services/instagram/scraper';
import {
    analyzeCombined,
    getCachedCombinedProfileSnapshots,
} from '@/lib/services/ai/combined-analysis';
import {
    analyzeDeepRiskNarrative,
    parseDeepRiskNarrativeForInput,
    type DeepRiskNarrativeInput,
} from '@/lib/services/ai/deep-risk-analysis';
import {
    analyzePrivateAccountNames,
    type PrivateNameAnalysisResult,
} from '@/lib/services/ai/private-name-analysis';
import { getVertexAIAnalysisConcurrency } from '@/lib/services/ai/pipeline-config';
import {
    getProfileCacheMissUsernames,
    mergeCachedAndScrapedProfiles,
} from '@/lib/services/analysis/profile-cache';
import {
    requireInsertedMutationRows,
    requireSingleMutationRow,
} from '@/lib/services/analysis/persistence';
import {
    getPhotogenicScore,
    getExposureScore,
    classifyGenderStatus,
    classifyRiskGrade,
    getHighRiskCount,
    TAG_SCORE,
} from '@/lib/constants/scoring';
import { sendAnalysisCompleteEmail } from '@/lib/services/email';
import type { AnalyzedAccount } from '@/lib/types/analysis';
import { createSupabaseScraperTelemetryHook } from '@/lib/services/instagram/supabase-telemetry';
import { parseScraperProviderSelection } from '@/lib/services/instagram/config';
import { expectedRelationshipCount } from '@/lib/services/instagram/completeness';
import {
    apifyInteractionAdapter,
    type ApifyPostComment,
    type ApifyPostLiker,
} from '@/lib/services/instagram/providers/apify-interactions';
import type {
    Capability,
    ScrapeRequestOptions,
    ScraperProviderSelection,
    ScraperTelemetryHook,
} from '@/lib/services/instagram/providers/types';
import {
    type AnalysisStep,
    type StepData,
    BATCH_SIZE,
    PROFILE_BATCH_SIZE,
    calculateBatchProgress,
} from '@/lib/services/analysis/steps';
import {
    acquireAnalysisRequestLease,
    isAnalysisRequestOwner,
    releaseAnalysisRequestLease,
} from '@/lib/services/analysis/request-lease';
import { hasValidAnalysisRequestIdempotencyKey } from '@/lib/services/analysis/request-eligibility';
import {
    capPublicProfiles,
    getRelationshipScrapeLimit,
} from '@/lib/services/analysis/plan-limits';
import {
    CANDIDATE_INTERACTION_BATCH_SIZE,
    CANDIDATE_INTERACTION_POST_LIMIT,
    CANDIDATE_LIKER_LIMIT_PER_POST,
    extractCandidateInteractions,
    extractTargetInteractions,
    parseStoredInteractionCoverage,
    rankObservedInteractionCandidates,
    scoreCandidateInteractions,
    TARGET_COMMENT_LIMIT_PER_POST,
    TARGET_COMMENT_POST_LIMIT,
    TARGET_INTERACTION_POST_LIMIT,
    TARGET_LIKER_LIMIT_PER_POST,
    TARGET_LIKER_POST_LIMIT,
    type CandidateAccountPosts,
    type InteractionEvidenceRow,
    type StoredInteractionCoverage,
} from '@/lib/services/analysis/interaction-stage';
import {
    instagramPostUrl,
    selectRecentInteractionPosts,
} from '@/lib/services/analysis/interaction-posts';
import type { InstagramPost } from '@/lib/types/instagram';
import type { ProviderUsageDelta } from '@/lib/services/instagram/providers/types';
import { readBoundedDatabasePages } from '@/lib/services/analysis/paginated-query';
import {
    getRecentMutualBonus,
    inferRecentMutualFemaleRanks,
    orderedMutualUsernamesFromStepData,
} from '@/lib/services/analysis/recent-mutuals';
import {
    enqueueAnalysisTask,
    verifyAnalysisTaskAuthorization,
} from '@/lib/services/analysis/background-tasks';
import {
    buildSafeFallbackRiskNarrative,
    parseSafePublicRiskNarrative,
} from '@/lib/services/analysis/narrative-privacy';

const STEP_LEASE_SECONDS = 1_800;
const MAX_INTERACTION_EVIDENCE_ROWS = 2_500;

// 단계별 분석 처리 API
export async function POST(request: Request) {
    try {
        const isBackgroundTask = await verifyAnalysisTaskAuthorization(
            request.headers.get('authorization')
        );
        let userId: string | null = null;
        if (!isBackgroundTask) {
            const supabase = await createClient();
            const { data: { user }, error: authError } = await supabase.auth.getUser();
            if (authError || !user) {
                return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
            }
            userId = user.id;
        }

        const { requestId } = await request.json();

        if (!requestId) {
            return NextResponse.json({ error: 'requestId required' }, { status: 400 });
        }

        // 분석 요청 조회
        const { data: analysisRequest, error: fetchError } = await supabaseAdmin
            .from('analysis_requests')
            .select('*, users(email)')
            .eq('id', requestId)
            .single();

        if (fetchError || !analysisRequest) {
            return NextResponse.json({ error: 'Request not found' }, { status: 404 });
        }
        if (!isBackgroundTask && !isAnalysisRequestOwner(userId ?? '', analysisRequest.user_id)) {
            return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
        }

        // 이미 완료되었거나 실패한 경우
        if (analysisRequest.status === 'completed' || analysisRequest.status === 'failed') {
            return NextResponse.json({
                success: true,
                step: analysisRequest.current_step,
                status: analysisRequest.status,
                done: true,
            });
        }
        if (!hasValidAnalysisRequestIdempotencyKey(analysisRequest)) {
            return NextResponse.json(
                { error: 'Legacy analysis request cannot execute paid steps.' },
                { status: 403 }
            );
        }

        const currentStep = (analysisRequest.current_step || 'pending') as AnalysisStep;
        const stepData: StepData = analysisRequest.step_data || {};
        const scraperOptions = parseScraperProviderSelection(stepData.scraperOptions);
        const scraperTelemetry = createSupabaseScraperTelemetryHook();
        const targetId = analysisRequest.target_instagram_id;
        const scrapeLimit = getRelationshipScrapeLimit(analysisRequest.plan_type);

        const lease = await acquireAnalysisRequestLease(
            supabaseAdmin,
            {
                requestId,
                userId: analysisRequest.user_id,
                expectedStep: currentStep,
                leaseSeconds: STEP_LEASE_SECONDS,
            }
        );
        if (!lease) {
            return NextResponse.json(
                { error: 'Analysis step is already processing or has advanced.' },
                { status: 409 }
            );
        }

        try {
            // 현재 단계에 따라 처리
            switch (currentStep) {
                case 'pending':
                    // collect 단계로 전환
                    await updateStep(requestId, 'collect', stepData, 5, '분석 시작...');
                    return NextResponse.json({
                        success: true,
                        step: 'collect',
                        done: false,
                    });

                case 'collect':
                    return await processCollect(
                        requestId,
                        targetId,
                        scrapeLimit,
                        stepData,
                        scraperOptions,
                        scraperTelemetry
                    );

                case 'profiles':
                    return await processProfiles(
                        requestId,
                        targetId,
                        stepData,
                        scraperOptions,
                        scraperTelemetry
                    );

                case 'analyze':
                    return await processAnalyze(requestId, stepData);

                case 'interactions':
                    return await processInteractions(requestId, targetId, stepData);

                case 'deep_analysis':
                    return await processDeepAnalysis(requestId, targetId, stepData);

                case 'finalize':
                    return await processFinalize(requestId, analysisRequest, stepData);

                // 레거시 단계 처리 (하위 호환성 - analyze로 리다이렉트)
                case 'gender':
                case 'features':
                    await updateStep(requestId, 'analyze', { ...stepData, analyzeBatchIndex: 0, combinedResults: {} }, 50, 'AI 분석 준비 중...');
                    return NextResponse.json({
                        success: true,
                        step: 'analyze',
                        done: false,
                    });

                default:
                    return NextResponse.json({
                        success: true,
                        step: currentStep,
                        done: true,
                    });
            }
        } catch (pipelineError) {
            const errorMessage = pipelineError instanceof Error ? pipelineError.message : 'Unknown error';
            console.error('Analysis step failed', { requestId, currentStep });

            const failedStateMutation = await supabaseAdmin
                .from('analysis_requests')
                .update({
                    status: 'failed',
                    current_step: 'failed',
                    error_message: errorMessage,
                })
                .eq('id', requestId)
                .select('id')
                .maybeSingle();
            if (failedStateMutation.error || !failedStateMutation.data) {
                console.error('Failed to persist analysis failure state', { requestId, currentStep });
            }

            return NextResponse.json({ error: errorMessage, step: currentStep }, { status: 500 });
        } finally {
            await releaseAnalysisRequestLease(supabaseAdmin, lease);
            if (isBackgroundTask) {
                await enqueueBackgroundContinuation(requestId);
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Step failed';
        console.error('Analysis step API failed');
        return NextResponse.json(
            { error: message },
            { status: 500 }
        );
    }
}

async function enqueueBackgroundContinuation(requestId: string): Promise<void> {
    const { data, error } = await supabaseAdmin
        .from('analysis_requests')
        .select('status, current_step, progress, step_data, background_processing')
        .eq('id', requestId)
        .maybeSingle();
    if (error || !data) {
        throw new Error('ANALYSIS_TASKS_ENQUEUE_ERROR: continuation state read failed.');
    }
    if (
        data.background_processing !== true
        || !['pending', 'processing'].includes(data.status)
    ) {
        return;
    }

    const outcome = await enqueueAnalysisTask(requestId, {
        currentStep: data.current_step || 'pending',
        progress: Number(data.progress ?? 0),
        stepData: (data.step_data ?? {}) as StepData,
    });
    if (outcome === 'disabled') {
        throw new Error('ANALYSIS_TASKS_CONFIG_ERROR: background continuation is disabled.');
    }
}

function providerOptions(
    selection: ScraperProviderSelection,
    capability: Capability,
    requestId: string,
    onTelemetry: ScraperTelemetryHook,
    expectedResultCount?: number
): ScrapeRequestOptions {
    return {
        provider: selection[capability],
        fallback: selection.fallback,
        requestId,
        onTelemetry,
        expectedResultCount,
    };
}

// 상태 업데이트 헬퍼
async function updateStep(
    requestId: string,
    step: AnalysisStep,
    stepData: StepData,
    progress: number,
    progressStep: string
) {
    const mutation = await supabaseAdmin
        .from('analysis_requests')
        .update({
            status: 'processing',
            current_step: step,
            step_data: stepData,
            progress,
            progress_step: progressStep,
        })
        .eq('id', requestId)
        .select('id')
        .maybeSingle();
    requireSingleMutationRow(mutation, 'analysis step update');
}

// Step 1: 프로필 + 팔로워/팔로잉 수집 + 맞팔 추출
async function processCollect(
    requestId: string,
    targetId: string,
    scrapeLimit: number,
    stepData: StepData,
    scraperOptions: ScraperProviderSelection,
    scraperTelemetry: ScraperTelemetryHook
) {
    // 프로필 수집
    await updateStep(requestId, 'collect', stepData, 5, '대상 계정 정보 수집 중...');
    const profile = await getInstagramProfile(
        targetId,
        providerOptions(scraperOptions, 'profile', requestId, scraperTelemetry)
    );

    if (!profile) {
        throw new Error('계정을 찾을 수 없습니다.');
    }

    if (profile.isPrivate) {
        throw new Error('비공개 계정은 분석할 수 없습니다.');
    }

    // 팔로워/팔로잉 수집
    await updateStep(requestId, 'collect', stepData, 15, '팔로워/팔로잉 목록 수집 중...');
    const [followers, following] = await Promise.all([
        getFollowers(
            targetId,
            scrapeLimit,
            providerOptions(
                scraperOptions,
                'followers',
                requestId,
                scraperTelemetry,
                expectedRelationshipCount(profile.followersCount, scrapeLimit)
            )
        ),
        getFollowing(
            targetId,
            scrapeLimit,
            providerOptions(
                scraperOptions,
                'following',
                requestId,
                scraperTelemetry,
                expectedRelationshipCount(profile.followingCount, scrapeLimit)
            )
        ),
    ]);

    // 맞팔 추출
    await updateStep(requestId, 'collect', stepData, 25, '맞팔 계정 분석 중...');
    const mutualFollows = extractMutualFollows(followers, following);

    // 공개/비공개 분류
    const { publicAccounts, privateAccounts } = classifyByPrivacy(mutualFollows);

    // 비공개 계정은 사진/게시물 없이 username과 표시 이름만 100개 단위로 분류한다.
    let privateNameResults: PrivateNameAnalysisResult[] = [];
    if (privateAccounts.length > 0) {
        try {
            privateNameResults = await analyzePrivateAccountNames(
                privateAccounts.map(account => ({
                    id: account.username,
                    username: account.username,
                    ...(account.fullName ? { fullName: account.fullName } : {}),
                })),
                requestId
            );
        } catch {
            console.warn('Private account name analysis input failed; using neutral ordering', {
                requestId,
            });
            privateNameResults = privateAccounts.map(account => ({
                id: account.username,
                femaleScore: 0.5,
                isName: false,
                confidence: 0,
            }));
        }
    }
    const privateNameByUsername = new Map(
        privateNameResults.map(result => [normalizedUsername(result.id), result])
    );

    // 비공개 계정 저장
    if (privateAccounts.length > 0) {
        const inserted = await supabaseAdmin.from('private_accounts').upsert(
            privateAccounts.map((account) => {
                const nameAnalysis = privateNameByUsername.get(
                    normalizedUsername(account.username)
                );
                return {
                    request_id: requestId,
                    instagram_id: account.username,
                    profile_image: account.profilePicUrl,
                    full_name: account.fullName,
                    name_female_score: nameAnalysis?.femaleScore ?? 0.5,
                    name_is_name: nameAnalysis?.isName ?? false,
                    name_confidence: nameAnalysis?.confidence ?? 0,
                };
            }),
            { onConflict: 'request_id,instagram_id' }
        ).select('id');
        requireInsertedMutationRows(inserted, privateAccounts.length, 'private accounts insert');
    }

    // 통계 업데이트
    const collectStatsMutation = await supabaseAdmin
        .from('analysis_requests')
        .update({
            total_followers: followers.length,
            mutual_follows: mutualFollows.length,
        })
        .eq('id', requestId)
        .select('id')
        .maybeSingle();
    requireSingleMutationRow(collectStatsMutation, 'collection statistics update');

    // step_data 업데이트
    const newStepData: StepData = {
        ...stepData,
        mutualFollows: mutualFollows.map((m) => m.username),
        targetProfileImage: profile.profilePicUrl,
        targetPosts: selectRecentInteractionPosts(
            profile.latestPosts ?? [],
            TARGET_INTERACTION_POST_LIMIT
        ).map(post => ({
            id: post.id,
            shortCode: post.shortCode,
            type: post.type,
            likesCount: Math.max(0, post.likesCount),
            commentsCount: Math.max(0, post.commentsCount),
            timestamp: post.timestamp,
        })),
        publicAccounts: capPublicProfiles(publicAccounts).map((a) => ({
            username: a.username,
            profilePicUrl: a.profilePicUrl,
            isPrivate: a.isPrivate,
        })),
    };

    // 다음 단계로 전환
    await updateStep(requestId, 'profiles', newStepData, 30, '공개 계정 프로필 수집 준비 중...');

    return NextResponse.json({
        success: true,
        step: 'profiles',
        done: false,
        stats: {
            totalFollowers: followers.length,
            mutualFollows: mutualFollows.length,
            publicAccounts: publicAccounts.length,
            privateAccounts: privateAccounts.length,
        },
    });
}

// Step 2: 공개 계정 프로필 배치 수집
async function processProfiles(
    requestId: string,
    targetId: string,
    stepData: StepData,
    scraperOptions: ScraperProviderSelection,
    scraperTelemetry: ScraperTelemetryHook
) {
    const publicAccounts = stepData.publicAccounts || [];
    const batchIndex = stepData.profileBatchIndex || 0;
    const accountsWithPosts = stepData.accountsWithPosts || [];

    if (publicAccounts.length === 0) {
        // 공개 계정이 없으면 바로 완료
        await updateStep(requestId, 'finalize', stepData, 97, '결과 저장 중...');
        return NextResponse.json({
            success: true,
            step: 'finalize',
            done: false,
        });
    }

    const totalBatches = Math.ceil(publicAccounts.length / PROFILE_BATCH_SIZE);

    // 모든 배치 완료 시 다음 단계로
    if (batchIndex >= totalBatches) {
        const newStepData: StepData = {
            ...stepData,
            analyzeBatchIndex: 0,
            combinedResults: {},
        };

        await updateStep(requestId, 'analyze', newStepData, 50, 'AI 분석 준비 중...');

        return NextResponse.json({
            success: true,
            step: 'analyze',
            done: false,
            stats: {
                profilesCollected: accountsWithPosts.length,
            },
        });
    }

    // 현재 배치 처리
    const startIdx = batchIndex * PROFILE_BATCH_SIZE;
    const endIdx = Math.min(startIdx + PROFILE_BATCH_SIZE, publicAccounts.length);
    const batch = publicAccounts.slice(startIdx, endIdx);

    const progress = 30 + Math.round((batchIndex / totalBatches) * 20); // 30~50%
    await updateStep(
        requestId,
        'profiles',
        stepData,
        progress,
        `프로필 수집 중... (${batchIndex + 1}/${totalBatches})`
    );

    // Current-version cache snapshots can skip the profile provider for up to the bounded TTL.
    // Cache/query failures return no snapshots, so the existing provider path remains the fallback.
    const cachedSnapshots = await getCachedCombinedProfileSnapshots(
        batch.map(account => account.username)
    );
    const missingUsernames = getProfileCacheMissUsernames(batch, cachedSnapshots);
    const profiles = missingUsernames.length > 0
        ? await getProfilesBatch(
            missingUsernames,
            missingUsernames.length,
            providerOptions(scraperOptions, 'profilesBatch', requestId, scraperTelemetry)
        )
        : [];

    const batchAccountsWithPosts = mergeCachedAndScrapedProfiles(
        batch,
        cachedSnapshots,
        profiles
    );

    // 기존 결과에 추가
    const updatedAccountsWithPosts = [...accountsWithPosts, ...batchAccountsWithPosts];

    const newStepData: StepData = {
        ...stepData,
        accountsWithPosts: updatedAccountsWithPosts,
        profileBatchIndex: batchIndex + 1,
    };

    const newProgress = 30 + Math.round(((batchIndex + 1) / totalBatches) * 20);
    await updateStep(
        requestId,
        'profiles',
        newStepData,
        newProgress,
        `프로필 수집 중... (${batchIndex + 1}/${totalBatches})`
    );

    return NextResponse.json({
        success: true,
        step: 'profiles',
        done: false,
        batchProgress: {
            current: batchIndex + 1,
            total: totalBatches,
        },
    });
}

// Step 3: 통합 분석 (성별 + 여성인 경우 외모/노출) + 캐싱 + 토큰 추적
async function processAnalyze(requestId: string, stepData: StepData) {
    const accountsWithPosts = stepData.accountsWithPosts || [];
    const batchIndex = stepData.analyzeBatchIndex || 0;
    const combinedResults = stepData.combinedResults || {};

    const totalBatches = Math.ceil(accountsWithPosts.length / BATCH_SIZE);

    if (batchIndex >= totalBatches) {
        // 모든 배치 완료 - 통계 계산 후 finalize 단계로
        const genderStats = { male: 0, female: 0, unknown: 0 };
        let femaleCount = 0;

        for (const account of accountsWithPosts) {
            const result = combinedResults[account.profile.username];
            if (!result) continue;

            if (result.gender === 'male') genderStats.male++;
            else if (result.gender === 'female') {
                genderStats.female++;
                const { include } = classifyGenderStatus(result.gender, result.genderConfidence);
                if (include) femaleCount++;
            }
            else genderStats.unknown++;
        }

        const genderStatsMutation = await supabaseAdmin
            .from('analysis_requests')
            .update({
                opposite_gender_count: femaleCount,
                gender_stats: genderStats,
            })
            .eq('id', requestId)
            .select('id')
            .maybeSingle();
        requireSingleMutationRow(genderStatsMutation, 'gender statistics update');

        const newStepData: StepData = {
            ...stepData,
            combinedResults,
            interactionStage: 'target',
            interactionCandidateBatchIndex: 0,
        };

        await updateStep(requestId, 'interactions', newStepData, 82, '상호작용 수집 준비 중...');

        return NextResponse.json({
            success: true,
            step: 'interactions',
            done: false,
            stats: {
                genderStats,
                femaleCount,
            },
        });
    }

    // 현재 배치 처리
    const startIdx = batchIndex * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, accountsWithPosts.length);
    const batch = accountsWithPosts.slice(startIdx, endIdx);

    const progress = calculateBatchProgress('analyze', batchIndex, totalBatches);
    await updateStep(
        requestId,
        'analyze',
        stepData,
        progress,
        `AI 분석 중... (${batchIndex + 1}/${totalBatches})`
    );

    // 품질 모드의 이미지 디코딩 부하를 고려해 기본 5, 환경 변수로 최대 10까지 조절
    const subBatchSize = getVertexAIAnalysisConcurrency();
    for (let i = 0; i < batch.length; i += subBatchSize) {
        const subBatch = batch.slice(i, i + subBatchSize);
        const results = await Promise.all(
            subBatch.map(async (account) => {
                try {
                    const result = await analyzeCombined({
                        profile: account.profile as Parameters<typeof analyzeCombined>[0]['profile'],
                        recentPosts: account.recentPosts as Parameters<typeof analyzeCombined>[0]['recentPosts'],
                        refreshCacheSnapshot: account.profileSource === 'provider',
                        requestId, // 토큰 추적용
                    });
                    return { username: account.profile.username, result };
                } catch {
                    console.error('Combined analysis failed for one account', { requestId });
                    return {
                        username: account.profile.username,
                        result: {
                            gender: 'unknown' as const,
                            genderConfidence: 0,
                            genderReasoning: 'Analysis failed',
                        },
                    };
                }
            })
        );

        for (const { username, result } of results) {
            combinedResults[username] = {
                gender: result.gender,
                genderConfidence: result.genderConfidence,
                photogenicGrade: result.photogenicGrade,
                photogenicConfidence: result.photogenicConfidence,
                skinVisibility: result.skinVisibility,
                exposureConfidence: result.exposureConfidence,
                ownerIdentified: result.ownerIdentified,
                isMarried: result.isMarried,
                marriedConfidence: result.marriedConfidence,
                isForeigner: result.isForeigner,
                foreignerConfidence: result.foreignerConfidence,
            };
        }
    }

    const newStepData: StepData = {
        ...stepData,
        combinedResults,
        analyzeBatchIndex: batchIndex + 1,
    };

    await updateStep(
        requestId,
        'analyze',
        newStepData,
        calculateBatchProgress('analyze', batchIndex + 1, totalBatches),
        `AI 분석 중... (${batchIndex + 1}/${totalBatches})`
    );

    return NextResponse.json({
        success: true,
        step: 'analyze',
        done: false,
        batchProgress: {
            current: batchIndex + 1,
            total: totalBatches,
        },
    });
}

interface InteractionUsage {
    estimatedCostUsd: number;
}

interface StoredInteractionJob {
    kind: 'target_likers' | 'target_comments' | 'candidate_likers';
    batch_index: number;
    status: 'running' | 'completed' | 'failed';
    coverage: unknown;
}

function interactionUsageContext(usage: InteractionUsage) {
    return {
        recordUsage(delta: ProviderUsageDelta) {
            usage.estimatedCostUsd += delta.estimated_cost_usd ?? 0;
        },
    };
}

function targetPostsFromStepData(stepData: StepData): InstagramPost[] {
    return (stepData.targetPosts ?? []).map(post => ({
        ...post,
        taggedUsers: [],
        mentionedUsers: [],
    }));
}

function candidatePostsFromStepData(
    account: NonNullable<StepData['accountsWithPosts']>[number]
): InstagramPost[] {
    return account.recentPosts.map(post => ({
        id: post.id,
        shortCode: post.shortCode,
        caption: post.caption,
        hashtags: post.hashtags ?? [],
        imageUrl: post.imageUrl,
        type: post.type,
        likesCount: Math.max(0, post.likesCount),
        commentsCount: Math.max(0, post.commentsCount),
        timestamp: post.timestamp,
        taggedUsers: post.taggedUsers ?? [],
        mentionedUsers: post.mentionedUsers ?? [],
    }));
}

function femaleInteractionAccounts(stepData: StepData) {
    const combinedResults = stepData.combinedResults ?? {};
    return (stepData.accountsWithPosts ?? []).filter(account => {
        const result = combinedResults[account.profile.username];
        if (!result) return false;
        return classifyGenderStatus(result.gender, result.genderConfidence).include;
    });
}

type FemaleInteractionAccount = ReturnType<typeof femaleInteractionAccounts>[number];

function normalizedUsername(value: string): string {
    return value.trim().replace(/^@/, '').toLowerCase();
}

function getCandidateIntermediateEvidence(
    targetId: string,
    stepData: StepData,
    account: FemaleInteractionAccount
) {
    const username = normalizedUsername(account.profile.username);
    const targetUsername = normalizedUsername(targetId);
    const combinedResult = stepData.combinedResults?.[account.profile.username];
    const isTagged = account.recentPosts.some(post =>
        [...(post.taggedUsers ?? []), ...(post.mentionedUsers ?? [])]
            .some(value => normalizedUsername(value) === targetUsername)
    );
    const photogenicGrade = combinedResult?.photogenicGrade ?? 1;
    const exposureLevel = combinedResult?.skinVisibility ?? 'low';
    const isMarried = combinedResult?.isMarried ?? false;
    const isForeigner = combinedResult?.isForeigner ?? false;
    const baseFeatureScore = isMarried || isForeigner
        ? 0
        : getPhotogenicScore(photogenicGrade)
            + getExposureScore(exposureLevel)
            + (isTagged ? TAG_SCORE : 0);
    const recencyBonus = getRecentMutualBonus(
        username,
        orderedMutualUsernamesFromStepData(stepData)
    );

    return {
        username,
        photogenicGrade,
        exposureLevel,
        ownerIdentified: combinedResult?.ownerIdentified,
        isTagged,
        isMarried,
        isForeigner,
        recencyBonus,
        intermediateScore: baseFeatureScore + recencyBonus,
    };
}

function interactionErrorCode(error: unknown): string {
    const message = error instanceof Error ? error.message : '';
    const match = message.match(/(?:SCRAPING|INTERACTION)_[A-Z_]+/);
    return match?.[0]?.slice(0, 100) ?? 'INTERACTION_PROVIDER_ERROR';
}

async function persistInteractionJob(input: {
    requestId: string;
    kind: StoredInteractionJob['kind'];
    batchIndex: number;
    postCount: number;
    requestedPerPost: number;
    returnedCount: number;
    estimatedCostUsd: number;
    coverage: StoredInteractionCoverage[];
    status: StoredInteractionJob['status'];
    errorCode?: string;
}) {
    const mutation = await supabaseAdmin
        .from('analysis_interaction_jobs')
        .upsert({
            request_id: input.requestId,
            kind: input.kind,
            batch_index: input.batchIndex,
            provider: 'apify',
            post_count: input.postCount,
            requested_per_post: input.requestedPerPost,
            requested_result_cap: input.postCount * input.requestedPerPost,
            returned_count: input.returnedCount,
            estimated_cost_usd: input.estimatedCostUsd,
            coverage: input.coverage,
            status: input.status,
            error_code: input.errorCode,
            updated_at: new Date().toISOString(),
        }, {
            onConflict: 'request_id,kind,batch_index',
        })
        .select('id')
        .maybeSingle();
    requireSingleMutationRow(mutation, 'interaction job upsert');
}

async function failInterruptedInteractionJobs(requestId: string) {
    const mutation = await supabaseAdmin
        .from('analysis_interaction_jobs')
        .update({
            status: 'failed',
            error_code: 'INTERACTION_RUN_INTERRUPTED',
            updated_at: new Date().toISOString(),
        })
        .eq('request_id', requestId)
        .eq('status', 'running');
    if (mutation.error) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: interrupted interaction jobs update failed.');
    }
}

async function persistInteractionEvidence(
    requestId: string,
    evidence: InteractionEvidenceRow[]
) {
    if (evidence.length === 0) return;
    const mutation = await supabaseAdmin
        .from('analysis_interaction_evidence')
        .upsert(evidence.map(row => ({
            request_id: requestId,
            candidate_username: row.candidateUsername,
            post_id: row.postId,
            signal: row.signal,
            source_interaction_id: row.sourceInteractionId,
            occurred_at: row.occurredAt,
            comment_text: row.content ?? null,
        })), {
            onConflict: 'request_id,candidate_username,signal,post_id,source_interaction_id',
            ignoreDuplicates: true,
        });
    if (mutation.error) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: interaction evidence upsert failed.');
    }
}

async function getInteractionJobs(
    requestId: string,
    kind?: StoredInteractionJob['kind']
): Promise<StoredInteractionJob[]> {
    let query = supabaseAdmin
        .from('analysis_interaction_jobs')
        .select('kind, batch_index, status, coverage')
        .eq('request_id', requestId);
    if (kind) query = query.eq('kind', kind);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: interaction jobs read failed.');
    }
    return data as StoredInteractionJob[];
}

async function getInteractionEvidence(requestId: string): Promise<InteractionEvidenceRow[]> {
    const data = await readBoundedDatabasePages(
        (from, to) => supabaseAdmin
            .from('analysis_interaction_evidence')
            .select('id, candidate_username, post_id, signal, source_interaction_id, occurred_at, comment_text')
            .eq('request_id', requestId)
            .order('id', { ascending: true })
            .range(from, to),
        { maximumRows: MAX_INTERACTION_EVIDENCE_ROWS }
    );
    return data.map(row => ({
        candidateUsername: row.candidate_username,
        postId: row.post_id,
        signal: row.signal as InteractionEvidenceRow['signal'],
        sourceInteractionId: row.source_interaction_id,
        ...(row.occurred_at ? { occurredAt: row.occurred_at } : {}),
        ...(typeof row.comment_text === 'string' ? { content: row.comment_text } : {}),
    }));
}

async function collectTargetInteractionKind(input: {
    requestId: string;
    kind: 'target_likers' | 'target_comments';
    posts: InstagramPost[];
    femaleUsernames: string[];
}) {
    const postLimit = input.kind === 'target_likers'
        ? TARGET_LIKER_POST_LIMIT
        : TARGET_COMMENT_POST_LIMIT;
    const posts = selectRecentInteractionPosts(input.posts, postLimit);
    const urls = posts.map(instagramPostUrl);
    const usage: InteractionUsage = { estimatedCostUsd: 0 };
    let likers: ApifyPostLiker[] = [];
    let comments: ApifyPostComment[] = [];
    const limit = input.kind === 'target_likers'
        ? TARGET_LIKER_LIMIT_PER_POST
        : TARGET_COMMENT_LIMIT_PER_POST;

    await persistInteractionJob({
        requestId: input.requestId,
        kind: input.kind,
        batchIndex: 0,
        postCount: posts.length,
        requestedPerPost: limit,
        returnedCount: 0,
        estimatedCostUsd: 0,
        coverage: [],
        status: 'running',
    });

    try {
        if (input.kind === 'target_likers') {
            likers = await apifyInteractionAdapter.getPostLikers(
                urls,
                limit,
                interactionUsageContext(usage)
            );
        } else {
            comments = await apifyInteractionAdapter.getPostComments(
                urls,
                limit,
                interactionUsageContext(usage)
            );
        }
        const extracted = extractTargetInteractions(
            posts,
            likers,
            comments,
            input.femaleUsernames
        );
        const coverage = input.kind === 'target_likers'
            ? extracted.likerCoverage
            : extracted.commentCoverage;
        await persistInteractionEvidence(input.requestId, extracted.evidence);
        await persistInteractionJob({
            requestId: input.requestId,
            kind: input.kind,
            batchIndex: 0,
            postCount: posts.length,
            requestedPerPost: limit,
            returnedCount: input.kind === 'target_likers' ? likers.length : comments.length,
            estimatedCostUsd: usage.estimatedCostUsd,
            coverage,
            status: 'completed',
        });
    } catch (error) {
        await persistInteractionJob({
            requestId: input.requestId,
            kind: input.kind,
            batchIndex: 0,
            postCount: posts.length,
            requestedPerPost: limit,
            returnedCount: 0,
            estimatedCostUsd: usage.estimatedCostUsd,
            coverage: [],
            status: 'failed',
            errorCode: interactionErrorCode(error),
        });
    }
}

async function processTargetInteractions(
    requestId: string,
    targetId: string,
    stepData: StepData,
    targetPosts: InstagramPost[],
    femaleAccounts: ReturnType<typeof femaleInteractionAccounts>,
    enabled: { likers: boolean; comments: boolean }
) {
    const existingJobs = await getInteractionJobs(requestId);
    const terminalKinds = new Set(existingJobs.map(job => job.kind));
    if (!enabled.likers) terminalKinds.add('target_likers');
    if (!enabled.comments) terminalKinds.add('target_comments');
    const femaleUsernames = femaleAccounts.map(account => account.profile.username);
    const tasks: Promise<void>[] = [];
    if (!terminalKinds.has('target_likers')) {
        tasks.push(collectTargetInteractionKind({
            requestId,
            kind: 'target_likers',
            posts: targetPosts,
            femaleUsernames,
        }));
    }
    if (!terminalKinds.has('target_comments')) {
        tasks.push(collectTargetInteractionKind({
            requestId,
            kind: 'target_comments',
            posts: targetPosts,
            femaleUsernames,
        }));
    }
    await Promise.all(tasks);

    const evidence = await getInteractionEvidence(requestId);
    const observedCandidates = new Set(evidence
        .filter(row => row.signal !== 'target_female_like')
        .map(row => row.candidateUsername));
    const interactionCandidateUsernames = rankObservedInteractionCandidates(
        femaleAccounts.map(account => {
            const candidate = getCandidateIntermediateEvidence(targetId, stepData, account);
            return {
                username: candidate.username,
                intermediateScore: candidate.intermediateScore,
            };
        }),
        observedCandidates
    );
    const newStepData: StepData = {
        ...stepData,
        interactionStage: 'candidates',
        interactionCandidateUsernames,
        interactionCandidateBatchIndex: 0,
    };
    await updateStep(
        requestId,
        'interactions',
        newStepData,
        85,
        `대상 계정 상호작용 수집 완료 (${interactionCandidateUsernames.length}명 후속 확인)`
    );
    return NextResponse.json({
        success: true,
        step: 'interactions',
        done: false,
        stats: { interactionCandidates: interactionCandidateUsernames.length },
    });
}

async function processCandidateInteractionBatch(
    requestId: string,
    targetId: string,
    stepData: StepData,
    femaleAccounts: ReturnType<typeof femaleInteractionAccounts>
) {
    const usernames = stepData.interactionCandidateUsernames ?? [];
    const batchIndex = stepData.interactionCandidateBatchIndex ?? 0;
    const totalBatches = Math.ceil(usernames.length / CANDIDATE_INTERACTION_BATCH_SIZE);
    if (batchIndex >= totalBatches) {
        const newStepData = { ...stepData, interactionStage: 'scoring' as const };
        await updateStep(requestId, 'interactions', newStepData, 91, '상호작용 점수 계산 준비 중...');
        return NextResponse.json({ success: true, step: 'interactions', done: false });
    }

    const existingJobs = await getInteractionJobs(requestId, 'candidate_likers');
    if (!existingJobs.some(job => job.batch_index === batchIndex)) {
        const batchUsernames = new Set(usernames.slice(
            batchIndex * CANDIDATE_INTERACTION_BATCH_SIZE,
            (batchIndex + 1) * CANDIDATE_INTERACTION_BATCH_SIZE
        ));
        const accounts: CandidateAccountPosts[] = femaleAccounts
            .filter(account => batchUsernames.has(account.profile.username.toLowerCase()))
            .map(account => ({
                username: account.profile.username,
                posts: selectRecentInteractionPosts(
                    candidatePostsFromStepData(account),
                    CANDIDATE_INTERACTION_POST_LIMIT
                ),
            }));
        const urls = accounts.flatMap(account => account.posts.map(instagramPostUrl));

        if (urls.length > 0) {
            const usage: InteractionUsage = { estimatedCostUsd: 0 };
            await persistInteractionJob({
                requestId,
                kind: 'candidate_likers',
                batchIndex,
                postCount: urls.length,
                requestedPerPost: CANDIDATE_LIKER_LIMIT_PER_POST,
                returnedCount: 0,
                estimatedCostUsd: 0,
                coverage: [],
                status: 'running',
            });
            try {
                const likers = await apifyInteractionAdapter.getPostLikers(
                    urls,
                    CANDIDATE_LIKER_LIMIT_PER_POST,
                    interactionUsageContext(usage)
                );
                const extracted = extractCandidateInteractions(accounts, likers, targetId);
                await persistInteractionEvidence(requestId, extracted.evidence);
                await persistInteractionJob({
                    requestId,
                    kind: 'candidate_likers',
                    batchIndex,
                    postCount: urls.length,
                    requestedPerPost: CANDIDATE_LIKER_LIMIT_PER_POST,
                    returnedCount: likers.length,
                    estimatedCostUsd: usage.estimatedCostUsd,
                    coverage: extracted.coverage,
                    status: 'completed',
                });
            } catch (error) {
                await persistInteractionJob({
                    requestId,
                    kind: 'candidate_likers',
                    batchIndex,
                    postCount: urls.length,
                    requestedPerPost: CANDIDATE_LIKER_LIMIT_PER_POST,
                    returnedCount: 0,
                    estimatedCostUsd: usage.estimatedCostUsd,
                    coverage: [],
                    status: 'failed',
                    errorCode: interactionErrorCode(error),
                });
            }
        }
    }

    const nextBatchIndex = batchIndex + 1;
    const progress = 85 + Math.round((nextBatchIndex / totalBatches) * 6);
    const newStepData: StepData = {
        ...stepData,
        interactionCandidateBatchIndex: nextBatchIndex,
    };
    await updateStep(
        requestId,
        'interactions',
        newStepData,
        progress,
        `후보 계정 상호작용 확인 중... (${nextBatchIndex}/${totalBatches})`
    );
    return NextResponse.json({
        success: true,
        step: 'interactions',
        done: false,
        batchProgress: { current: nextBatchIndex, total: totalBatches },
    });
}

async function processInteractionScores(
    requestId: string,
    targetId: string,
    stepData: StepData,
    targetPosts: InstagramPost[],
    femaleAccounts: ReturnType<typeof femaleInteractionAccounts>
) {
    const [jobs, evidence] = await Promise.all([
        getInteractionJobs(requestId),
        getInteractionEvidence(requestId),
    ]);
    const completedJobs = jobs.filter(job => job.status === 'completed');
    const targetLikeCoverage = completedJobs
        .filter(job => job.kind === 'target_likers')
        .flatMap(job => parseStoredInteractionCoverage(job.coverage));
    const targetCommentCoverage = completedJobs
        .filter(job => job.kind === 'target_comments')
        .flatMap(job => parseStoredInteractionCoverage(job.coverage));
    const candidateLikeCoverage = completedJobs
        .filter(job => job.kind === 'candidate_likers')
        .flatMap(job => parseStoredInteractionCoverage(job.coverage));

    const scoreRows = femaleAccounts.map(account => {
        const intermediate = getCandidateIntermediateEvidence(targetId, stepData, account);
        const score = scoreCandidateInteractions({
            targetPosts,
            candidatePosts: candidatePostsFromStepData(account),
            candidateUsername: account.profile.username,
            evidence,
            targetLikeCoverage,
            targetCommentCoverage,
            candidateLikeCoverage,
        });
        return {
            request_id: requestId,
            candidate_username: account.profile.username.toLowerCase(),
            score: score.score,
            coverage: score.coverage,
            coverage_status: score.coverageStatus,
            female_to_target_likes_count: score.femaleToTargetLikesCount,
            female_to_target_comments_count: score.femaleToTargetCommentsCount,
            target_to_female_likes_count: score.targetToFemaleLikesCount,
            intermediate_score: intermediate.intermediateScore,
            recency_bonus: intermediate.recencyBonus,
            breakdown: score.breakdown,
            updated_at: new Date().toISOString(),
        };
    });
    if (scoreRows.length > 0) {
        const mutation = await supabaseAdmin
            .from('analysis_interaction_scores')
            .upsert(scoreRows, { onConflict: 'request_id,candidate_username' });
        if (mutation.error) {
            throw new Error('ANALYSIS_PERSISTENCE_ERROR: interaction scores upsert failed.');
        }
    }

    const newStepData: StepData = {
        ...stepData,
        interactionStage: 'complete',
        deepAnalysisStage: 'pending',
    };
    await updateStep(requestId, 'deep_analysis', newStepData, 92, '위험 계정 심층 분석 준비 중...');
    return NextResponse.json({
        success: true,
        step: 'deep_analysis',
        done: false,
        stats: { interactionScores: scoreRows.length },
    });
}

// Step 4: 관측된 양방향 좋아요/댓글 수집 + 커버리지 점수화
async function processInteractions(
    requestId: string,
    targetId: string,
    stepData: StepData
) {
    await failInterruptedInteractionJobs(requestId);
    const targetPosts = targetPostsFromStepData(stepData);
    const femaleAccounts = femaleInteractionAccounts(stepData);
    const enabled = {
        likers: stepData.scraperOptions?.likers !== 'disabled',
        comments: stepData.scraperOptions?.comments !== 'disabled',
    };
    if (targetPosts.length === 0 || femaleAccounts.length === 0) {
        return processInteractionScores(requestId, targetId, stepData, targetPosts, femaleAccounts);
    }
    if (!enabled.likers && !enabled.comments) {
        return processInteractionScores(requestId, targetId, stepData, targetPosts, femaleAccounts);
    }

    switch (stepData.interactionStage ?? 'target') {
        case 'target':
            return processTargetInteractions(
                requestId,
                targetId,
                stepData,
                targetPosts,
                femaleAccounts,
                enabled
            );
        case 'candidates':
            if (!enabled.likers) {
                return processInteractionScores(requestId, targetId, stepData, targetPosts, femaleAccounts);
            }
            return processCandidateInteractionBatch(
                requestId,
                targetId,
                stepData,
                femaleAccounts
            );
        case 'scoring':
        case 'complete':
            return processInteractionScores(requestId, targetId, stepData, targetPosts, femaleAccounts);
    }
}

interface PersistedInteractionScore {
    candidate_username: string;
    score: number | string;
    coverage: number | string;
    coverage_status: 'high' | 'medium' | 'low';
    female_to_target_likes_count: number;
    female_to_target_comments_count: number;
    target_to_female_likes_count: number;
    intermediate_score: number | string;
    recency_bonus: number | string;
    deep_analysis: unknown;
}

function boundedNumber(value: unknown, minimum: number, maximum: number): number {
    const number = Number(value);
    if (!Number.isFinite(number)) return minimum;
    return Math.min(maximum, Math.max(minimum, number));
}

function parseDeepAnalysisLines(value: unknown): [string, string] | null {
    return parseSafePublicRiskNarrative(value);
}

function recentMutualOrder(username: string, orderedMutuals: readonly string[]): number | undefined {
    const target = normalizedUsername(username);
    const seen = new Set<string>();
    for (const value of orderedMutuals) {
        const key = normalizedUsername(value);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (key === target) return seen.size;
    }
    return undefined;
}

function boundedOptionalText(value: string | undefined, maximum: number): string | undefined {
    const normalized = value
        ?.replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized ? normalized.slice(0, maximum) : undefined;
}

function fallbackDeepAnalysis(
    score: PersistedInteractionScore,
    commentText?: string
): [string, string] {
    return buildSafeFallbackRiskNarrative({
        candidateLikedTarget: score.female_to_target_likes_count > 0,
        candidateCommentedOnTarget: score.female_to_target_comments_count > 0,
        targetLikedCandidate: score.target_to_female_likes_count > 0,
        commentText,
    });
}

async function getPersistedInteractionScores(
    requestId: string
): Promise<PersistedInteractionScore[]> {
    const { data, error } = await supabaseAdmin
        .from('analysis_interaction_scores')
        .select(`
            candidate_username,
            score,
            coverage,
            coverage_status,
            female_to_target_likes_count,
            female_to_target_comments_count,
            target_to_female_likes_count,
            intermediate_score,
            recency_bonus,
            deep_analysis
        `)
        .eq('request_id', requestId);
    if (error || !Array.isArray(data)) {
        throw new Error('ANALYSIS_PERSISTENCE_ERROR: interaction scores read failed.');
    }
    return data as PersistedInteractionScore[];
}

// Step 5: 최상위 위험 계정의 프로필·피드·상호작용 근거를 병렬 심층 분석
async function processDeepAnalysis(
    requestId: string,
    targetId: string,
    stepData: StepData
) {
    const femaleAccounts = femaleInteractionAccounts(stepData);
    const [scores, evidence] = await Promise.all([
        getPersistedInteractionScores(requestId),
        getInteractionEvidence(requestId),
    ]);
    const scoreByUsername = new Map(
        scores.map(score => [normalizedUsername(score.candidate_username), score])
    );
    const rankedAccounts = femaleAccounts
        .map(account => ({
            account,
            username: normalizedUsername(account.profile.username),
            score: scoreByUsername.get(normalizedUsername(account.profile.username)),
        }))
        .filter((entry): entry is typeof entry & { score: PersistedInteractionScore } =>
            entry.score !== undefined
        )
        .sort((left, right) => {
            const leftTotal = boundedNumber(left.score.intermediate_score, 0, 190)
                + boundedNumber(left.score.score, 0, 100);
            const rightTotal = boundedNumber(right.score.intermediate_score, 0, 190)
                + boundedNumber(right.score.score, 0, 100);
            return rightTotal - leftTotal || left.username.localeCompare(right.username);
        });
    const highRiskAccounts = rankedAccounts.slice(
        0,
        Math.min(getHighRiskCount(rankedAccounts.length), rankedAccounts.length)
    );
    const orderedMutuals = orderedMutualUsernamesFromStepData(stepData);
    const recentRanks = inferRecentMutualFemaleRanks(
        orderedMutuals,
        femaleAccounts.map(account => account.profile.username)
    );

    await updateStep(
        requestId,
        'deep_analysis',
        { ...stepData, deepAnalysisStage: 'pending' },
        94,
        `위험 계정 심층 분석 중... (${highRiskAccounts.length}명)`
    );

    await Promise.all(highRiskAccounts.map(async ({ account, username, score }) => {
        const candidateEvidence = evidence.filter(
            row => normalizedUsername(row.candidateUsername) === username
        );
        const intermediate = getCandidateIntermediateEvidence(targetId, stepData, account);
        const deepInput: DeepRiskNarrativeInput = {
                targetUsername: normalizedUsername(targetId),
                profile: {
                    username,
                    ...(boundedOptionalText(account.profile.fullName, 200)
                        ? { fullName: boundedOptionalText(account.profile.fullName, 200) }
                        : {}),
                    ...(boundedOptionalText(account.profile.bio, 2_000)
                        ? { bio: boundedOptionalText(account.profile.bio, 2_000) }
                        : {}),
                    ...(account.profile.profilePicUrl
                        ? { profilePicUrl: account.profile.profilePicUrl }
                        : {}),
                },
                recentPosts: account.recentPosts.map(post => ({
                    id: post.id.slice(0, 200),
                    shortCode: post.shortCode.slice(0, 100),
                    ...(boundedOptionalText(post.caption, 5_000)
                        ? { caption: boundedOptionalText(post.caption, 5_000) }
                        : {}),
                    ...(post.imageUrl ? { imageUrl: post.imageUrl } : {}),
                    timestamp: post.timestamp,
                })),
                featureEvidence: {
                    intermediateScore: boundedNumber(score.intermediate_score, 0, 190),
                    photogenicGrade: intermediate.photogenicGrade,
                    skinVisibility: intermediate.exposureLevel,
                    ownerIdentified: intermediate.ownerIdentified,
                    isTaggedByTarget: intermediate.isTagged,
                    isMarried: intermediate.isMarried,
                    isForeigner: intermediate.isForeigner,
                },
                recencyEvidence: {
                    mutualOrder: recentMutualOrder(username, orderedMutuals),
                    recentMutualRank: recentRanks.get(username),
                    recencyBonus: boundedNumber(score.recency_bonus, 0, 20),
                },
                interactionEvidence: {
                    interactionScore: boundedNumber(score.score, 0, 100),
                    femaleLikedTarget: score.female_to_target_likes_count > 0,
                    femaleToTargetLikesCount: score.female_to_target_likes_count,
                    femaleCommentedOnTarget: score.female_to_target_comments_count > 0,
                    femaleToTargetCommentsCount: score.female_to_target_comments_count,
                    targetLikedFemale: score.target_to_female_likes_count > 0,
                    targetToFemaleLikesCount: score.target_to_female_likes_count,
                    matchedComments: candidateEvidence
                        .filter(row => row.signal === 'female_target_comment' && row.content)
                        .map(row => ({
                            id: row.sourceInteractionId,
                            postId: row.postId,
                            text: row.content as string,
                            ...(row.occurredAt ? { timestamp: row.occurredAt } : {}),
                        })),
                    coverage: boundedNumber(score.coverage, 0, 1),
                    coverageStatus: score.coverage_status,
                },
                requestId,
            };
        if (parseDeepRiskNarrativeForInput(score.deep_analysis, deepInput)) return;

        const fallback = fallbackDeepAnalysis(
            score,
            deepInput.interactionEvidence.matchedComments[0]?.text
        );
        let lines = fallback;
        try {
            const result = await analyzeDeepRiskNarrative(deepInput);
            lines = parseDeepRiskNarrativeForInput(result.lines, deepInput)?.lines ?? fallback;
        } catch {
            console.error('Deep risk narrative analysis failed for one account', {
                requestId,
                username,
            });
        }

        const mutation = await supabaseAdmin
            .from('analysis_interaction_scores')
            .update({ deep_analysis: lines, updated_at: new Date().toISOString() })
            .eq('request_id', requestId)
            .eq('candidate_username', username)
            .select('id')
            .maybeSingle();
        requireSingleMutationRow(mutation, 'deep risk analysis update');
    }));

    const newStepData: StepData = { ...stepData, deepAnalysisStage: 'complete' };
    await updateStep(requestId, 'finalize', newStepData, 97, '결과 저장 준비 중...');
    return NextResponse.json({
        success: true,
        step: 'finalize',
        done: false,
        stats: { deepRiskAccounts: highRiskAccounts.length },
    });
}

// Step 6: 점수 계산 + 결과 저장
async function processFinalize(
    requestId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    analysisRequest: any,
    stepData: StepData
) {
    const targetId = analysisRequest.target_instagram_id;
    const accountsWithPosts = stepData.accountsWithPosts || [];
    const combinedResults = stepData.combinedResults || {};
    const interactionScoreRows = await getPersistedInteractionScores(requestId);
    const interactionScores = new Map(
        interactionScoreRows.map(row => [normalizedUsername(row.candidate_username), row])
    );

    // 레거시 데이터 지원 (하위 호환성)
    const legacyGenderResults = stepData.genderResults || {};
    const legacyPhotogenicResults = stepData.photogenicResults || {};
    const legacyExposureResults = stepData.exposureResults || {};

    await updateStep(requestId, 'finalize', stepData, 97, '점수 계산 중...');

    const analyzedAccounts: AnalyzedAccount[] = [];

    for (const account of accountsWithPosts) {
        const username = account.profile.username;

        // 통합 결과 또는 레거시 결과 사용
        const combinedResult = combinedResults[username];
        const legacyGender = legacyGenderResults[username];
        const legacyPhotogenic = legacyPhotogenicResults[username];
        const legacyExposure = legacyExposureResults[username];

        // 성별 판단
        const gender = combinedResult?.gender || legacyGender?.gender || 'unknown';
        const genderConfidence = combinedResult?.genderConfidence || legacyGender?.confidence || 0;

        // 여성이 아니면 건너뛰기
        const { include, status: genderStatus } = classifyGenderStatus(gender, genderConfidence);
        if (!include) continue;

        const intermediate = getCandidateIntermediateEvidence(targetId, stepData, account);
        const photogenicGrade = combinedResult?.photogenicGrade
            || legacyPhotogenic?.photogenicGrade
            || intermediate.photogenicGrade;
        const exposureLevel = combinedResult?.skinVisibility
            || legacyExposure?.skinVisibility
            || intermediate.exposureLevel;
        const interaction = interactionScores.get(normalizedUsername(username));
        const interactionScore = boundedNumber(interaction?.score, 0, 100);
        const intermediateScore = interaction
            ? boundedNumber(interaction.intermediate_score, 0, 190)
            : intermediate.intermediateScore;
        const recencyBonus = interaction
            ? boundedNumber(interaction.recency_bonus, 0, 20)
            : intermediate.recencyBonus;
        const totalScore = intermediateScore + interactionScore;

        analyzedAccounts.push({
            username,
            fullName: account.profile.fullName,
            profilePicUrl: account.profile.profilePicUrl,
            bio: account.profile.bio,
            isPrivate: account.profile.isPrivate,
            gender,
            genderConfidence,
            genderStatus,
            photogenicGrade,
            exposureLevel,
            isTagged: intermediate.isTagged,
            totalScore,
            interactionScore,
            interactionCoverage: Number(interaction?.coverage ?? 0),
            interactionCoverageStatus: interaction?.coverage_status ?? 'low',
            femaleToTargetLikesCount: interaction?.female_to_target_likes_count ?? 0,
            femaleToTargetCommentsCount: interaction?.female_to_target_comments_count ?? 0,
            targetToFemaleLikesCount: interaction?.target_to_female_likes_count ?? 0,
            recencyBonus,
            riskAnalysis: parseDeepAnalysisLines(interaction?.deep_analysis) ?? [],
        });
    }

    await updateStep(requestId, 'finalize', stepData, 98, '위험순위 분류 중...');

    // 점수순 정렬
    analyzedAccounts.sort((a, b) =>
        b.totalScore - a.totalScore || a.username.localeCompare(b.username)
    );

    // 위험순위 부여
    const rankedAccounts = analyzedAccounts.map((account, index) => ({
        ...account,
        rank: index + 1,
        riskGrade: classifyRiskGrade(index + 1, analyzedAccounts.length),
    }));

    await updateStep(requestId, 'finalize', stepData, 99, '결과 저장 중...');

    // A multi-row upsert is atomic and remains idempotent if completion persistence is interrupted.
    const resultRows = rankedAccounts.map(result => ({
            request_id: requestId,
            rank: result.rank,
            suspect_instagram_id: result.username,
            suspect_full_name: result.fullName,
            suspect_profile_image: result.profilePicUrl,
            bio: result.bio,
            risk_score: Math.round(result.totalScore),
            interaction_score: result.interactionScore,
            interaction_coverage: result.interactionCoverage,
            interaction_coverage_status: result.interactionCoverageStatus,
            female_to_target_likes_count: result.femaleToTargetLikesCount,
            female_to_target_comments_count: result.femaleToTargetCommentsCount,
            target_to_female_likes_count: result.targetToFemaleLikesCount,
            recency_bonus: result.recencyBonus,
            risk_analysis: result.riskAnalysis ?? [],
            photogenic_grade: result.photogenicGrade,
            exposure_level: result.exposureLevel,
            is_tagged: result.isTagged,
            risk_grade: result.riskGrade,
            gender_confidence: result.genderConfidence,
            gender_status: result.genderStatus,
            is_unlocked: true,
        }));
    if (resultRows.length > 0) {
        const insertedResults = await supabaseAdmin
            .from('analysis_results')
            .upsert(resultRows, { onConflict: 'request_id,suspect_instagram_id' })
            .select('id');
        requireInsertedMutationRows(insertedResults, resultRows.length, 'analysis results insert');
    }

    // 완료 상태 업데이트
    const completionMutation = await supabaseAdmin
        .from('analysis_requests')
        .update({
            status: 'completed',
            current_step: 'completed',
            progress: 100,
            progress_step: '분석 완료!',
            completed_at: new Date().toISOString(),
        })
        .eq('id', requestId)
        .select('id')
        .maybeSingle();
    requireSingleMutationRow(completionMutation, 'analysis completion update');

    // 이메일 알림 발송
    if (analysisRequest.users?.email) {
        try {
            await sendAnalysisCompleteEmail(
                analysisRequest.users.email,
                targetId,
                requestId
            );
        } catch {
            console.error('Email sending failed', { requestId });
        }
    }

    return NextResponse.json({
        success: true,
        step: 'completed',
        done: true,
        stats: {
            totalAnalyzed: rankedAccounts.length,
        },
    });
}
