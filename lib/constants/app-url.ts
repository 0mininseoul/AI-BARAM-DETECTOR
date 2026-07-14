export const CANONICAL_APP_ORIGIN = 'https://yeosachin.vercel.app';

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

function loopbackOrigin(rawUrl: string): string | null {
    try {
        const url = new URL(rawUrl);
        if (
            !LOOPBACK_HOSTNAMES.has(url.hostname)
            || (url.protocol !== 'http:' && url.protocol !== 'https:')
            || url.username
            || url.password
        ) {
            return null;
        }
        return url.origin;
    } catch {
        return null;
    }
}

export function appOriginForRequest(requestUrl: string): string {
    return loopbackOrigin(requestUrl) ?? CANONICAL_APP_ORIGIN;
}

export function appOriginForServer(
    env: Readonly<Record<string, string | undefined>> = process.env
): string {
    if (env.NODE_ENV !== 'production') {
        const localOrigin = loopbackOrigin(env.NEXT_PUBLIC_APP_URL ?? '');
        if (localOrigin) return localOrigin;
    }
    return CANONICAL_APP_ORIGIN;
}
