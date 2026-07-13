import { describe, expect, it } from 'vitest';
import {
    calculateV2FinalScores,
    calculateV2PreliminaryScores,
    hasCandidateTargetMention,
    type V2FemaleCandidateEvidence,
} from './v2-candidate-scoring';

function candidate(index: number, overrides: Partial<V2FemaleCandidateEvidence> = {}):
V2FemaleCandidateEvidence {
    return {
        candidateId: `candidate:${String(index).padStart(2, '0')}`,
        username: `woman.${index}`,
        appearanceGrade: 3,
        exposureScore: 1,
        isBusinessAccount: false,
        hasStrongPartnerEvidence: false,
        uniqueTargetPostsLikedByCandidate: 0,
        boundedCandidateCommentsOnTarget: 0,
        hasTagOrCaptionMention: false,
        ...overrides,
    };
}

describe('V2 candidate scoring orchestration', () => {
    it('ranks recent mutuals only after the verified female filter', () => {
        const preliminary = calculateV2PreliminaryScores({
            candidates: [candidate(1), candidate(2)],
            orderedMutualUsernames: ['male.1', 'woman.2', 'male.2', 'woman.1'],
            excludedUsername: null,
        });

        expect(preliminary.find(row => row.username === 'woman.2')).toMatchObject({
            recentFemaleMutualRank: 1,
            recentMutualBadgeRank: 1,
        });
        expect(preliminary.find(row => row.username === 'woman.1')).toMatchObject({
            recentFemaleMutualRank: 2,
            recentMutualBadgeRank: 2,
        });
    });

    it('freezes Top 10 before reverse likes and never collects outside it', () => {
        const candidates = Array.from({ length: 11 }, (_, index) => candidate(index + 1, {
            boundedCandidateCommentsOnTarget: index < 10 ? 10 - index : 0,
        }));
        const preliminary = calculateV2PreliminaryScores({
            candidates,
            orderedMutualUsernames: candidates.map(row => row.username),
            excludedUsername: null,
        });
        const excluded = preliminary.find(row => row.verificationShortlistRank === null);
        expect(excluded).toBeDefined();

        expect(() => calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set([excluded!.candidateId]),
        })).toThrow('outside the frozen shortlist');

        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set([
                preliminary.find(row => row.verificationShortlistRank === 10)!.candidateId,
            ]),
        });
        expect(final.filter(row => row.reverseLikeStatus !== 'not_collected')).toHaveLength(10);
        expect(final.find(row => row.candidateId === excluded!.candidateId)?.reverseLikeStatus)
            .toBe('not_collected');
    });

    it('keeps absolute bands and adds a separate relative watch for larger weak sets', () => {
        const candidates = Array.from({ length: 20 }, (_, index) => candidate(index + 1, {
            appearanceGrade: 1,
            exposureScore: 0,
        }));
        const preliminary = calculateV2PreliminaryScores({
            candidates,
            orderedMutualUsernames: [],
            excludedUsername: null,
        });
        const final = calculateV2FinalScores({
            preliminary,
            observedReverseLikeCandidateIds: new Set(),
        });

        expect(final.every(row => row.risk.riskBand === 'normal')).toBe(true);
        expect(final.filter(row => row.relativeWatchRank !== null)).toHaveLength(2);
    });

    it('detects either-direction target/candidate tags and caption mentions', () => {
        expect(hasCandidateTargetMention({
            targetUsername: 'target',
            candidateUsername: 'candidate',
            targetPosts: [{ taggedUsers: [], mentionedUsers: ['Candidate'] }],
            candidatePosts: [{ taggedUsers: [], mentionedUsers: [] }],
        })).toBe(true);
        expect(hasCandidateTargetMention({
            targetUsername: 'target',
            candidateUsername: 'candidate',
            targetPosts: [{ taggedUsers: [], mentionedUsers: [] }],
            candidatePosts: [{ taggedUsers: ['TARGET'], mentionedUsers: [] }],
        })).toBe(true);
    });
});
