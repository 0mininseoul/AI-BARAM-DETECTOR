import { ApifyClient } from 'apify-client';
import type { InstagramProfile, InstagramFollower } from '@/lib/types/instagram';

const client = new ApifyClient({
    token: process.env.APIFY_API_TOKEN,
});

/**
 * 인스타그램 프로필 정보를 수집합니다.
 */
export async function getInstagramProfile(username: string): Promise<InstagramProfile | null> {
    try {
        const run = await client.actor('apify/instagram-profile-scraper').call({
            usernames: [username],
        });

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
 */
export async function getFollowers(
    username: string,
    limit: number = 500
): Promise<InstagramFollower[]> {
    try {
        const run = await client.actor('apify/instagram-followers-scraper').call({
            username,
            resultsLimit: limit,
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        return items.map((item) => {
            const follower = item as Record<string, unknown>;
            return {
                username: follower.username as string,
                fullName: follower.fullName as string | undefined,
                profilePicUrl: follower.profilePicUrl as string | undefined,
                isPrivate: follower.isPrivate as boolean,
                isVerified: follower.isVerified as boolean,
            };
        });
    } catch (error) {
        console.error(`Failed to get followers for ${username}:`, error);
        return [];
    }
}

/**
 * 인스타그램 팔로잉 목록을 수집합니다.
 */
export async function getFollowing(
    username: string,
    limit: number = 500
): Promise<InstagramFollower[]> {
    try {
        const run = await client.actor('apify/instagram-following-scraper').call({
            username,
            resultsLimit: limit,
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        return items.map((item) => {
            const following = item as Record<string, unknown>;
            return {
                username: following.username as string,
                fullName: following.fullName as string | undefined,
                profilePicUrl: following.profilePicUrl as string | undefined,
                isPrivate: following.isPrivate as boolean,
                isVerified: following.isVerified as boolean,
            };
        });
    } catch (error) {
        console.error(`Failed to get following for ${username}:`, error);
        return [];
    }
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
