import { NextRequest, NextResponse } from 'next/server';

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

    try {
        // URL 유효성 검사 (Instagram CDN URL만 허용)
        const parsedUrl = new URL(url);
        const allowedHosts = [
            'instagram.com',
            'cdninstagram.com',
            'fbcdn.net',
            'instagram.fna.fbcdn.net',
        ];

        const isAllowed = allowedHosts.some(
            (host) => parsedUrl.hostname.includes(host)
        );

        if (!isAllowed) {
            return NextResponse.json({ error: 'URL not allowed' }, { status: 403 });
        }

        let buffer: ArrayBuffer;
        let contentType = 'image/jpeg';

        // 1차 시도: 직접 fetch
        try {
            const controller1 = new AbortController();
            const timeoutId1 = setTimeout(() => controller1.abort(), 8000);

            const response = await fetch(url, {
                signal: controller1.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Referer': 'https://www.instagram.com/',
                },
            });

            clearTimeout(timeoutId1);

            if (response.ok) {
                contentType = response.headers.get('content-type') || 'image/jpeg';
                buffer = await response.arrayBuffer();

                return new NextResponse(buffer, {
                    headers: {
                        'Content-Type': contentType,
                        'Cache-Control': 'public, max-age=86400',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }
        } catch {
            // 1차 시도 실패, 2차 시도로 진행
        }

        // 2차 시도: weserv.nl 프록시 사용
        try {
            const controller2 = new AbortController();
            const timeoutId2 = setTimeout(() => controller2.abort(), 8000);

            const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(url)}&default=1`;
            const proxyResponse = await fetch(proxyUrl, {
                signal: controller2.signal,
            });

            clearTimeout(timeoutId2);

            if (proxyResponse.ok) {
                contentType = proxyResponse.headers.get('content-type') || 'image/jpeg';
                buffer = await proxyResponse.arrayBuffer();

                return new NextResponse(buffer, {
                    headers: {
                        'Content-Type': contentType,
                        'Cache-Control': 'public, max-age=86400',
                        'Access-Control-Allow-Origin': '*',
                    },
                });
            }
        } catch {
            // 2차 시도도 실패
        }

        // 모든 시도 실패: placeholder 반환
        console.warn('Image proxy: all attempts failed, returning placeholder for:', url);
        return getPlaceholderResponse();
    } catch (error) {
        console.error('Image proxy error:', error);
        return getPlaceholderResponse();
    }
}
