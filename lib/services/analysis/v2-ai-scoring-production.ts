import { makeApifyInteractionAdapter } from '@/lib/services/instagram/providers/apify-interactions';
import {
    selectAnalysisV2ApifyCredentialSlot,
    selectApifyApiToken,
} from '@/lib/services/instagram/providers/apify-relationship';
import { createDurableAnalysisV2AiStageRuntime } from './v2-ai-stage-runtime';
import {
    createAnalysisV2AiScoringExecutorRegistry,
    type AnalysisV2AiScoringExecutorDependencies,
} from './v2-ai-scoring-executors';
import {
    createAnalysisV2MediaNormalizer,
    createAnalysisV2ProfileBatchReadModel,
    createAnalysisV2RelationshipEvidenceReadModel,
    createAnalysisV2ReverseLikeCollector,
    createAnalysisV2TargetProfileReadModel,
} from './v2-ai-scoring-runtime-deps';
import { analysisV2AiScoringStageStore } from './v2-ai-scoring-stage-store';
import { createConfiguredAnalysisV2MediaArtifactStore } from './v2-media-artifact-store';
import { analysisV2ResultStore } from './v2-result-store';

export type AnalysisV2ProductionEnvironment = Record<string, string | undefined>;

/**
 * Builds production AI/scoring executors only when the worker asks for them. This keeps module
 * import side-effect free while making a missing private bucket or selected Apify token fail fast.
 */
export function createProductionAnalysisV2AiScoringExecutorRegistry(
    env: AnalysisV2ProductionEnvironment = process.env
) {
    const credentialSlot = selectAnalysisV2ApifyCredentialSlot(env);
    selectApifyApiToken(env, credentialSlot);
    const mediaStore = createConfiguredAnalysisV2MediaArtifactStore(env);
    const dependencies: AnalysisV2AiScoringExecutorDependencies = {
        profileBatches: createAnalysisV2ProfileBatchReadModel(),
        evidence: createAnalysisV2RelationshipEvidenceReadModel(),
        targetProfiles: createAnalysisV2TargetProfileReadModel(),
        stageStore: analysisV2AiScoringStageStore,
        resultStore: analysisV2ResultStore,
        mediaStore,
        ai: createDurableAnalysisV2AiStageRuntime(),
        reverseLikes: createAnalysisV2ReverseLikeCollector({
            adapter: makeApifyInteractionAdapter({ env }),
            env,
        }),
        normalizeMedia: createAnalysisV2MediaNormalizer(),
    };
    return createAnalysisV2AiScoringExecutorRegistry(dependencies);
}
