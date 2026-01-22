import { ApifyClient } from 'apify-client';
import type { InstagramPost, InstagramComment } from '@/lib/types/instagram';

const client = new ApifyClient({
    token: process.env.APIFY_API_TOKEN,
});

/**
 * 인스타그램 게시물을 수집합니다.
 * 
 * 공식 Actor: apify/instagram-post-scraper
 * 입력: usernames 배열 (username 단일이 아님!)
 */
export async function getPosts(
    username: string,
    limit: number = 20
): Promise<InstagramPost[]> {
    try {
        // instagram-post-scraper는 usernames 배열을 입력으로 받음
        const run = await client.actor('apify/instagram-post-scraper').call({
            usernames: [username],
            resultsLimit: limit,
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        return items.map((item) => {
            const post = item as Record<string, unknown>;
            return {
                id: post.id as string,
                shortCode: post.shortCode as string,
                caption: post.caption as string | undefined,
                imageUrl: post.displayUrl as string | undefined,
                videoUrl: post.videoUrl as string | undefined,
                type: (post.type as string) === 'Video' ? 'video' : 'image',
                likesCount: post.likesCount as number,
                commentsCount: post.commentsCount as number,
                timestamp: post.timestamp as string,
                taggedUsers: (post.taggedUsers as string[]) || [],
                mentionedUsers: extractMentions(post.caption as string),
            };
        });
    } catch (error) {
        console.error(`Failed to get posts for ${username}:`, error);
        return [];
    }
}

/**
 * 게시물의 댓글을 수집합니다.
 * 
 * 통합 instagram-scraper 사용 (comments 수집)
 */
export async function getPostComments(
    postUrl: string,
    limit: number = 50
): Promise<InstagramComment[]> {
    try {
        // 통합 instagram-scraper로 댓글 수집
        const run = await client.actor('apify/instagram-scraper').call({
            directUrls: [postUrl],
            resultsType: 'comments',
            resultsLimit: limit,
        });

        const { items } = await client.dataset(run.defaultDatasetId).listItems();

        return items.map((item) => {
            const comment = item as Record<string, unknown>;
            return {
                id: comment.id as string,
                text: comment.text as string,
                ownerUsername: comment.ownerUsername as string,
                timestamp: comment.timestamp as string,
                likesCount: comment.likesCount as number,
                replies: [],
            };
        });
    } catch (error) {
        console.error(`Failed to get comments for ${postUrl}:`, error);
        return [];
    }
}

/**
 * 텍스트에서 @멘션을 추출합니다.
 */
function extractMentions(text: string | undefined): string[] {
    if (!text) return [];

    const mentionRegex = /@([a-zA-Z0-9._]+)/g;
    const matches = text.match(mentionRegex);

    return matches ? matches.map((m) => m.slice(1)) : [];
}

/**
 * 게시물에서 특정 사용자의 좋아요 여부를 확인합니다.
 * (Apify에서 직접 제공하지 않을 수 있음 - 제한적)
 */
export async function checkLikeStatus(
    postUrl: string,
    targetUsername: string
): Promise<boolean> {
    // Apify의 제한으로 직접 구현이 어려울 수 있음
    // 대안: 댓글 존재 여부로 상호작용 추정
    console.warn(`Like check for ${targetUsername} on ${postUrl} - limited implementation`);
    return false;
}
