import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function source(relativePath: string): string {
    return readFileSync(new URL(`../../${relativePath}`, import.meta.url), 'utf8');
}

describe('Amplitude caller privacy contract', () => {
    it('uses canonical event constants and snake_case properties only', () => {
        const callers = [
            source('app/page.tsx'),
            source('app/result/[requestId]/page.tsx'),
            source('app/share/[token]/page.tsx'),
            source('components/auth-buttons.tsx'),
        ].join('\n');
        const trackingCalls = callers.match(/trackEvent\([\s\S]*?\);/g)?.join('\n') ?? '';

        expect(callers).not.toMatch(/CLICK_CTA_START|VIEW_RESULT|CLICK_SHARE_KAKAO/);
        expect(trackingCalls).not.toMatch(/femaleCount|instagramId\s*:/);
        expect(callers).toContain('EVENTS.TARGET_SUBMITTED');
        expect(callers).toContain('EVENTS.RESULT_VIEWED');
        expect(callers).toContain('EVENTS.RESULT_SHARED');
        expect(callers).toContain('result_count');
        expect(callers).toContain('share_channel');
    });

    it('never places the raw target in an analyze URL', () => {
        const landing = source('app/page.tsx');
        const analyze = source('app/analyze/page.tsx');

        expect(landing).not.toMatch(/\/analyze\?[^'"`]*target=/);
        expect(analyze).not.toMatch(/[?&]target=/);
        expect(analyze).not.toMatch(/params\.get\(['"]target['"]\)/);
        expect(analyze).toContain("router.replace('/analyze?preflight=");
    });

    it('tracks result sharing only after the share helper confirms a channel', () => {
        for (const page of [
            source('app/result/[requestId]/page.tsx'),
            source('app/share/[token]/page.tsx'),
        ]) {
            expect(page).toMatch(/const shareChannel = await shareResult/);
            expect(page).toMatch(/if \(shareChannel\)[\s\S]*?trackEvent\(EVENTS\.RESULT_SHARED/);
            expect(page).not.toMatch(/trackEvent\(EVENTS\.RESULT_SHARED[\s\S]*?await shareResult/);
        }
    });
});
