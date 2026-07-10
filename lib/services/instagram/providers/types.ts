import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';

export type Capability = 'profile' | 'profilesBatch' | 'followers' | 'following';

export type ProviderName = 'apify' | 'coderx' | 'flashapi' | 'rapidapi' | 'selfhosted';
export type InteractionProviderName = 'apify' | 'disabled';

export type ScraperTelemetryStatus = 'success' | 'error';
export type ScraperFailureCategory =
    | 'configuration'
    | 'schema'
    | 'incomplete'
    | 'budget'
    | 'timeout'
    | 'provider';

export interface ScraperTelemetryEvent {
    requestId?: string;
    provider: ProviderName;
    capability: Capability;
    request_count: number;
    result_count: number;
    raw_result_count: number;
    unique_result_count: number;
    unique_ratio: number;
    fallback: boolean;
    latency_ms: number;
    status: ScraperTelemetryStatus;
    expected_result_count?: number;
    minimum_complete_count?: number;
    coverage_ratio?: number;
    failure_category?: ScraperFailureCategory;
    estimated_cost_usd: number;
    rate_limit_limit?: number;
    rate_limit_remaining?: number;
}

export type ScraperTelemetryHook = (
    event: ScraperTelemetryEvent
) => void | Promise<void>;

/** Optional trailing arguments accepted by every public scraper operation. */
export interface ScrapeRequestOptions {
    provider?: ProviderName;
    fallback?: boolean;
    expectedResultCount?: number;
    requestId?: string;
    onTelemetry?: ScraperTelemetryHook;
}

/** Serializable subset stored with an analysis request. */
export interface ScraperProviderSelection {
    profile?: ProviderName;
    profilesBatch?: ProviderName;
    followers?: ProviderName;
    following?: ProviderName;
    likers?: InteractionProviderName;
    comments?: InteractionProviderName;
    fallback?: boolean;
}

export interface ProviderUsageDelta {
    request_count?: number;
    result_count?: number;
    raw_result_count?: number;
    unique_result_count?: number;
    estimated_cost_usd?: number;
    rate_limit_limit?: number;
    rate_limit_remaining?: number;
}

export interface ProviderCallContext {
    requestId?: string;
    recordUsage(delta: ProviderUsageDelta): void;
}

/**
 * 스크래핑 프로바이더. 각 프로바이더는 지원하는 기능만 구현한다.
 * (예: rapidapi는 getFollowing만, selfhosted는 getProfile/getProfilesBatch만)
 */
export interface ScraperProvider {
    readonly name: ProviderName;
    readonly paid?: boolean;
    getProfile?(username: string, context?: ProviderCallContext): Promise<InstagramProfile | null>;
    getFollowers?(
        username: string,
        limit: number,
        context?: ProviderCallContext
    ): Promise<InstagramFollower[]>;
    getFollowing?(
        username: string,
        limit: number,
        context?: ProviderCallContext
    ): Promise<InstagramFollower[]>;
    getProfilesBatch?(
        usernames: string[],
        batchSize?: number,
        context?: ProviderCallContext
    ): Promise<InstagramProfile[]>;
}
