import { z } from 'zod';
import type {
    ApifyPostComment,
    ApifyPostLiker,
} from '@/lib/services/instagram/providers/apify-interactions';
import type { InstagramPost } from '@/lib/types/instagram';
import {
    TARGET_COMMENT_LIMIT_PER_POST,
    TARGET_COMMENT_POST_LIMIT,
    TARGET_LIKER_LIMIT_PER_POST,
    TARGET_LIKER_POST_LIMIT,
    type InteractionEvidenceRow,
    type StoredInteractionCoverage,
} from './interaction-stage';
import { instagramPostUrl, selectRecentInteractionPosts } from './interaction-posts';

const usernameSchema = z.string()
    .trim()
    .transform(value => value.replace(/^@/, '').toLowerCase())
    .pipe(z.string().regex(/^[a-z0-9._]{1,30}$/));
const MAX_STORED_COMMENT_LENGTH = 1_000;

export type RawTargetInteractionSignal = 'target_post_like' | 'target_post_comment';

export interface RawTargetInteractionEvidence {
    actorUsername: string;
    postId: string;
    signal: RawTargetInteractionSignal;
    sourceInteractionId: string;
    occurredAt?: string;
    content?: string;
}

export interface RawTargetInteractionSnapshot {
    evidence: readonly RawTargetInteractionEvidence[];
    observedUsernames: readonly string[];
    likerCoverage: readonly StoredInteractionCoverage[];
    commentCoverage: readonly StoredInteractionCoverage[];
}

export interface CandidateTargetInteractionSummary {
    candidateUsername: string;
    uniqueTargetPostsLikedByCandidate: number;
    boundedCandidateCommentsOnTarget: number;
    likedPostIds: readonly string[];
    countedCommentInteractionIds: readonly string[];
}

function normalizeUsername(value: string): string {
    return usernameSchema.parse(value);
}

function normalizeExcludedUsernames(values: Iterable<string>): Set<string> {
    const result = new Set<string>();
    for (const value of values) result.add(normalizeUsername(value));
    return result;
}

function sanitizedComment(value: string): string | undefined {
    const normalized = value
        .normalize('NFKC')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    return normalized ? [...normalized].slice(0, MAX_STORED_COMMENT_LENGTH).join('') : undefined;
}

function uniqueBySourceId<T extends { sourceInteractionId: string }>(rows: T[]): T[] {
    const seen = new Set<string>();
    return rows.filter((row) => {
        if (seen.has(row.sourceInteractionId)) return false;
        seen.add(row.sourceInteractionId);
        return true;
    });
}

function countReturnedByUrl<T extends { postUrl: string }>(rows: readonly T[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.postUrl, (counts.get(row.postUrl) ?? 0) + 1);
    return counts;
}

function coverageForPosts(
    posts: readonly InstagramPost[],
    returnedByUrl: ReadonlyMap<string, number>,
    declaredByUrl: ReadonlyMap<string, number>,
    requestedLimit: number,
    declaredFromPost: (post: InstagramPost) => number
): StoredInteractionCoverage[] {
    return posts.map(post => {
        const url = instagramPostUrl(post);
        return {
            postId: post.id,
            declaredCount: Math.max(0, declaredFromPost(post), declaredByUrl.get(url) ?? 0),
            returnedCount: returnedByUrl.get(url) ?? 0,
            requestedLimit,
        };
    });
}

/**
 * Stores a bounded target-interaction snapshot before candidate gender is known. This lets the
 * relationship/profile track and target-evidence track run concurrently without discarding rows
 * that may later be verified as female mutuals.
 */
