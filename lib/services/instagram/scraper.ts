import { ApifyClient } from 'apify-client';
import type { InstagramProfile, InstagramFollower, InstagramPost } from '@/lib/types/instagram';

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
    const run = await client.actor('datadoping/instagram-followers-scraper').call({
        usernames: [username],
        max_count: limit,
    });

    if (run.status === 'ABORTED') {
        throw new Error('스크래핑이 중단되었습니다.');
    }

    if (run.status === 'FAILED') {
        throw new Error('SCRAPING_ERROR: 팔로워 수집에 실패했습니다.');
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // 결과가 비어있으면 에러 (계정 접근 실패)
    if (items.length === 0) {
        throw new Error('SCRAPING_ERROR: 팔로워 목록을 가져올 수 없습니다. 계정 접근이 차단되었을 수 있습니다.');
    }

    return items.map((item: Record<string, unknown>) => ({
        username: item.username as string,
        fullName: item.full_name as string | undefined,
        profilePicUrl: item.profile_pic_url as string | undefined,
        isPrivate: item.is_private as boolean ?? false,
        isVerified: item.is_verified as boolean ?? false,
    }));
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
    const cookieEnv = process.env.INSTAGRAM_COOKIE;

    if (!cookieEnv) {
        throw new Error('SCRAPING_AUTH_ERROR: Instagram 쿠키가 설정되지 않았습니다. 관리자에게 문의해주세요.');
    }

    const run = await client.actor('louisdeconinck/instagram-following-scraper').call({
        cookies: cookieEnv,
        usernames: [username],
    });

    if (run.status === 'ABORTED') {
        throw new Error('스크래핑이 중단되었습니다.');
    }

    if (run.status === 'FAILED') {
        throw new Error('SCRAPING_AUTH_ERROR: 팔로잉 수집에 실패했습니다. Instagram 인증이 만료되었을 수 있습니다.');
    }

    const { items } = await client.dataset(run.defaultDatasetId).listItems();

    // 결과가 비어있으면 인증 실패로 간주
    if (items.length === 0) {
        throw new Error('SCRAPING_AUTH_ERROR: 팔로잉 목록을 가져올 수 없습니다. Instagram 인증이 만료되었거나 계정 접근이 차단되었습니다.');
    }

    return items.map((item: Record<string, unknown>) => ({
        username: item.username as string,
        fullName: item.full_name as string | undefined,
        profilePicUrl: item.profile_pic_url as string | undefined,
        isPrivate: item.is_private as boolean ?? false,
        isVerified: item.is_verified as boolean ?? false,
    }));
}

/**
 * latestPosts를 InstagramPost[] 형식으로 변환합니다.
 */
function parseLatestPosts(rawPosts: unknown[]): InstagramPost[] {
    if (!rawPosts || !Array.isArray(rawPosts)) return [];

    return rawPosts.slice(0, 10).map((item) => {
        const post = item as Record<string, unknown>;
        const type = (post.type as string)?.toLowerCase() || 'image';

        // mentions 추출 (caption에서 @username 패턴)
        const caption = post.caption as string || '';
        const mentionRegex = /@([a-zA-Z0-9._]+)/g;
        const mentionMatches = caption.match(mentionRegex);
        const mentionedUsers = mentionMatches ? mentionMatches.map(m => m.slice(1)) : [];

        // taggedUsers 추출
        const taggedUsers: string[] = [];
        const rawTaggedUsers = post.taggedUsers as Array<{ username?: string }> | undefined;
        if (rawTaggedUsers && Array.isArray(rawTaggedUsers)) {
            for (const user of rawTaggedUsers) {
                if (user.username) taggedUsers.push(user.username);
            }
        }

        return {
            id: post.id as string || '',
            shortCode: post.shortCode as string || '',
            caption,
            imageUrl: post.displayUrl as string | undefined,
            videoUrl: post.videoUrl as string | undefined,
            type: type === 'video' ? 'video' : type === 'sidecar' ? 'carousel' : 'image',
            likesCount: post.likesCount as number || 0,
            commentsCount: post.commentsCount as number || 0,
            timestamp: post.timestamp as string || '',
            taggedUsers,
            mentionedUsers,
        } as InstagramPost;
    });
}

/**
 * 여러 계정의 프로필을 배치로 수집합니다.
 * latestPosts도 함께 반환합니다.
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
                const latestPosts = parseLatestPosts(profile.latestPosts as unknown[]);

                results.push({
                    username: profile.username as string,
                    fullName: profile.fullName as string | undefined,
                    bio: profile.biography as string | undefined,
                    externalUrl: profile.externalUrl as string | undefined,
                    profilePicUrl: profile.profilePicUrl as string | undefined,
                    followersCount: profile.followersCount as number,
                    followingCount: profile.followsCount as number,
                    postsCount: profile.postsCount as number,
                    isPrivate: profile.private as boolean,
                    isVerified: profile.verified as boolean,
                    latestPosts,
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
