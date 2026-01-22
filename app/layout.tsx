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
  themeColor: "#6EE7B7",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "AI 바람감지기 - 내 애인의 위험한 친구를 찾아보세요",
  description: "AI가 애인의 인스타그램을 분석해 바람 위험도가 높은 인물을 찾아드립니다. 공개된 정보만으로 연인 관계의 불안을 해소하세요.",
  keywords: ["바람감지기", "AI분석", "인스타그램", "연애", "바람", "여사친", "남사친"],
  authors: [{ name: "AI 바람감지기" }],
  creator: "AI 바람감지기",
  metadataBase: new URL("https://ai-baram-detector.vercel.app"),
  openGraph: {
    type: "website",
    locale: "ko_KR",
    url: "https://ai-baram-detector.vercel.app",
    siteName: "AI 바람감지기",
    title: "AI 바람감지기 - 내 애인의 위험한 친구를 찾아보세요",
    description: "AI가 애인의 인스타그램을 분석해 바람 위험도가 높은 인물을 찾아드립니다.",
    images: [
      {
        url: "/logo.png",
        width: 512,
        height: 512,
        alt: "AI 바람감지기 로고",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: "AI 바람감지기",
    description: "AI가 애인의 인스타그램을 분석해 바람 위험도가 높은 인물을 찾아드립니다.",
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

