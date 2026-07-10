export const DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY = 5;
export const MAX_VERTEX_AI_ANALYSIS_CONCURRENCY = 10;
export const MAX_VERTEX_AI_IMAGE_PREPARATION_CONCURRENCY = 4;
/** Process-wide bounds shared by every analysis request in one server instance. */
export const MAX_VERTEX_AI_CONCURRENT_IMAGE_PREPARATIONS = 8;
export const MAX_VERTEX_AI_CONCURRENT_IMAGE_DECODES = 2;

export function getVertexAIAnalysisConcurrency(
    value: string | undefined = process.env.VERTEX_AI_ANALYSIS_CONCURRENCY
): number {
    if (!value?.trim()) {
        return DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY;
    }

    const parsed = Number(value);
    if (!Number.isFinite(parsed)) {
        return DEFAULT_VERTEX_AI_ANALYSIS_CONCURRENCY;
    }

    return Math.min(
        MAX_VERTEX_AI_ANALYSIS_CONCURRENCY,
        Math.max(1, Math.floor(parsed))
    );
}
