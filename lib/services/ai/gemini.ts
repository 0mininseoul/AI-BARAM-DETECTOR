import { GoogleGenerativeAI } from '@google/generative-ai';

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);

/**
 * Gemini AI를 사용하여 프롬프트 분석 수행
 * @param prompt - 분석 프롬프트
 * @param images - base64 인코딩된 이미지 배열 (선택)
 * @returns 파싱된 JSON 응답
 */
export async function analyzeWithGemini<T>(
    prompt: string,
    images?: string[]
): Promise<T> {
    // API 호출 전 로그
    console.log('--- AnalyzeWithGemini Start ---');
    console.log('Prompt (first 200 chars):', prompt.substring(0, 200) + '...');
    console.log('Image count:', images?.length ?? 0);

    try {
        const model = genAI.getGenerativeModel({ model: 'gemini-3-flash-preview' });

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parts: any[] = [{ text: prompt }];

        // 이미지가 있으면 추가
        if (images && images.length > 0) {
            for (const image of images) {
                parts.push({
                    inlineData: {
                        mimeType: 'image/jpeg',
                        data: image,
                    },
                });
            }
        }

        const result = await model.generateContent(parts);
        const response = await result.response;
        const text = response.text();

        // Raw Response 로그
        console.log('Gemini Raw Response:', text);

        // JSON 파싱
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            console.error('JSON Parse Failed. Raw text:', text);
            throw new Error('Failed to parse AI response as JSON');
        }

        const parsed = JSON.parse(jsonMatch[0]) as T;
        console.log('Parsed JSON:', JSON.stringify(parsed, null, 2));
        console.log('--- AnalyzeWithGemini End ---');

        return parsed;
    } catch (error) {
        console.error('Gemini API Error:', error);
        throw error;
    }
}

/**
 * 이미지 URL을 base64로 변환
 * Instagram CDN URL은 지역 기반이라 Vercel 서버에서 직접 접근이 불가할 수 있음
 * 실패 시 외부 프록시 서비스(weserv.nl)를 통해 재시도
 */
export async function imageUrlToBase64(url: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15초 타임아웃

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
            const buffer = await response.arrayBuffer();
            return Buffer.from(buffer).toString('base64');
        }

        throw new Error(`Direct fetch failed: ${response.status}`);
    } catch (directError) {
        // 2차 시도: weserv.nl 프록시 사용
        console.log(`Direct fetch failed for ${url.substring(0, 50)}..., trying proxy`);

        try {
            const proxyUrl = `https://images.weserv.nl/?url=${encodeURIComponent(url)}&default=1`;
            const proxyResponse = await fetch(proxyUrl, {
                signal: controller.signal,
            });

            if (!proxyResponse.ok) {
                throw new Error(`Proxy fetch failed: ${proxyResponse.status}`);
            }

            const buffer = await proxyResponse.arrayBuffer();
            return Buffer.from(buffer).toString('base64');
        } catch (proxyError) {
            console.warn(`Failed to convert image via proxy: ${url.substring(0, 80)}...`, proxyError);
            throw proxyError;
        }
    } finally {
        clearTimeout(timeoutId);
    }
}
