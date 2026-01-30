import { NextRequest, NextResponse } from 'next/server';

/**
 * Instagram CDN 이미지 프록시 API
 * Instagram CDN URL은 지역 기반이라 Vercel 서버에서 직접 접근이 불가능할 수 있음
 * 직접 접근 실패 시 weserv.nl 프록시를 통해 재시도
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

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);

        let buffer: ArrayBuffer;
        let contentType = 'image/jpeg';

        try {
            // 1차 시도: 직접 fetch
            const response = await fetch(url, {
                signal: controller.signal,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
                    'Referer': 'https://www.instagram.com/',
                },
            });

            if (response.ok) {
                contentType = response.headers.get('content-type') || 'image/jpeg';
                buffer = await response.arrayBuffer();
            } else {
                throw new Error(`Direct fetch failed: ${response.status}`);
            }
        } catch {
            // 2차 시도: weserv.nl 프록시 사용
            const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(url)}&default=1`;
            const proxyResponse = await fetch(proxyUrl, {
                signal: controller.signal,
            });

            if (!proxyResponse.ok) {
                throw new Error(`Proxy fetch failed: ${proxyResponse.status}`);
            }

            contentType = proxyResponse.headers.get('content-type') || 'image/jpeg';
            buffer = await proxyResponse.arrayBuffer();
        }

        clearTimeout(timeoutId);

        return new NextResponse(buffer, {
            headers: {
                'Content-Type': contentType,
                'Cache-Control': 'public, max-age=86400',
                'Access-Control-Allow-Origin': '*',
            },
        });
    } catch (error) {
        console.error('Image proxy error:', error);

        if (error instanceof Error && error.name === 'AbortError') {
            return NextResponse.json({ error: 'Request timeout' }, { status: 504 });
        }

        return NextResponse.json({ error: 'Failed to proxy image' }, { status: 500 });
    }
}
