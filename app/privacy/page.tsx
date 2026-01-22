export default function PrivacyPage() {
    return (
        <div className="min-h-screen bg-neutral-900 text-white p-6 md:p-12">
            <div className="max-w-3xl mx-auto space-y-8">
                <h1 className="text-3xl font-bold text-mint-400">개인정보처리방침</h1>
                <div className="space-y-4 text-neutral-300 leading-relaxed text-sm md:text-base">
                    <p><strong>1. 개인정보의 수집 항목 및 목적</strong><br />
                        회사는 서비스 제공을 위해 최소한의 개인정보를 수집합니다.<br />
                        - 수집 항목: (로그인 시) 이메일 주소, 프로필 사진, 닉네임 / (분석 시) 입력된 인스타그램 ID<br />
                        - 수집 목적: 서비스 제공, 회원 식별, 분석 결과 생성 및 관리</p>

                    <p><strong>2. 개인정보의 보유 및 이용 기간</strong><br />
                        이용자의 개인정보는 서비스 이용 목적이 달성된 후 지체 없이 파기합니다. 단, 관계 법령에 따라 보존할 필요가 있는 경우 해당 기간 동안 보관합니다.</p>

                    <p><strong>3. 제3자 제공</strong><br />
                        회사는 이용자의 동의 없이 개인정보를 외부에 제공하지 않습니다. 단, AI 분석을 위해 입력된 공개 인스타그램 데이터는 LLM(Gemini) 처리에 활용될 수 있습니다.</p>

                    <p><strong>4. 이용자의 권리</strong><br />
                        이용자는 언제든지 자신의 개인정보 조회를 요청하거나 회원 탈퇴를 통해 개인정보 수집 이용 동의를 철회할 수 있습니다.</p>

                    <p className="text-neutral-500 pt-4">공고일자: 2026년 1월 23일<br />시행일자: 2026년 1월 23일</p>
                </div>
            </div>
        </div>
    );
}
