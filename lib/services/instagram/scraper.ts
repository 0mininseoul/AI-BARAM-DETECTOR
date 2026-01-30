import { ApifyClient } from 'apify-client';
import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';

const client = new ApifyClient({
    token: process.env.APIFY_API_TOKEN,
});

/**
 * 인스타그램 프로필 정보를 수집합니다.
 * 공식 Actor: apify/instagram-profile-scraper
 */
export async function getInstagramProfile(username: string): Promise<InstagramProfile | null> {
    try {
        const run = await client.actor('apify/instagram-profile-scraper').call({
            usernames: [username],
        });

        if (run.status === 'ABORTED') {
            throw new Error('Scraping run aborted by user');
        }

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        if (items.length === 0) {
            return null;
        }

        const profile = items[0] as Record<string, unknown>;

        return {
            username: profile.username as string,
            fullName: profile.fullName as string | undefined,
            bio: profile.biography as string | undefined,
            profilePicUrl: profile.profilePicUrl as string | undefined,
            followersCount: profile.followersCount as number,
            followingCount: profile.followsCount as number,
            postsCount: profile.postsCount as number,
            isPrivate: profile.private as boolean,
            isVerified: profile.verified as boolean,
        };
    } catch (error) {
        console.error(`Failed to get profile for ${username}:`, error);
        return null;
    }
}

/**
 * 인스타그램 팔로워 목록을 수집합니다.
 * Actor: datadoping/instagram-followers-scraper
 */
export async function getFollowers(
    username: string,
    limit: number = 500
): Promise<InstagramFollower[]> {
    try {
        const run = await client.actor('datadoping/instagram-followers-scraper').call({
            usernames: [username],
            max_count: limit,
        });

        if (run.status === 'ABORTED') {
            throw new Error('Scraping run aborted by user');
        }

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        return items.map((item: Record<string, unknown>) => ({
            username: item.username as string,
            fullName: item.full_name as string | undefined,
            profilePicUrl: item.profile_pic_url as string | undefined,
            isPrivate: item.is_private as boolean ?? false,
            isVerified: item.is_verified as boolean ?? false,
        }));
    } catch (error) {
        console.error(`Failed to get followers for ${username}:`, error);
        return [];
    }
}

/**
 * 인스타그램 팔로잉 목록을 수집합니다.
 * Actor: louisdeconinck/instagram-following-scraper
 * ⚠️ 쿠키 필요
 */
export async function getFollowing(
    username: string,
    _limit: number = 500
): Promise<InstagramFollower[]> {
    try {
        const cookieEnv = process.env.INSTAGRAM_COOKIE;

        if (!cookieEnv) {
            console.error('INSTAGRAM_COOKIE environment variable is not set');
            return [];
        }

        const run = await client.actor('louisdeconinck/instagram-following-scraper').call({
            cookies: cookieEnv,
            usernames: [username],
        });

        if (run.status === 'ABORTED') {
            throw new Error('Scraping run aborted by user');
        }

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        return items.map((item: Record<string, unknown>) => ({
            username: item.username as string,
            fullName: item.full_name as string | undefined,
            profilePicUrl: item.profile_pic_url as string | undefined,
            isPrivate: item.is_private as boolean ?? false,
            isVerified: item.is_verified as boolean ?? false,
        }));
    } catch (error) {
        console.error(`Failed to get following for ${username}:`, error);
        return [];
    }
}

/**
 * 여러 계정의 프로필을 배치로 수집합니다.
 */
export async function getProfilesBatch(
    usernames: string[],
    batchSize: number = 10
): Promise<InstagramProfile[]> {
    const results: InstagramProfile[] = [];

    for (let i = 0; i < usernames.length; i += batchSize) {
        const batch = usernames.slice(i, i + batchSize);

        try {
            const run = await client.actor('apify/instagram-profile-scraper').call({
                usernames: batch,
            });

            if (run.status === 'ABORTED') {
                throw new Error('Scraping run aborted by user');
            }

            const { items } = await client.dataset(run.defaultDatasetId).listItems();

            for (const item of items) {
                const profile = item as Record<string, unknown>;
                results.push({
                    username: profile.username as string,
                    fullName: profile.fullName as string | undefined,
                    bio: profile.biography as string | undefined,
                    profilePicUrl: profile.profilePicUrl as string | undefined,
                    followersCount: profile.followersCount as number,
                    followingCount: profile.followsCount as number,
                    postsCount: profile.postsCount as number,
                    isPrivate: profile.private as boolean,
                    isVerified: profile.verified as boolean,
                });
            }
        } catch (error) {
            console.error(`Failed to get profiles batch:`, error);
        }
    }

    return results;
}

/**
 * 맞팔 계정을 추출합니다.
 */
export function extractMutualFollows(
    followers: InstagramFollower[],
    following: InstagramFollower[]
): InstagramFollower[] {
    const followerSet = new Set(followers.map((f) => f.username));

    return following.filter((f) => followerSet.has(f.username));
}

/**
 * 공개/비공개 계정으로 분류합니다.
 */
export function classifyByPrivacy(accounts: InstagramFollower[]): {
    publicAccounts: InstagramFollower[];
    privateAccounts: InstagramFollower[];
} {
    const publicAccounts = accounts.filter((a) => !a.isPrivate);
    const privateAccounts = accounts.filter((a) => a.isPrivate);

    return { publicAccounts, privateAccounts };
}
