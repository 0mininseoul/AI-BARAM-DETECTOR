import type { InstagramFollower } from '@/lib/types/instagram';
import type { ScraperProvider } from './types';

const RAPIDAPI_FOLLOWING_PATH = '/get_ig_user_followers_v2.php';

function getRapidApiConfig() {
    const key = process.env.RAPIDAPI_KEY;
    const host = process.env.RAPIDAPI_HOST;
    if (!key || !host) {
        throw new Error('SCRAPING_CONFIG_ERROR: RAPIDAPI_KEY와 RAPIDAPI_HOST가 설정되지 않았습니다.');
    }
    return { key, host, baseUrl: `https://${host}` };
}

function extractUserList(data: unknown): unknown[] {
    if (Array.isArray(data)) return data;
    if (!data || typeof data !== 'object') return [];
    const record = data as Record<string, unknown>;
    for (const key of ['data', 'users', 'items', 'followers', 'following']) {
        const value = record[key];
        if (Array.isArray(value)) return value;
    }
    if ('0' in record) return Object.values(record);
    return [];
}

function mapFollowerItem(item: unknown): InstagramFollower | null {
    if (!item || typeof item !== 'object') return null;
    const record = item as Record<string, unknown>;
    const user = record.user && typeof record.user === 'object'
        ? (record.user as Record<string, unknown>)
        : record;
    const username = user.username;
    if (typeof username !== 'string' || username.length === 0) return null;

    return {
        username,
        fullName: (user.full_name || user.fullName) as string | undefined,
        profilePicUrl: (user.profile_pic_url || user.profilePicUrl) as string | undefined,
        isPrivate: (user.is_private ?? user.isPrivate ?? false) as boolean,
        isVerified: (user.is_verified ?? user.isVerified ?? false) as boolean,
    };
}

async function getFollowing(username: string, limit: number = 500): Promise<InstagramFollower[]> {
    const { key, host, baseUrl } = getRapidApiConfig();
    const body = new URLSearchParams({
        username_or_url: username,
        data: 'following',
        amount: String(limit),
    });

    const response = await fetch(`${baseUrl}${RAPIDAPI_FOLLOWING_PATH}`, {
        method: 'POST',
        headers: {
            'x-rapidapi-key': key,
            'x-rapidapi-host': host,
            'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
    });

    const text = await response.text();
    let data: unknown = text;
    try {
        data = JSON.parse(text);
    } catch {
        // API 장애 시 HTML/text 응답 가능
    }

    if (!response.ok) {
        throw new Error(`SCRAPING_ERROR: 팔로잉 수집에 실패했습니다. HTTP ${response.status}`);
    }
    if (data && typeof data === 'object' && ('error' in data || 'message' in data)) {
        const errorData = data as { error?: unknown; message?: unknown };
        throw new Error(`SCRAPING_ERROR: 팔로잉 수집에 실패했습니다. ${String(errorData.error || errorData.message)}`);
    }

    const items = extractUserList(data)
        .map(mapFollowerItem)
        .filter((item): item is InstagramFollower => item !== null)
        .slice(0, limit);

    if (items.length === 0) {
        throw new Error('SCRAPING_ERROR: 팔로잉 목록을 가져올 수 없습니다. 계정 접근이 제한되었을 수 있습니다.');
    }
    return items;
}

export const rapidApiProvider: ScraperProvider = {
    name: 'rapidapi',
    getFollowing,
};
