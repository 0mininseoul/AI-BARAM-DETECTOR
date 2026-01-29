import { Checkout } from "@polar-sh/nextjs";

export const GET = Checkout({
    accessToken: process.env.POLAR_ACCESS_TOKEN!,
    successUrl: `${process.env.NEXT_PUBLIC_APP_URL}/api/payment/success`,
    returnUrl: process.env.NEXT_PUBLIC_APP_URL,
    server: process.env.NODE_ENV === 'production' ? 'production' : 'sandbox',
    theme: 'dark',
});
