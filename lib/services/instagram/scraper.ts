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
 * 
 * ⚠️ 주의: Apify에서 공식 followers-scraper가 없음
 * 대안: 통합 instagram-scraper의 'followers' 타입 사용
 * 또는 서드파티 Actor 사용 필요
 */
export async function getFollowers(
    username: string,
    limit: number = 500
): Promise<InstagramFollower[]> {
    try {
        // 통합 instagram-scraper 사용 (directUrls 방식)
        const run = await client.actor('apify/instagram-scraper').call({
            directUrls: [`https://www.instagram.com/${username}/`],
            resultsType: 'details',
            resultsLimit: 1,
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        // 팔로워 목록은 직접 수집이 어려움
        // 대안: 최근 게시물의 좋아요/댓글 사용자 분석
        console.warn(`Followers scraping not fully supported. Returning empty for ${username}`);
        return [];
    } catch (error) {
        console.error(`Failed to get followers for ${username}:`, error);
        return [];
    }
}

/**
 * 인스타그램 팔로잉 목록을 수집합니다.
 * 
 * ⚠️ 주의: Apify에서 공식 following-scraper가 없음
 */
export async function getFollowing(
    username: string,
    limit: number = 500
): Promise<InstagramFollower[]> {
    try {
        console.warn(`Following scraping not fully supported. Returning empty for ${username}`);
        return [];
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
