import { describe, expect, it } from 'vitest';
import {
    AI_STAGE_POLICIES,
    AI_STAGE_POLICY_VERSION,
    AI_SHARED_CONCURRENCY_LIMIT,
    getAiStagePolicy,
} from './stage-policy';

describe('V2 AI stage policy', () => {
    it('uses cheap minimal triage and medium feature analysis', () => {
        expect(getAiStagePolicy('genderTriage')).toMatchObject({
            model: 'gemini-3.1-flash-lite',
            thinkingLevel: 'MINIMAL',
            profileImageLimit: 1,
            feedImageLimit: 4,
        });
        expect(getAiStagePolicy('featureAnalysis')).toMatchObject({
            model: 'gemini-3.1-flash-lite',
            thinkingLevel: 'MEDIUM',
            profileImageLimit: 1,
            feedImageLimit: 10,
        });
    });

    it('reserves high thinking and a concurrency cap of three for narratives', () => {
        expect(getAiStagePolicy('highRiskNarrative')).toMatchObject({
            model: 'gemini-3-flash-preview',
            thinkingLevel: 'HIGH',
            concurrency: 3,
        });
    });

    it('is immutable and explicitly versioned', () => {
        expect(Object.isFrozen(AI_STAGE_POLICIES)).toBe(true);
        expect(Object.isFrozen(AI_STAGE_POLICIES.genderTriage)).toBe(true);
        expect(AI_STAGE_POLICY_VERSION).toBe('ai-stage-policy-v2.1');
        expect(AI_SHARED_CONCURRENCY_LIMIT).toBe(10);
        expect(Math.max(...Object.values(AI_STAGE_POLICIES).map(policy => policy.concurrency)))
            .toBeLessThanOrEqual(AI_SHARED_CONCURRENCY_LIMIT);
    });
});
