import { describe, it, expect, vi } from 'vitest';
import {
    APIFY_RELATIONSHIP_ACTOR_ID,
    apifyProvider,
    makeApifyProvider,
    parseApifyRelationshipDataset,
} from './apify';
import type { ApifyClientLike } from './apify-relationship';

function relationshipItem(username: string, overrides: Record<string, unknown> = {}) {
    return {
        username_scrape: 'target',
        type: 'Followers',
        id: '123',
        username,
        full_name: `${username} name`,
        is_private: false,
        is_verified: false,
        profile_pic_url: 'https://example.com/p.jpg',
        ...overrides,
    };
}

function profileItem(username: string) {
    return {
        username,
        fullName: `${username} name`,
        biography: '',
        followersCount: 1,
        followsCount: 1,
        postsCount: 0,
        private: false,
        verified: false,
        latestPosts: [],
    };
}

function mockClient(items: Array<Record<string, unknown>>, status = 'SUCCEEDED') {
    const call = vi.fn().mockResolvedValue({ status, defaultDatasetId: 'dataset' });
    const listItems = vi.fn(async ({ offset = 0, limit = items.length }: { offset?: number; limit?: number } = {}) => ({
        items: items.slice(offset, offset + limit),
        total: items.length,
        offset,
        count: Math.min(limit, Math.max(0, items.length - offset)),
        limit,
    }));
    const client = {
        actor: vi.fn(() => ({ call })),
        dataset: vi.fn(() => ({ listItems })),
    } as unknown as ApifyClientLike;
    return { client, call, listItems };
}

