import Image from "next/image";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function Home() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  return (
    <div className="min-h-screen bg-[#111111] text-white selection:bg-[#6EE7B7] selection:text-black">
      {/* Navbar */}
      <nav className="fixed top-0 z-50 w-full border-b border-white/10 bg-[#111111]/80 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-7xl items-center justify-between px-6">
          <div className="flex items-center gap-2">
            <span className="text-2xl">🕵️‍♀️</span>
            <span className="font-bold tracking-tight">바람감지기</span>
          </div>
          <div className="flex items-center gap-4">
            {user ? (
              <Link
                href="/analyze"
                className="rounded-full bg-[#6EE7B7] px-4 py-2 text-sm font-bold text-black transition hover:bg-[#5CD6A6]"
              >
                분석 하러가기
              </Link>
            ) : (
              <Link
                href="/login"
                className="text-sm font-medium text-gray-300 hover:text-white"
              >
                로그인
              </Link>
            )}
          </div>
        </div>
      </nav>

      <main className="flex flex-col items-center">
        {/* Hero Section */}
        <section className="mt-32 flex w-full max-w-4xl flex-col items-center px-6 text-center">
          <div className="mb-6 rounded-full bg-[#6EE7B7]/10 px-4 py-1.5 text-sm font-semibold text-[#6EE7B7]">
            ✨ AI가 찾아내는 미묘한 시그널
          </div>
          <h1 className="mb-6 text-4xl font-extrabold leading-tight tracking-tight sm:text-6xl">
            그 사람의 인스타,<br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-[#6EE7B7] to-[#3B82F6]">
              정말 안전할까요?
            </span>
          </h1>
          <p className="mb-10 max-w-2xl text-lg text-gray-400 sm:text-xl">
            단순히 좋아요만 보는 게 아니에요. <br className="sm:hidden" />
            AI가 댓글 뉘앙스와 숨겨진 패턴까지 분석해 <br className="hidden sm:block" />
            <b>가장 위험한 여사친/남사친</b>을 찾아드립니다.
          </p>

          <div className="flex w-full flex-col gap-4 sm:w-auto sm:flex-row">
            <Link
              href={user ? "/analyze" : "/login"}
              className="flex h-14 items-center justify-center rounded-2xl bg-[#6EE7B7] px-8 text-lg font-bold text-black transition hover:scale-105 hover:bg-[#5CD6A6]"
            >
              지금 바로 분석하기 👉
            </Link>
          </div>

          <div className="mt-12 flex items-center gap-4 text-sm text-gray-500">
            <div className="flex -space-x-2">
              <div className="h-8 w-8 rounded-full bg-gray-700 ring-2 ring-[#111111]" />
              <div className="h-8 w-8 rounded-full bg-gray-600 ring-2 ring-[#111111]" />
              <div className="h-8 w-8 rounded-full bg-gray-500 ring-2 ring-[#111111]" />
            </div>
            <p>이번 주 1,249명 분석 완료</p>
          </div>
        </section>

        {/* Features Grid */}
        <section className="mt-32 w-full max-w-7xl px-6">
          <h2 className="mb-12 text-center text-3xl font-bold">
            뭘 분석하냐구요? 👀
          </h2>
          <div className="grid gap-6 sm:grid-cols-3">
            <div className="rounded-3xl border border-white/10 bg-white/5 p-8 transition hover:border-[#6EE7B7]/50">
              <div className="mb-4 text-4xl">💬</div>
              <h3 className="mb-2 text-xl font-bold">말투 뉘앙스 분석</h3>
              <p className="text-gray-400">
                &quot;오빠 이거 뭐야? ㅋㅋ&quot; vs &quot;정보 감사합니다&quot;<br />
                AI가 친밀도 높은 댓글을 기가 막히게 찾아냅니다.
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/5 p-8 transition hover:border-[#6EE7B7]/50">
              <div className="mb-4 text-4xl">🌙</div>
              <h3 className="mb-2 text-xl font-bold">새벽 시간대 활동</h3>
              <p className="text-gray-400">
                밤 10시 이후에 주고받은 좋아요와 댓글.<br />
                심야 상호작용은 <b>강력한 시그널</b>입니다.
              </p>
            </div>
            <div className="rounded-3xl border border-white/10 bg-white/5 p-8 transition hover:border-[#6EE7B7]/50">
              <div className="mb-4 text-4xl">🦊</div>
              <h3 className="mb-2 text-xl font-bold">과거 흔적 추적</h3>
              <p className="text-gray-400">
                예전 게시물까지 딥 스캔 🔍<br />
                갑자기 나타난 사람이 맞는지 확인해드려요.
              </p>
            </div>
          </div>
        </section>

        {/* Mock Mockup / Visual */}
        <section className="mt-32 flex w-full max-w-7xl flex-col items-center px-6">
          <div className="relative w-full max-w-4xl overflow-hidden rounded-[2.5rem] bg-gradient-to-b from-[#6EE7B7]/20 to-transparent p-1">
            <div className="relative overflow-hidden rounded-[2.4rem] bg-[#1a1a1a] p-8 text-center sm:p-20">
              <h3 className="mb-6 text-2xl font-bold text-[#6EE7B7]">
                🎯 분석 결과 예시
              </h3>
              <div className="mx-auto flex max-w-sm flex-col gap-4 rounded-xl bg-black p-4 text-left shadow-2xl">
                <div className="flex items-center justify-between border-b border-white/10 pb-4">
                  <div className="font-bold text-white">🔥 위험도 1위</div>
                  <div className="rounded-full bg-red-500/20 px-3 py-1 text-xs font-bold text-red-500">
                    위험 (87점)
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <div className="h-12 w-12 rounded-full bg-gray-700" />
                  <div>
                    <div className="font-bold text-white">lovel***** (여)</div>
                    <div className="text-xs text-gray-400">최근 새벽 댓글 급증 📈</div>
                  </div>
                </div>
                <div className="mt-2 rounded bg-gray-900 p-3 text-sm text-gray-300">
                  <span className="text-xs text-gray-500">AI 코멘트</span>
                  <br />
                  &quot;단순 지인이라기엔 말투가 너무 친근해요. 특히 게시물마다 하트를 가장 빨리 누르고 있어요.&quot;
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Reviews (Fake for vibe) */}
        <section className="mt-32 w-full max-w-3xl px-6 pb-20">
          <h2 className="mb-12 text-center text-3xl font-bold">
            베타 테스터 리얼 후기
          </h2>
          <div className="flex flex-col gap-6">
            <div className="rounded-2xl bg-white/5 p-6">
              <div className="mb-2 flex gap-1 text-[#6EE7B7]">⭐⭐⭐⭐⭐</div>
              <p className="mb-4 text-lg">
                &quot;진짜 소름 돋음;; 2위가 전여친이었어요. 남친한테 물어보니까 요즘 다시 연락 온다고 실토함 ㅋㅋㅋ&quot;
              </p>
              <div className="text-sm text-gray-400">- 24세 대학생 김OO님</div>
            </div>
            <div className="rounded-2xl bg-white/5 p-6">
              <div className="mb-2 flex gap-1 text-[#6EE7B7]">⭐⭐⭐⭐⭐</div>
              <p className="mb-4 text-lg">
                &quot;그냥 재미로 해봤는데 평소에 거슬리던 여사친이 1위로 뜸. AI가 보기에도 이상한가 봐요.&quot;
              </p>
              <div className="text-sm text-gray-400">- 28세 직장인 이OO님</div>
            </div>
          </div>
        </section>

        <section className="my-20 flex flex-col items-center px-6 text-center">
          <h2 className="mb-8 text-3xl font-bold">
            지금 바로 확인해보세요 👀
          </h2>
          <Link
            href={user ? "/analyze" : "/login"}
            className="flex h-14 items-center justify-center rounded-2xl bg-[#6EE7B7] px-8 text-lg font-bold text-black transition hover:scale-105 hover:bg-[#5CD6A6]"
          >
            무료로 분석 시작하기
          </Link>
          <p className="mt-6 text-xs text-gray-500">
            * 본 서비스는 재미 목적의 AI 분석 결과를 제공하며, 실제 사실과 다를 수 있습니다.
          </p>
        </section>

        {/* Footer */}
        <footer className="w-full border-t border-white/10 bg-black py-10 text-center text-sm text-gray-600">
          <p className="mb-2">AI 바람감지기 © 2024</p>
          <div className="flex justify-center gap-4">
            <Link href="/terms" className="hover:text-gray-400">이용약관</Link>
            <Link href="/privacy" className="hover:text-gray-400">개인정보처리방침</Link>
            <a href="mailto:support@baram-detector.com" className="hover:text-gray-400">문의하기</a>
          </div>
        </footer>
      </main>
    </div>
  );
}

