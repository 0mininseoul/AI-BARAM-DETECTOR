import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

interface SendEmailParams {
    to: string;
    subject: string;
    html: string;
}

export async function sendEmail({ to, subject, html }: SendEmailParams) {
    try {
        const { data, error } = await resend.emails.send({
            from: process.env.RESEND_FROM_EMAIL || 'AI 바람감지기 <noreply@baram-detector.com>',
            to,
            subject,
            html,
        });

        if (error) {
            console.error('Email send error:', error);
            throw error;
        }

        return data;
    } catch (error) {
        console.error('Email service error:', error);
        throw error;
    }
}

/**
 * 분석 완료 이메일 발송
 */
export async function sendAnalysisCompleteEmail(
    email: string,
    targetInstagramId: string,
    requestId: string
) {
    const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://baram-detector.com';
    const resultUrl = `${appUrl}/result/${requestId}`;

    const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #000; color: #fff; padding: 40px 20px; }
        .container { max-width: 480px; margin: 0 auto; }
        .logo { font-size: 24px; font-weight: bold; color: #6EE7B7; margin-bottom: 24px; }
        .title { font-size: 20px; margin-bottom: 16px; }
        .target { color: #6EE7B7; font-weight: bold; }
        .button { display: inline-block; background: #6EE7B7; color: #000; padding: 16px 32px; border-radius: 8px; text-decoration: none; font-weight: bold; margin: 24px 0; }
        .footer { margin-top: 40px; font-size: 12px; color: #666; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="logo">🔍 AI 바람감지기</div>
        <h1 class="title">분석이 완료되었습니다!</h1>
        <p><span class="target">@${targetInstagramId}</span> 계정의 분석이 완료되었습니다.</p>
        <p>지금 바로 결과를 확인해보세요.</p>
        <a href="${resultUrl}" class="button">결과 확인하기</a>
        <div class="footer">
          <p>본 서비스는 재미 목적으로만 이용해주세요.</p>
          <p>AI 분석 결과는 100% 정확하지 않을 수 있습니다.</p>
        </div>
      </div>
    </body>
    </html>
  `;

    return sendEmail({
        to: email,
        subject: `[AI 바람감지기] @${targetInstagramId} 분석 완료!`,
        html,
    });
}