describe('apifyProvider', () => {
    it('name과 지원 기능이 노출된다', () => {
        expect(apifyProvider.name).toBe('apify');
        expect(typeof apifyProvider.getProfile).toBe('function');
        expect(typeof apifyProvider.getFollowers).toBe('function');
        expect(typeof apifyProvider.getFollowing).toBe('function');
        expect(typeof apifyProvider.getProfilesBatch).toBe('function');
    });

    it('uses the documented Scraping Solutions input and strict following mapping', async () => {
        const { client, call } = mockClient([
            relationshipItem('alice', { type: 'Followings' }),
            relationshipItem('bob', { type: 'followings' }),
        ]);
        const provider = makeApifyProvider({ client, env: {} });

        const result = await provider.getFollowing!('target', 2);

        expect(result.map((item) => item.username)).toEqual(['alice', 'bob']);
        expect(client.actor).toHaveBeenCalledWith(APIFY_RELATIONSHIP_ACTOR_ID);
        expect(call).toHaveBeenCalledWith(
            { Account: ['target'], resultsLimit: 25, dataToScrape: 'Followings' },
            expect.objectContaining({ build: '0.0.71', maxItems: 25, log: null })
        );
    });

    it('accepts only exact relationship build pins and forwards an override', async () => {
        const overridden = mockClient([relationshipItem('alice')]);
        const provider = makeApifyProvider({
            client: overridden.client,
            env: { APIFY_RELATIONSHIP_BUILD: '1.2.3' },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toHaveLength(1);
        expect(overridden.call).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ build: '1.2.3' })
        );

        const invalid = mockClient([relationshipItem('alice')]);
        await expect(makeApifyProvider({
            client: invalid.client,
            env: { APIFY_RELATIONSHIP_BUILD: 'latest' },
        }).getFollowers!('target', 1)).rejects.toThrow('APIFY_RELATIONSHIP_BUILD');
        expect(invalid.call).not.toHaveBeenCalled();
    });

    it.each([
        ['followers', 'Followers'],
        ['followers', 'followers'],
        ['following', 'Following'],
        ['following', 'following'],
        ['following', 'Followings'],
        ['following', 'followings'],
    ] as const)('accepts the %s output type variant %s', (kind, type) => {
        expect(parseApifyRelationshipDataset(
            [relationshipItem('alice', { type })],
            'target',
            kind,
            25
        )).toMatchObject([{ username: 'alice' }]);
    });

    it.each([
        { status: 'error' },
        { status: 'daily limit reached' },
    ])('rejects a status-only actor row instead of treating it as data', (row) => {
        expect(() => parseApifyRelationshipDataset([row], 'target', 'followers', 25))
            .toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('rejects target/type/schema mismatches', async () => {
        const { client } = mockClient([
            relationshipItem('alice', { username_scrape: 'other' }),
        ]);
        const provider = makeApifyProvider({ client, env: {} });
        await expect(provider.getFollowers!('target', 1)).rejects.toThrow('username');

        const malformed = mockClient([
            relationshipItem('alice', { is_private: 'false' }),
        ]);
        await expect(makeApifyProvider({ client: malformed.client, env: {} }).getFollowers!('target', 1))
            .rejects.toThrow('SCRAPING_SCHEMA_ERROR');
    });

    it('reads the 1,000-result boundary completely', async () => {
        const items = Array.from({ length: 1_000 }, (_, index) => relationshipItem(`u${index}`));
        const { client, listItems } = mockClient(items);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getFollowers!('target', 1_000)).resolves.toHaveLength(1_000);
        expect(listItems).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledWith({ offset: 0, limit: 1_000 });
    });

    it('rejects result and estimated-cost ceilings before starting the actor', async () => {
        const overLimit = mockClient([]);
        await expect(makeApifyProvider({ client: overLimit.client, env: {} })
            .getFollowers!('target', 1_001)).rejects.toThrow('limit');
        expect(overLimit.call).not.toHaveBeenCalled();

        const overCost = mockClient([]);
        await expect(makeApifyProvider({
            client: overCost.client,
            env: {
                APIFY_RELATIONSHIP_MAX_RESULTS_PER_OPERATION: '2000',
                APIFY_RELATIONSHIP_MAX_ESTIMATED_COST_USD_PER_OPERATION: '0.5',
            },
        }).getFollowers!('target', 1_000)).rejects.toThrow('BUDGET');
        expect(overCost.call).not.toHaveBeenCalled();
    });

    it('enforces the 95% unique ratio', async () => {
        const items = Array.from({ length: 18 }, (_, index) => relationshipItem(`u${index}`));
        items.push(relationshipItem('u0'), relationshipItem('u1'));
        const { client } = mockClient(items);
        const provider = makeApifyProvider({ client, env: {} });
        await expect(provider.getFollowers!('target', 20)).rejects.toThrow('중복 비율');
    });

    it('fails closed when a profile batch has under 95% username coverage', async () => {
        const { client } = mockClient([profileItem('alice')]);
        const provider = makeApifyProvider({ client, env: {} });
        await expect(provider.getProfilesBatch!(['alice', 'bob'], 2)).rejects.toThrow('INCOMPLETE');
    });

    it('does not swallow failed profile actor runs', async () => {
        const { client } = mockClient([], 'FAILED');
        const provider = makeApifyProvider({ client, env: {} });
        await expect(provider.getProfilesBatch!(['alice'], 1)).rejects.toThrow('status=FAILED');
    });

    it('preserves only a safe actor HTTP status when the Apify request is rejected', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        call.mockRejectedValueOnce(Object.assign(new Error('secret response'), {
            statusCode: 429,
            response: { headers: { authorization: 'Bearer secret' } },
        }));

        await expect(makeApifyProvider({ client, env: {} }).getFollowers!('target', 1))
            .rejects.toThrow('HTTP 429');
    });

    it('serializes actor runs when shared concurrency is explicitly one', async () => {
        let releaseFirst!: () => void;
        const call = vi.fn()
            .mockImplementationOnce(() => new Promise((resolve) => {
                releaseFirst = () => resolve({ status: 'SUCCEEDED', defaultDatasetId: 'first' });
            }))
            .mockResolvedValueOnce({ status: 'SUCCEEDED', defaultDatasetId: 'second' });
        const listItems = vi.fn()
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            })
            .mockResolvedValueOnce({
                items: [relationshipItem('bob', { type: 'Followings' })],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            });
        const client = {
            actor: vi.fn(() => ({ call })),
            dataset: vi.fn(() => ({ listItems })),
        } as unknown as ApifyClientLike;
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_ACTOR_CONCURRENCY: '1',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });

        const followers = provider.getFollowers!('target', 1);
        await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(1));
        const following = provider.getFollowing!('target', 1);
        await Promise.resolve();
        expect(call).toHaveBeenCalledTimes(1);

        releaseFirst();
        await expect(Promise.all([followers, following])).resolves.toMatchObject([
            [{ username: 'alice' }],
            [{ username: 'bob' }],
        ]);
        expect(call).toHaveBeenCalledTimes(2);
    });

    it('rereads a page after a transient pagination-metadata mismatch without double cost', async () => {
        const { client } = mockClient([relationshipItem('alice')]);
        const listItems = vi.fn()
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 0,
                limit: 1,
            })
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        let estimatedCost = 0;
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_DATASET_READ_RETRIES: '2',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });

        await expect(provider.getFollowers!('target', 1, {
            recordUsage(delta) {
                estimatedCost += delta.estimated_cost_usd ?? 0;
            },
        })).resolves.toHaveLength(1);
        expect(listItems).toHaveBeenCalledTimes(2);
        expect(estimatedCost).toBe(0.00085);
    });

    it('waits for the completed actor dataset to settle without rerunning the actor', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const unsettledPage = {
            items: [relationshipItem('alice')],
            total: 0,
            offset: 0,
            count: 1,
            limit: 1,
        };
        const listItems = vi.fn()
            .mockResolvedValueOnce(unsettledPage)
            .mockResolvedValueOnce(unsettledPage)
            .mockResolvedValueOnce(unsettledPage)
            .mockResolvedValueOnce(unsettledPage)
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toHaveLength(1);
        expect(call).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledTimes(5);
    });

    it('rereads an initially empty completed dataset until rows settle', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const emptyPage = {
            items: [],
            total: 0,
            offset: 0,
            count: 0,
            limit: 25,
        };
        const listItems = vi.fn()
            .mockResolvedValueOnce(emptyPage)
            .mockResolvedValueOnce(emptyPage)
            .mockResolvedValueOnce(emptyPage)
            .mockResolvedValueOnce(emptyPage)
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 25,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toMatchObject([
            { username: 'alice' },
        ]);
        expect(call).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledTimes(5);
    });

    it('preserves a legitimate empty dataset after bounded settlement reads', async () => {
        const { client, call } = mockClient([]);
        const provider = makeApifyProvider({
            client,
            env: {
                APIFY_DATASET_READ_RETRIES: '2',
                APIFY_DATASET_RETRY_BASE_DELAY_MS: '0',
            },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toEqual([]);
        expect(call).toHaveBeenCalledTimes(1);
        expect(client.dataset('dataset').listItems).toHaveBeenCalledTimes(3);
    });

    it('retries dataset transport reads without rerunning the paid actor', async () => {
        const { client, call } = mockClient([relationshipItem('alice')]);
        const listItems = vi.fn()
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockRejectedValueOnce(new Error('temporary transport failure'))
            .mockResolvedValueOnce({
                items: [relationshipItem('alice')],
                total: 1,
                offset: 0,
                count: 1,
                limit: 1,
            });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_RETRY_BASE_DELAY_MS: '0' },
        });

        await expect(provider.getFollowers!('target', 1)).resolves.toHaveLength(1);
        expect(call).toHaveBeenCalledTimes(1);
        expect(listItems).toHaveBeenCalledTimes(3);

        const exhausted = mockClient([relationshipItem('alice')]);
        const failedRead = vi.fn().mockRejectedValue(new Error('transport failure'));
        vi.mocked(exhausted.client.dataset).mockReturnValue(
            { listItems: failedRead } as unknown as ReturnType<typeof exhausted.client.dataset>
        );
        await expect(makeApifyProvider({
            client: exhausted.client,
            env: { APIFY_DATASET_READ_RETRIES: '0' },
        }).getFollowers!('target', 1)).rejects.toThrow('APIFY_DATASET_TRANSPORT_EXHAUSTED');
        expect(exhausted.call).toHaveBeenCalledTimes(1);
    });

    it('attributes profile spend per delivered dataset item', async () => {
        const { client, call } = mockClient([profileItem('target')]);
        const provider = makeApifyProvider({ client, env: {} });
        let estimatedCost = 0;

        await expect(provider.getProfile!('target', {
            recordUsage(delta) {
                estimatedCost += delta.estimated_cost_usd ?? 0;
            },
        })).resolves.toMatchObject({ username: 'target' });
        expect(estimatedCost).toBe(0.0026);
        expect(call).toHaveBeenCalledWith(
            { usernames: ['target'] },
            expect.objectContaining({ timeout: 300, waitSecs: 300, maxItems: 1, log: null })
        );
    });

    it('rejects malformed profile booleans, URLs, and latest-post rows', async () => {
        const badBoolean = mockClient([{ ...profileItem('target'), private: 'false' }]);
        await expect(makeApifyProvider({ client: badBoolean.client, env: {} }).getProfile!('target'))
            .rejects.toThrow('SCRAPING_SCHEMA_ERROR');

        const badUrl = mockClient([{ ...profileItem('target'), profilePicUrl: 'not-a-url' }]);
        await expect(makeApifyProvider({ client: badUrl.client, env: {} }).getProfile!('target'))
            .rejects.toThrow('SCRAPING_SCHEMA_ERROR');

        const badPost = mockClient([{
            ...profileItem('target'),
            latestPosts: [{ shortCode: 'abc', displayUrl: 'https://example.com/p.jpg' }],
        }]);
        await expect(makeApifyProvider({ client: badPost.client, env: {} })
            .getProfilesBatch!(['target'], 1)).rejects.toThrow('latestPosts');
    });

    it('accepts the documented -1 hidden engagement-count sentinel', async () => {
        const { client } = mockClient([{
            ...profileItem('target'),
            latestPosts: [{
                id: '1',
                shortCode: 'abc',
                displayUrl: 'https://example.com/p.jpg',
                likesCount: -1,
                commentsCount: -1,
            }],
        }]);
        const provider = makeApifyProvider({ client, env: {} });

        await expect(provider.getProfilesBatch!(['target'], 1)).resolves.toMatchObject([{
            latestPosts: [{ likesCount: -1, commentsCount: -1 }],
        }]);
    });

    it('records item-based spend before rejecting malformed dataset metadata', async () => {
        const { client } = mockClient([relationshipItem('alice')]);
        const listItems = vi.fn().mockResolvedValue({
            items: [relationshipItem('alice')],
            total: Number.NaN,
            offset: 0,
            count: 1,
            limit: 1,
        });
        vi.mocked(client.dataset).mockReturnValue(
            { listItems } as unknown as ReturnType<typeof client.dataset>
        );
        let estimatedCost = 0;
        const provider = makeApifyProvider({
            client,
            env: { APIFY_DATASET_READ_RETRIES: '0' },
        });

        await expect(provider.getFollowers!('target', 1, {
            recordUsage(delta) {
                estimatedCost += delta.estimated_cost_usd ?? 0;
            },
        })).rejects.toThrow('dataset total');
        expect(estimatedCost).toBe(0.00085);
    });
});
