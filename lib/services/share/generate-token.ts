import { randomBytes } from 'crypto';

/**
 * 공유 토큰 생성
 * 32바이트 = 64자 hex 문자열, 충분한 엔트로피로 URL 추측 불가능
 */
export function generateShareToken(): string {
    return randomBytes(32).toString('hex');
}
