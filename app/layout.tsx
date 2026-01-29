import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const viewport: Viewport = {
  themeColor: "#EC4899",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "AI 위장 여사친 판독기 - 내 남친의 위험한 친구 찾기",
  description: "내 남친이 맞팔 중인 여자들, 누가 제일 위험할까? AI가 인스타그램을 분석해 위장 여사친을 찾아드립니다.",
  keywords: ["여사친", "위장여사친", "바람기", "AI분석", "인스타그램", "연애불안", "커플", "남사친"],
  authors: [{ name: "AI 위장 여사친 판독기" }],
  creator: "AI 위장 여사친 판독기",
  metadataBase: new URL("https://ai-baram-detector.vercel.app"),
  openGraph: {
    type: "website",
    locale: "ko_KR",
    url: "https://ai-baram-detector.vercel.app",
    siteName: "AI 위장 여사친 판독기",
    title: "AI 위장 여사친 판독기 - 내 남친의 위험한 친구 찾기",
    description: "내 남친이 맞팔 중인 여자들, 누가 제일 위험할까? AI가 인스타그램을 분석해 위장 여사친을 찾아드립니다.",
    images: [
      {
        url: "/logo.png",
        width: 512,
        height: 512,
        alt: "AI 위장 여사친 판독기 로고",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AI 위장 여사친 판독기",
    description: "내 남친이 맞팔 중인 여자들, 누가 제일 위험할까?",
    images: ["/logo.png"],
  },
  icons: {
    icon: "/favicon.ico",
    apple: "/apple-touch-icon.png",
  },
  manifest: "/manifest.json",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}

