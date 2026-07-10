import { NextRequest, NextResponse } from 'next/server';
import {
    downloadSecureImage,
    INSTAGRAM_MEDIA_HOST_SUFFIXES,
    TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
    validateAllowedRemoteImageUrl,
} from '@/lib/services/media/secure-image-fetch';

const IMAGE_PROXY_MAX_BYTES = 8 * 1024 * 1024;
const IMAGE_PROXY_TIMEOUT_MS = 8_000;
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp,image/avif,image/*;q=0.8';

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="150" height="150" viewBox="0 0 150 150">
  <rect width="150" height="150" fill="#1f2937"/>
  <circle cx="75" cy="55" r="25" fill="#4b5563"/>
  <ellipse cx="75" cy="120" rx="40" ry="30" fill="#4b5563"/>
</svg>`;

function getPlaceholderResponse() {
    return new NextResponse(PLACEHOLDER_SVG, {
        headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

function imageResponse(bytes: Buffer, contentType: string) {
    return new NextResponse(new Uint8Array(bytes), {
        headers: {
            'Content-Type': contentType,
            'Cache-Control': 'public, max-age=86400',
            'Access-Control-Allow-Origin': '*',
            'X-Content-Type-Options': 'nosniff',
        },
    });
}

/**
 * Instagram CDN 이미지 프록시 API
 * Instagram CDN URL은 지역 기반이라 Vercel 서버에서 직접 접근이 불가능할 수 있음
 * 직접 접근 실패 시 weserv.nl 프록시를 통해 재시도
 * 모든 시도 실패 시 placeholder 이미지 반환
 */
export async function GET(request: NextRequest) {
    const url = request.nextUrl.searchParams.get('url');

    if (!url) {
        return NextResponse.json({ error: 'URL parameter required' }, { status: 400 });
    }

    let validatedUrl: URL;
    try {
        validatedUrl = await validateAllowedRemoteImageUrl(url, INSTAGRAM_MEDIA_HOST_SUFFIXES);
    } catch {
        return NextResponse.json({ error: 'URL not allowed' }, { status: 403 });
    }

    try {
        const direct = await downloadSecureImage(validatedUrl.href, {
            allowedHostSuffixes: INSTAGRAM_MEDIA_HOST_SUFFIXES,
            maxBytes: IMAGE_PROXY_MAX_BYTES,
            timeoutMs: IMAGE_PROXY_TIMEOUT_MS,
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                Accept: IMAGE_ACCEPT,
                Referer: 'https://www.instagram.com/',
            },
        });
        return imageResponse(direct.bytes, direct.contentType);
    } catch {
        // A trusted image proxy is a compatibility fallback for CDN-region failures.
    }

    try {
        const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(validatedUrl.href)}&default=1`;
        const proxied = await downloadSecureImage(proxyUrl, {
            allowedHostSuffixes: TRUSTED_IMAGE_PROXY_HOST_SUFFIXES,
            maxBytes: IMAGE_PROXY_MAX_BYTES,
            timeoutMs: IMAGE_PROXY_TIMEOUT_MS,
            headers: { Accept: IMAGE_ACCEPT },
        });
        return imageResponse(proxied.bytes, proxied.contentType);
    } catch {
        return getPlaceholderResponse();
    }
}
