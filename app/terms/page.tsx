export default function TermsPage() {
    return (
        <div className="min-h-screen bg-neutral-900 text-white p-6 md:p-12">
            <div className="max-w-3xl mx-auto space-y-8">
                <h1 className="text-3xl font-bold text-mint-400">이용약관</h1>
                <div className="space-y-4 text-neutral-300 leading-relaxed text-sm md:text-base">
                    <p><strong>제1조 (목적)</strong><br />
                        본 약관은 AI 바람 감지기(이하 &ldquo;회사&rdquo;)가 제공하는 서비스(이하 &ldquo;서비스&rdquo;)의 이용조건 및 절차, 회사와 회원 간의 권리, 의무 및 책임사항 등을 규정함을 목적으로 합니다.</p>

                    <p><strong>제2조 (용어의 정의)</strong><br />
                        1. &ldquo;서비스&rdquo;란 회사가 제공하는 AI 기반 인스타그램 계정 분석 서비스를 의미합니다.<br />
                        2. &ldquo;이용자&rdquo;란 본 약관에 따라 회사가 제공하는 서비스를 이용하는 회원을 말합니다.</p>

                    <p><strong>제3조 (서비스의 제공 및 변경)</strong><br />
                        1. 회사는 AI 기술을 활용하여 입력된 인스타그램 계정의 공개된 정보를 분석하고 리포트를 제공합니다.<br />
                        2. 분석 결과는 AI의 확률적 판단에 근거하며, 실제 사실과 다를 수 있습니다. 회사는 분석 결과의 정확성을 보증하지 않습니다.</p>

                    <p><strong>제4조 (면책조항)</strong><br />
                        1. 본 서비스의 분석 결과는 재미와 참고 목적으로만 제공됩니다.<br />
                        2. 회사는 서비스 이용으로 인해 발생하는 이용자 간의 분쟁이나 오해, 피해에 대해 어떠한 법적 책임도 지지 않습니다.<br />
                        3. 이용자는 분석 결과를 타인의 명예를 훼손하거나 불법적인 목적으로 사용해서는 안 됩니다.</p>

                    <p className="text-neutral-500 pt-4">공고일자: 2026년 1월 23일<br />시행일자: 2026년 1월 23일</p>
                </div>
            </div>
        </div>
    );
}
