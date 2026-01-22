
import { defineConfig } from '@apps-in-toss/web-framework/config';

export default defineConfig({
    appName: 'AI 바람 감지기', // 앱인토스 콘솔의 앱 이름과 일치해야 합니다.
    brand: {
        displayName: 'AI 바람 감지기',
        primaryColor: '#3182F6', // Toss Blue
        icon: '', // 아이콘 URL 설정 필요
    },
    web: {
        host: 'localhost',
        port: 3000, // Next.js 기본 포트
        commands: {
            dev: 'next dev',
            build: 'next build',
        },
    },
    permissions: [],
});
