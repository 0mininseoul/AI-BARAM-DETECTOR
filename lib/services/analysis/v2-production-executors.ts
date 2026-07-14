import { createAnalysisV2CollectionExecutorRegistry } from './v2-collection-executors';
import { createProductionAnalysisV2AiScoringExecutorRegistry } from './v2-ai-scoring-production';
import type { AnalysisV2StageExecutorRegistry } from './v2-worker';

let cachedProductionRegistry: AnalysisV2StageExecutorRegistry | null = null;

export function createAnalysisV2ProductionExecutorRegistry(
    env: Record<string, string | undefined> = process.env
): AnalysisV2StageExecutorRegistry {
    return Object.freeze({
        ...createAnalysisV2CollectionExecutorRegistry({ env }),
        ...createProductionAnalysisV2AiScoringExecutorRegistry(env),
    });
}

/** Lazily validates production credentials and reuses one immutable registry per worker process. */
export function getAnalysisV2ProductionExecutorRegistry(): AnalysisV2StageExecutorRegistry {
    cachedProductionRegistry ??= createAnalysisV2ProductionExecutorRegistry();
    return cachedProductionRegistry;
}
