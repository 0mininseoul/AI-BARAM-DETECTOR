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
 */
export async function imageUrlToBase64(url: string): Promise<string> {
    const response = await fetch(url);
    const buffer = await response.arrayBuffer();
    return Buffer.from(buffer).toString('base64');
}
