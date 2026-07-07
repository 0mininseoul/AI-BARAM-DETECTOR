import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ScraperProvider } from './providers/types';
import {
    getInstagramProfile,
    extractMutualFollows,
    classifyByPrivacy,
    __setProvidersForTest,
    __resetProvidersForTest,
} from './scraper';

afterEach(() => __resetProvidersForTest());

function providerWith(over: Partial<ScraperProvider>): ScraperProvider {
    return { name: 'selfhosted', ...over } as ScraperProvider;
}

describe('라우팅', () => {
    it('SCRAPER_PROFILE=selfhosted면 selfhosted.getProfile을 쓴다', async () => {
        const getProfile = vi.fn().mockResolvedValue({ username: 'x' });
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted' },
            { selfhosted: providerWith({ name: 'selfhosted', getProfile }) }
        );
        const p = await getInstagramProfile('x');
        expect(p).toEqual({ username: 'x' });
        expect(getProfile).toHaveBeenCalledWith('x');
    });
});

describe('폴백', () => {
    it('fallback=true면 selfhosted 실패 시 외부(apify)로 폴백한다', async () => {
        const selfFail = vi.fn().mockRejectedValue(new Error('SCRAPING_ERROR: blocked'));
        const apifyOk = vi.fn().mockResolvedValue({ username: 'fallback' });
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted', SCRAPER_FALLBACK: 'true' },
            {
                selfhosted: providerWith({ name: 'selfhosted', getProfile: selfFail }),
                apify: providerWith({ name: 'apify', getProfile: apifyOk }),
            }
        );
        const p = await getInstagramProfile('x');
        expect(p).toEqual({ username: 'fallback' });
        expect(selfFail).toHaveBeenCalled();
        expect(apifyOk).toHaveBeenCalled();
    });

    it('fallback=false면 selfhosted 실패가 그대로 throw된다', async () => {
        const selfFail = vi.fn().mockRejectedValue(new Error('SCRAPING_ERROR: blocked'));
        __setProvidersForTest(
            { SCRAPER_PROFILE: 'selfhosted', SCRAPER_FALLBACK: 'false' },
            { selfhosted: providerWith({ name: 'selfhosted', getProfile: selfFail }) }
        );
        await expect(getInstagramProfile('x')).rejects.toThrow('blocked');
    });
});

describe('순수 헬퍼', () => {
    it('extractMutualFollows는 교집합을 낸다', () => {
        const a = [{ username: 'u1' }, { username: 'u2' }] as never[];
        const b = [{ username: 'u2' }, { username: 'u3' }] as never[];
        expect(extractMutualFollows(a, b).map((x) => x.username)).toEqual(['u2']);
    });
    it('classifyByPrivacy는 공개/비공개로 나눈다', () => {
        const accts = [
            { username: 'a', isPrivate: false },
            { username: 'b', isPrivate: true },
        ] as never[];
        const { publicAccounts, privateAccounts } = classifyByPrivacy(accts);
        expect(publicAccounts).toHaveLength(1);
        expect(privateAccounts).toHaveLength(1);
    });
});
