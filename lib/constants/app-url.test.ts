import { describe, expect, it } from 'vitest';

import {
    appOriginForRequest,
    appOriginForServer,
    CANONICAL_APP_ORIGIN,
} from './app-url';

describe('canonical app origin', () => {
    it('pins the production origin', () => {
        expect(CANONICAL_APP_ORIGIN).toBe('https://yeosachin.vercel.app');
        expect(appOriginForRequest('https://ai-yeosachinscanner.vercel.app/result/1'))
            .toBe(CANONICAL_APP_ORIGIN);
        expect(appOriginForRequest('https://attacker.example/result/1'))
            .toBe(CANONICAL_APP_ORIGIN);
    });

    it('preserves loopback origins for local requests', () => {
        expect(appOriginForRequest('http://localhost:3000/api/auth/signout'))
            .toBe('http://localhost:3000');
        expect(appOriginForRequest('http://127.0.0.1:3100/api/share/enable'))
            .toBe('http://127.0.0.1:3100');
    });

    it('uses local configuration only outside production', () => {
        expect(appOriginForServer({
            NODE_ENV: 'development',
            NEXT_PUBLIC_APP_URL: 'http://localhost:3000/path',
        })).toBe('http://localhost:3000');
        expect(appOriginForServer({
            NODE_ENV: 'production',
            NEXT_PUBLIC_APP_URL: 'http://localhost:3000',
        })).toBe(CANONICAL_APP_ORIGIN);
        expect(appOriginForServer({
            NODE_ENV: 'development',
            NEXT_PUBLIC_APP_URL: 'https://preview.example',
        })).toBe(CANONICAL_APP_ORIGIN);
    });
});
