import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';
import type { Capability, ProviderName, ScraperProvider } from './providers/types';
import { getScraperConfig, EXTERNAL_DEFAULT, type ScraperConfig } from './config';
import { apifyProvider } from './providers/apify';
import { rapidApiProvider } from './providers/rapidapi';
import { selfHostedProvider } from './providers/selfhosted';

// ── 프로바이더 레지스트리 (테스트에서 주입 가능) ──
let providers: Record<ProviderName, ScraperProvider> = {
    apify: apifyProvider,
    rapidapi: rapidApiProvider,
    selfhosted: selfHostedProvider,
};
let configOverride: Record<string, string | undefined> | null = null;

function config(): ScraperConfig {
    return getScraperConfig(configOverride ?? process.env);
}

/** 지정한 프로바이더의 메서드를 실행하고, 필요 시 외부 기본 프로바이더로 폴백한다. */
async function route<T>(
    capability: Capability,
    selected: ProviderName,
    call: (p: ScraperProvider) => Promise<T> | undefined,
    fallbackEnabled: boolean
): Promise<T> {
    const primary = providers[selected];
    const primaryCall = primary && call(primary);
    if (primaryCall === undefined) {
        throw new Error(`SCRAPING_ERROR: 프로바이더 '${selected}'가 '${capability}'를 지원하지 않습니다.`);
    }
    try {
        return await primaryCall;
    } catch (error) {
        const external = EXTERNAL_DEFAULT[capability];
        if (fallbackEnabled && selected === 'selfhosted' && external !== 'selfhosted') {
            const fb = providers[external];
            const fbCall = fb && call(fb);
            if (fbCall !== undefined) {
                console.warn(`[scraper] selfhosted ${capability} 실패 → ${external}로 폴백:`, error);
                return await fbCall;
            }
        }
        throw error;
    }
}

export async function getInstagramProfile(username: string): Promise<InstagramProfile | null> {
    const c = config();
    return route('profile', c.profile, (p) => p.getProfile?.(username), c.fallback);
}

export async function getFollowers(username: string, limit: number = 500): Promise<InstagramFollower[]> {
    const c = config();
    return route('followers', c.followers, (p) => p.getFollowers?.(username, limit), c.fallback);
}

export async function getFollowing(username: string, limit: number = 500): Promise<InstagramFollower[]> {
    const c = config();
    return route('following', c.following, (p) => p.getFollowing?.(username, limit), c.fallback);
}

export async function getProfilesBatch(usernames: string[], batchSize?: number): Promise<InstagramProfile[]> {
    const c = config();
    return route('profilesBatch', c.profilesBatch, (p) => p.getProfilesBatch?.(usernames, batchSize), c.fallback);
}

// ── 프로바이더 무관 순수 헬퍼 ──
export function extractMutualFollows(
    followers: InstagramFollower[],
    following: InstagramFollower[]
): InstagramFollower[] {
    const followerSet = new Set(followers.map((f) => f.username));
    return following.filter((f) => followerSet.has(f.username));
}

export function classifyByPrivacy(accounts: InstagramFollower[]): {
    publicAccounts: InstagramFollower[];
    privateAccounts: InstagramFollower[];
} {
    return {
        publicAccounts: accounts.filter((a) => !a.isPrivate),
        privateAccounts: accounts.filter((a) => a.isPrivate),
    };
}

// ── 테스트 전용 훅 ──
export function __setProvidersForTest(
    env: Record<string, string | undefined>,
    overrides: Partial<Record<ProviderName, ScraperProvider>>
): void {
    configOverride = env;
    providers = { ...providers, ...overrides } as Record<ProviderName, ScraperProvider>;
}

export function __resetProvidersForTest(): void {
    configOverride = null;
    providers = { apify: apifyProvider, rapidapi: rapidApiProvider, selfhosted: selfHostedProvider };
}
