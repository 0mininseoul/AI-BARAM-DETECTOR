export const ANALYSIS_PIPELINE_VERSIONS = ['v1', 'v2'] as const;

export type AnalysisPipelineVersion = typeof ANALYSIS_PIPELINE_VERSIONS[number];

export const LEGACY_ANALYSIS_PIPELINE_VERSION = 'v1' as const;
export const CURRENT_ANALYSIS_PIPELINE_VERSION = 'v2' as const;

/**
 * Rows created before the version column existed remain V1. New V2 entry points must persist
 * `v2` explicitly, so an unknown value never falls through to either result mapper.
 */
export function resolvePersistedPipelineVersion(
    value: string | null | undefined
): AnalysisPipelineVersion {
    if (value === null || value === undefined || value === '') {
        return LEGACY_ANALYSIS_PIPELINE_VERSION;
    }
    if (value === LEGACY_ANALYSIS_PIPELINE_VERSION || value === CURRENT_ANALYSIS_PIPELINE_VERSION) {
        return value;
    }
    throw new Error('ANALYSIS_PIPELINE_VERSION_ERROR: unsupported persisted version.');
}

export function usesV2ReadContract(value: string | null | undefined): boolean {
    return resolvePersistedPipelineVersion(value) === CURRENT_ANALYSIS_PIPELINE_VERSION;
}
