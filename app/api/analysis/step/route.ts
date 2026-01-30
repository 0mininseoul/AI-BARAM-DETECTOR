import { supabaseAdmin } from '@/lib/supabase/admin';
import { NextResponse } from 'next/server';
import {
    getInstagramProfile,
    getFollowers,
    getFollowing,
    extractMutualFollows,
    classifyByPrivacy,
    getProfilesBatch,
} from '@/lib/services/instagram/scraper';
import { analyzeGender } from '@/lib/services/ai/gender-analysis';
import { analyzePhotogenicBatch } from '@/lib/services/ai/photogenic-analysis';
import { analyzeExposureBatch } from '@/lib/services/ai/exposure-analysis';
import {
    getPhotogenicScore,
    getExposureScore,
    classifyGenderStatus,
    classifyRiskGrade,
    TAG_SCORE,
} from '@/lib/constants/scoring';
import { sendAnalysisCompleteEmail } from '@/lib/services/email';
import type { AnalyzedAccount } from '@/lib/types/analysis';
import {
    type AnalysisStep,
    type StepData,
    STEP_PROGRESS,
    getNextStep,
    BATCH_SIZE,
    PROFILE_BATCH_SIZE,
    calculateBatchProgress,
} from '@/lib/services/analysis/steps';

// 단계별 분석 처리 API
export async function POST(request: Request) {
    try {
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

        // 이미 완료되었거나 실패한 경우
        if (analysisRequest.status === 'completed' || analysisRequest.status === 'failed') {
            return NextResponse.json({
                success: true,
                step: analysisRequest.current_step,
                status: analysisRequest.status,
                done: true,
            });
        }

        const currentStep = (analysisRequest.current_step || 'pending') as AnalysisStep;
        const stepData: StepData = analysisRequest.step_data || {};
        const targetId = analysisRequest.target_instagram_id;
        const planType = analysisRequest.plan_type || 'basic';
        const scrapeLimit = planType === 'standard' ? 1000 : 500;

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
                    return await processCollect(requestId, targetId, scrapeLimit, stepData);

                case 'profiles':
                    return await processProfiles(requestId, targetId, stepData);

                case 'gender':
                    return await processGender(requestId, stepData);

                case 'features':
                    return await processFeatures(requestId, targetId, stepData);

                case 'finalize':
                    return await processFinalize(requestId, analysisRequest, stepData);

                default:
                    return NextResponse.json({
                        success: true,
                        step: currentStep,
                        done: true,
                    });
            }
        } catch (pipelineError) {
            const errorMessage = pipelineError instanceof Error ? pipelineError.message : 'Unknown error';
            console.error(`Step ${currentStep} error:`, pipelineError);

            await supabaseAdmin
                .from('analysis_requests')
                .update({
                    status: 'failed',
                    current_step: 'failed',
                    error_message: errorMessage,
                })
                .eq('id', requestId);

            return NextResponse.json({ error: errorMessage, step: currentStep }, { status: 500 });
        }
    } catch (error) {
        console.error('Step API error:', error);
        return NextResponse.json(
            { error: error instanceof Error ? error.message : 'Step failed' },
            { status: 500 }
        );
    }
}

// 상태 업데이트 헬퍼
async function updateStep(
    requestId: string,
    step: AnalysisStep,
    stepData: StepData,
    progress: number,
    progressStep: string
) {
    await supabaseAdmin
        .from('analysis_requests')
        .update({
            status: 'processing',
            current_step: step,
            step_data: stepData,
            progress,
            progress_step: progressStep,
        })
        .eq('id', requestId);
}