export function extractRawTargetInteractions(input: {
    targetPosts: readonly InstagramPost[];
    likers: readonly ApifyPostLiker[];
    comments: readonly ApifyPostComment[];
    excludedUsernames: Iterable<string>;
}): RawTargetInteractionSnapshot {
    const excluded = normalizeExcludedUsernames(input.excludedUsernames);
    const likerPosts = selectRecentInteractionPosts(
        [...input.targetPosts],
        TARGET_LIKER_POST_LIMIT
    );
    const commentPosts = selectRecentInteractionPosts(
        [...input.targetPosts],
        TARGET_COMMENT_POST_LIMIT
    );
    const likerPostByUrl = new Map(likerPosts.map(post => [instagramPostUrl(post), post]));
    const commentPostByUrl = new Map(commentPosts.map(post => [instagramPostUrl(post), post]));

    const likeRows = input.likers.flatMap((liker): RawTargetInteractionEvidence[] => {
        const post = likerPostByUrl.get(liker.postUrl);
        const actorUsername = normalizeUsername(liker.username);
        if (!post || excluded.has(actorUsername)) return [];
        return [{
            actorUsername,
            postId: post.id,
            signal: 'target_post_like',
            sourceInteractionId: liker.id,
        }];
    });
    const commentRows = input.comments.flatMap((comment): RawTargetInteractionEvidence[] => {
        const post = commentPostByUrl.get(comment.postUrl);
        const actorUsername = normalizeUsername(comment.ownerUsername);
        if (!post || excluded.has(actorUsername)) return [];
        const content = sanitizedComment(comment.text);
        return [{
            actorUsername,
            postId: post.id,
            signal: 'target_post_comment',
            sourceInteractionId: comment.id,
            occurredAt: comment.timestamp,
            ...(content ? { content } : {}),
        }];
    });
    const evidence = uniqueBySourceId([...likeRows, ...commentRows]);
    const observedUsernames = [...new Set(evidence.map(row => row.actorUsername))];
    const likerDeclaredByUrl = new Map<string, number>();
    for (const liker of input.likers) {
        likerDeclaredByUrl.set(
            liker.postUrl,
            Math.max(likerDeclaredByUrl.get(liker.postUrl) ?? 0, liker.totalLikes)
        );
    }

    return Object.freeze({
        evidence: Object.freeze(evidence),
        observedUsernames: Object.freeze(observedUsernames),
        likerCoverage: Object.freeze(coverageForPosts(
            likerPosts,
            countReturnedByUrl(input.likers),
            likerDeclaredByUrl,
            TARGET_LIKER_LIMIT_PER_POST,
            post => post.likesCountHidden === true
                ? TARGET_LIKER_LIMIT_PER_POST + 1
                : post.likesCount
        )),
        commentCoverage: Object.freeze(coverageForPosts(
            commentPosts,
            countReturnedByUrl(input.comments),
            new Map(),
            TARGET_COMMENT_LIMIT_PER_POST,
            post => post.commentsCountHidden === true
                ? TARGET_COMMENT_LIMIT_PER_POST + 1
                : post.commentsCount
        )),
    });
}

/** Join only after the profile AI track has produced the verified female mutual set. */
export function joinVerifiedFemaleTargetInteractions(input: {
    evidence: readonly RawTargetInteractionEvidence[];
    verifiedFemaleUsernames: Iterable<string>;
    excludedUsername: string | null;
}): InteractionEvidenceRow[] {
    const verified = new Set<string>();
    for (const username of input.verifiedFemaleUsernames) {
        verified.add(normalizeUsername(username));
    }
    const excluded = input.excludedUsername === null
        ? null
        : normalizeUsername(input.excludedUsername);

    return input.evidence.flatMap((row): InteractionEvidenceRow[] => {
        const candidateUsername = normalizeUsername(row.actorUsername);
        if (candidateUsername === excluded || !verified.has(candidateUsername)) return [];
        return [{
            candidateUsername,
            postId: row.postId,
            signal: row.signal === 'target_post_like'
                ? 'female_target_like'
                : 'female_target_comment',
            sourceInteractionId: row.sourceInteractionId,
            ...(row.occurredAt ? { occurredAt: row.occurredAt } : {}),
            ...(row.content ? { content: row.content } : {}),
        }];
    });
}

/**
 * Converts retained evidence into the V2 scoring inputs. Comments remain available as evidence,
 * but only two unique comments per target post can contribute to the 12-opportunity score.
 */
export function summarizeCandidateTargetInteractions(
    rows: readonly InteractionEvidenceRow[]
): CandidateTargetInteractionSummary[] {
    const byCandidate = new Map<string, {
        likedPostIds: Set<string>;
        commentIdsByPost: Map<string, Set<string>>;
    }>();
    for (const row of rows) {
        const candidateUsername = normalizeUsername(row.candidateUsername);
        const state = byCandidate.get(candidateUsername) ?? {
            likedPostIds: new Set<string>(),
            commentIdsByPost: new Map<string, Set<string>>(),
        };
        byCandidate.set(candidateUsername, state);
        if (row.signal === 'female_target_like') {
            state.likedPostIds.add(row.postId);
            continue;
        }
        if (row.signal !== 'female_target_comment') continue;
        const comments = state.commentIdsByPost.get(row.postId) ?? new Set<string>();
        if (comments.size < 2) comments.add(row.sourceInteractionId);
        state.commentIdsByPost.set(row.postId, comments);
    }

    return [...byCandidate.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([candidateUsername, state]) => {
            const likedPostIds = [...state.likedPostIds].sort();
            const countedCommentInteractionIds = [...state.commentIdsByPost.entries()]
                .sort(([left], [right]) => left.localeCompare(right))
                .flatMap(([, ids]) => [...ids].sort());
            return Object.freeze({
                candidateUsername,
                uniqueTargetPostsLikedByCandidate: likedPostIds.length,
                boundedCandidateCommentsOnTarget: Math.min(
                    countedCommentInteractionIds.length,
                    TARGET_COMMENT_POST_LIMIT * 2
                ),
                likedPostIds: Object.freeze(likedPostIds),
                countedCommentInteractionIds: Object.freeze(
                    countedCommentInteractionIds.slice(0, TARGET_COMMENT_POST_LIMIT * 2)
                ),
            });
        });
}