// Step 1: 프로필 + 팔로워/팔로잉 수집 + 맞팔 추출
async function processCollect(
    requestId: string,
    targetId: string,
    scrapeLimit: number,
    stepData: StepData
) {
    // 프로필 수집
    await updateStep(requestId, 'collect', stepData, 5, '대상 계정 정보 수집 중...');
    const profile = await getInstagramProfile(targetId);

    if (!profile) {
        throw new Error('계정을 찾을 수 없습니다.');
    }

    if (profile.isPrivate) {
        throw new Error('비공개 계정은 분석할 수 없습니다.');
    }

    // 팔로워/팔로잉 수집
    await updateStep(requestId, 'collect', stepData, 15, '팔로워/팔로잉 목록 수집 중...');
    const [followers, following] = await Promise.all([
        getFollowers(targetId, scrapeLimit),
        getFollowing(targetId, scrapeLimit),
    ]);

    // 맞팔 추출
    await updateStep(requestId, 'collect', stepData, 25, '맞팔 계정 분석 중...');
    const mutualFollows = extractMutualFollows(followers, following);

    // 공개/비공개 분류
    const { publicAccounts, privateAccounts } = classifyByPrivacy(mutualFollows);

    // 비공개 계정 저장
    if (privateAccounts.length > 0) {
        await supabaseAdmin.from('private_accounts').insert(
            privateAccounts.map((account) => ({
                request_id: requestId,
                instagram_id: account.username,
                profile_image: account.profilePicUrl,
            }))
        );
    }

    // 통계 업데이트
    await supabaseAdmin
        .from('analysis_requests')
        .update({
            total_followers: followers.length,
            mutual_follows: mutualFollows.length,
        })
        .eq('id', requestId);

    // step_data 업데이트
    const newStepData: StepData = {
        ...stepData,
        mutualFollows: mutualFollows.map((m) => m.username),
        publicAccounts: publicAccounts.slice(0, 350).map((a) => ({
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
    stepData: StepData
) {
    const publicAccounts = stepData.publicAccounts || [];
    const batchIndex = stepData.profileBatchIndex || 0;
    const accountsWithPosts = stepData.accountsWithPosts || [];

    if (publicAccounts.length === 0) {
        // 공개 계정이 없으면 바로 완료
        await updateStep(requestId, 'finalize', stepData, 90, '결과 저장 중...');
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
            genderBatchIndex: 0,
            genderResults: {},
        };

        await updateStep(requestId, 'gender', newStepData, 50, '성별 분석 준비 중...');

        return NextResponse.json({
            success: true,
            step: 'gender',
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

    // 프로필 배치 수집 (latestPosts 포함)
    const profiles = await getProfilesBatch(batch.map((a) => a.username));

    // 프로필과 게시물 매핑 (latestPosts 사용 - 별도 API 호출 불필요)
    const batchAccountsWithPosts = profiles.map((profile) => {
        const posts = profile.latestPosts || [];
        return {
            profile: {
                username: profile.username,
                profilePicUrl: profile.profilePicUrl,
                fullName: profile.fullName,
                bio: profile.bio,
                isPrivate: profile.isPrivate,
            },
            recentPosts: posts.map((p) => ({
                imageUrl: p.imageUrl,
                taggedUsers: p.taggedUsers,
                mentionedUsers: p.mentionedUsers,
            })),
        };
    });

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

// Step 3: 성별 분석 (배치 처리)
async function processGender(requestId: string, stepData: StepData) {
    const accountsWithPosts = stepData.accountsWithPosts || [];
    const batchIndex = stepData.genderBatchIndex || 0;
    const genderResults = stepData.genderResults || {};

    const totalBatches = Math.ceil(accountsWithPosts.length / BATCH_SIZE);

    if (batchIndex >= totalBatches) {
        // 모든 배치 완료 - 여성 계정 필터링
        const genderStats = { male: 0, female: 0, unknown: 0 };
        const femaleAccounts: StepData['femaleAccounts'] = [];

        for (const account of accountsWithPosts) {
            const result = genderResults[account.profile.username];
            if (!result) continue;

            if (result.gender === 'male') genderStats.male++;
            else if (result.gender === 'female') genderStats.female++;
            else genderStats.unknown++;

            const { include } = classifyGenderStatus(result.gender, result.confidence);
            if (include) {
                femaleAccounts.push(account);
            }
        }

        await supabaseAdmin
            .from('analysis_requests')
            .update({
                opposite_gender_count: femaleAccounts.length,
                gender_stats: genderStats,
            })
            .eq('id', requestId);

        const newStepData: StepData = {
            ...stepData,
            femaleAccounts,
            featureBatchIndex: 0,
            photogenicResults: {},
            exposureResults: {},
        };

        await updateStep(requestId, 'features', newStepData, 70, '외모 분석 준비 중...');

        return NextResponse.json({
            success: true,
            step: 'features',
            done: false,
            stats: {
                genderStats,
                femaleCount: femaleAccounts.length,
            },
        });
    }

    // 현재 배치 처리
    const startIdx = batchIndex * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, accountsWithPosts.length);
    const batch = accountsWithPosts.slice(startIdx, endIdx);

    const progress = calculateBatchProgress('gender', batchIndex, totalBatches);
    await updateStep(
        requestId,
        'gender',
        stepData,
        progress,
        `성별 분석 중... (${batchIndex + 1}/${totalBatches})`
    );

    // 배치 성별 분석 (5개씩 병렬 처리)
    const subBatchSize = 5;
    for (let i = 0; i < batch.length; i += subBatchSize) {
        const subBatch = batch.slice(i, i + subBatchSize);
        const results = await Promise.all(
            subBatch.map(async (account) => {
                try {
                    const result = await analyzeGender({
                        profile: account.profile as Parameters<typeof analyzeGender>[0]['profile'],
                        recentPosts: account.recentPosts as Parameters<typeof analyzeGender>[0]['recentPosts'],
                    });
                    return { username: account.profile.username, result };
                } catch (error) {
                    console.error(`Gender analysis failed for ${account.profile.username}:`, error);
                    return {
                        username: account.profile.username,
                        result: { gender: 'unknown' as const, confidence: 0, reasoning: 'Analysis failed' },
                    };
                }
            })
        );

        for (const { username, result } of results) {
            genderResults[username] = result;
        }
    }

    const newStepData: StepData = {
        ...stepData,
        genderResults,
        genderBatchIndex: batchIndex + 1,
    };

    await updateStep(
        requestId,
        'gender',
        newStepData,
        calculateBatchProgress('gender', batchIndex + 1, totalBatches),
        `성별 분석 중... (${batchIndex + 1}/${totalBatches})`
    );

    return NextResponse.json({
        success: true,
        step: 'gender',
        done: false,
        batchProgress: {
            current: batchIndex + 1,
            total: totalBatches,
        },
    });
}

// Step 4: Photogenic/노출 분석 (배치 처리)
async function processFeatures(requestId: string, targetId: string, stepData: StepData) {
    const femaleAccounts = stepData.femaleAccounts || [];
    const batchIndex = stepData.featureBatchIndex || 0;
    const photogenicResults = stepData.photogenicResults || {};
    const exposureResults = stepData.exposureResults || {};

    const totalBatches = Math.ceil(femaleAccounts.length / BATCH_SIZE);

    if (batchIndex >= totalBatches || femaleAccounts.length === 0) {
        // 모든 배치 완료 - finalize 단계로
        const newStepData: StepData = {
            ...stepData,
            photogenicResults,
            exposureResults,
        };

        await updateStep(requestId, 'finalize', newStepData, 90, '결과 저장 준비 중...');

        return NextResponse.json({
            success: true,
            step: 'finalize',
            done: false,
        });
    }

    // 현재 배치 처리
    const startIdx = batchIndex * BATCH_SIZE;
    const endIdx = Math.min(startIdx + BATCH_SIZE, femaleAccounts.length);
    const batch = femaleAccounts.slice(startIdx, endIdx);

    const progress = calculateBatchProgress('features', batchIndex, totalBatches);
    await updateStep(
        requestId,
        'features',
        stepData,
        progress,
        `외모/노출 분석 중... (${batchIndex + 1}/${totalBatches})`
    );

    // Photogenic 분석
    const photogenicInputs = batch.map((a) => ({
        username: a.profile.username,
        profilePicUrl: a.profile.profilePicUrl,
        postImageUrls: a.recentPosts.map((p) => p.imageUrl).filter(Boolean) as string[],
    }));
    const photogenicBatchResults = await analyzePhotogenicBatch(photogenicInputs);

    for (const [username, result] of photogenicBatchResults) {
        photogenicResults[username] = {
            photogenicGrade: result.photogenicGrade,
            confidence: result.confidence,
        };
    }

    // 노출 분석
    const exposureBatchResults = await analyzeExposureBatch(photogenicInputs);

    for (const [username, result] of exposureBatchResults) {
        exposureResults[username] = {
            skinVisibility: result.skinVisibility,
            confidence: result.confidence,
        };
    }

    const newStepData: StepData = {
        ...stepData,
        photogenicResults,
        exposureResults,
        featureBatchIndex: batchIndex + 1,
    };

    await updateStep(
        requestId,
        'features',
        newStepData,
        calculateBatchProgress('features', batchIndex + 1, totalBatches),
        `외모/노출 분석 중... (${batchIndex + 1}/${totalBatches})`
    );

    return NextResponse.json({
        success: true,
        step: 'features',
        done: false,
        batchProgress: {
            current: batchIndex + 1,
            total: totalBatches,
        },
    });
}

// Step 5: 점수 계산 + 결과 저장
async function processFinalize(
    requestId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    analysisRequest: any,
    stepData: StepData
) {
    const targetId = analysisRequest.target_instagram_id;
    const femaleAccounts = stepData.femaleAccounts || [];
    const genderResults = stepData.genderResults || {};
    const photogenicResults = stepData.photogenicResults || {};
    const exposureResults = stepData.exposureResults || {};

    await updateStep(requestId, 'finalize', stepData, 92, '점수 계산 중...');

    const analyzedAccounts: AnalyzedAccount[] = [];

    for (const account of femaleAccounts) {
        const username = account.profile.username;
        const genderResult = genderResults[username];
        const photogenicResult = photogenicResults[username];
        const exposureResult = exposureResults[username];

        // 태그 확인
        let isTagged = false;
        for (const post of account.recentPosts) {
            if (post.taggedUsers?.includes(targetId) || post.mentionedUsers?.includes(targetId)) {
                isTagged = true;
                break;
            }
        }

        // 점수 계산
        const photogenicGrade = photogenicResult?.photogenicGrade || 1;
        const exposureLevel = exposureResult?.skinVisibility || 'low';

        const photogenicScore = getPhotogenicScore(photogenicGrade);
        const exposureScore = getExposureScore(exposureLevel);
        const tagScore = isTagged ? TAG_SCORE : 0;
        const totalScore = photogenicScore + exposureScore + tagScore;

        const { status: genderStatus } = classifyGenderStatus(
            genderResult?.gender || 'unknown',
            genderResult?.confidence || 0
        );

        analyzedAccounts.push({
            username,
            profilePicUrl: account.profile.profilePicUrl,
            bio: account.profile.bio,
            isPrivate: account.profile.isPrivate,
            gender: genderResult?.gender || 'unknown',
            genderConfidence: genderResult?.confidence || 0,
            genderStatus,
            photogenicGrade,
            exposureLevel,
            isTagged,
            totalScore,
        });
    }

    await updateStep(requestId, 'finalize', stepData, 95, '위험순위 분류 중...');

    // 점수순 정렬
    analyzedAccounts.sort((a, b) => b.totalScore - a.totalScore);

    // 위험순위 부여
    const rankedAccounts = analyzedAccounts.map((account, index) => ({
        ...account,
        rank: index + 1,
        riskGrade: classifyRiskGrade(index + 1, analyzedAccounts.length),
    }));

    await updateStep(requestId, 'finalize', stepData, 97, '결과 저장 중...');

    // 결과 저장
    for (const result of rankedAccounts) {
        await supabaseAdmin.from('analysis_results').insert({
            request_id: requestId,
            rank: result.rank,
            suspect_instagram_id: result.username,
            suspect_profile_image: result.profilePicUrl,
            bio: result.bio,
            risk_score: result.totalScore,
            photogenic_grade: result.photogenicGrade,
            exposure_level: result.exposureLevel,
            is_tagged: result.isTagged,
            risk_grade: result.riskGrade,
            gender_confidence: result.genderConfidence,
            gender_status: result.genderStatus,
            is_unlocked: true,
        });
    }

    // 완료 상태 업데이트
    await supabaseAdmin
        .from('analysis_requests')
        .update({
            status: 'completed',
            current_step: 'completed',
            progress: 100,
            progress_step: '분석 완료!',
            completed_at: new Date().toISOString(),
        })
        .eq('id', requestId);

    // 이메일 알림 발송
    if (analysisRequest.users?.email) {
        try {
            await sendAnalysisCompleteEmail(
                analysisRequest.users.email,
                targetId,
                requestId
            );
        } catch (emailError) {
            console.error('Email sending failed:', emailError);
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
