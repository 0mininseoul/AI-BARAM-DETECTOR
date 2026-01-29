# AI 위장 여사친 판독기 MVP - PRD

## 📋 개요

AI가 남자친구의 인스타그램 맞팔 중 위장 여사친을 찾아주는 서비스의 MVP 기술 명세서입니다.

---

## 1. 프로젝트 구조

```
ai-baram-detector/
├── app/
│   ├── page.tsx                      # 랜딩 페이지
│   ├── login/page.tsx                # 로그인
│   ├── analyze/page.tsx              # 분석 입력
│   ├── pricing/page.tsx              # 결제 (입력 후)
│   ├── progress/[requestId]/page.tsx # 분석 진행
│   ├── result/[requestId]/page.tsx   # 결과 리포트
│   ├── mypage/page.tsx               # 마이페이지
│   ├── alert-service/page.tsx        # 알리미 서비스
│   └── api/
│       ├── analysis/
│       ├── payment/
│       ├── mypage/
│       └── alert-service/
├── lib/
│   ├── supabase/
│   ├── services/
│   │   ├── instagram/
│   │   ├── ai/
│   │   └── analysis/
│   └── types/
└── supabase/migrations/
```

---

## 2. 기술 스택

| 영역 | 기술 |
|------|------|
| 프론트엔드 | Next.js 16, Tailwind CSS 4 |
| 배포 | Vercel (Free) |
| 백엔드/DB | Supabase |
| 스크래핑 | Apify |
| AI 분석 | Gemini 3.0 Flash |
| 이메일 | Resend |
| 결제 | Polar (USD) |
| 애널리틱스 | Amplitude |

---

## 3. 환경 변수

```bash
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
APIFY_API_TOKEN=
GEMINI_API_KEY=
RESEND_API_KEY=
RESEND_FROM_EMAIL=
POLAR_ACCESS_TOKEN=
POLAR_ORGANIZATION_ID=
NEXT_PUBLIC_AMPLITUDE_API_KEY=
INSTAGRAM_COOKIE=  # 팔로잉 스크래퍼용
```

---

## 4. 유저 플로우

```
[랜딩] → [로그인] → [애인 ID/성별 입력] → [결제] → [분석 중] → [결과]
```

입력 완료 시 → 데이터 Supabase 저장 → 결제 화면 이동

---

## 5. 요금제

| 요금제 | 가격 | 스크래핑 제한 |
|--------|------|--------------|
| 베이직 | $2.99 | 팔로워/팔로잉 각 **500명** |
| 스탠다드 | $5.99 | 팔로워/팔로잉 각 **1000명** |

---

## 6. Apify 스크래퍼 설정

| 용도 | Actor | 비고 |
|------|-------|------|
| 팔로워 수집 | `datadoping/instagram-followers-scraper` | |
| 팔로잉 수집 | `louisdeconinck/instagram-following-scraper` | **쿠키 필요** |
| 프로필/매일 트래킹 | `apify/instagram-profile-scraper` | |

### 팔로잉 스크래퍼 Input 예시

```json
{
  "username": "target_username",
  "resultsLimit": 500,
  "cookie": "YOUR_INSTAGRAM_COOKIE"
}
```

---

## 7. DB 스키마

```sql
-- 분석 임시 저장 (결제 전)
CREATE TABLE pending_analysis (
  id UUID PRIMARY KEY,
  user_id UUID REFERENCES users(id),
  target_instagram_id VARCHAR(100) NOT NULL,
  target_gender VARCHAR(10),
  created_at TIMESTAMP DEFAULT NOW()
);

-- 분석 결과 확장
ALTER TABLE analysis_results 
ADD COLUMN bio TEXT,
ADD COLUMN photogenic_grade INTEGER CHECK (photogenic_grade BETWEEN 1 AND 5),
ADD COLUMN exposure_level VARCHAR(10) CHECK (exposure_level IN ('high', 'low')),
ADD COLUMN is_tagged BOOLEAN DEFAULT FALSE,
ADD COLUMN risk_grade VARCHAR(20) CHECK (risk_grade IN ('high_risk', 'caution', 'normal')),
ADD COLUMN gender_status VARCHAR(20) CHECK (gender_status IN ('confirmed', 'suspected', 'unknown'));
```

---

## 8. API 명세

### 8.1 입력 저장 (결제 전)

#### POST `/api/analysis/pending`
```json
// Request
{ "targetInstagramId": "boyfriend_123", "targetGender": "male" }

// Response (201)
{ "pendingId": "uuid" }
```

### 8.2 결과 조회

#### GET `/api/analysis/result/[requestId]`
```json
{
  "summary": {
    "targetInstagramId": "boyfriend_123",
    "mutualFollows": 152,
    "genderRatio": {
      "male": { "count": 87, "percentage": 57 },
      "female": { "count": 47, "percentage": 31 },
      "unknown": { "count": 18, "percentage": 12 }
    }
  },
  "femaleAccounts": [
    {
      "instagramId": "user_1",
      "profileImage": "https://...",
      "instagramUrl": "https://instagram.com/user_1",
      "riskGrade": "high_risk",
      "bio": "21 | Seoul"
    }
  ],
  "privateAccounts": [...]
}
```

> 유저에게 표시: 프로필 이미지, 아이디(링크), 위험순위 Grade, bio

---

## 9. AI 프롬프트

### 9.1 성별 판단

```typescript
export const GENDER_ANALYSIS_PROMPT = `
당신은 인스타그램 계정의 성별을 판단하는 AI입니다.

## 분석 대상 정보
- 프로필 사진: {profileImageDescription}
- 사용자명: {username}
- 표시 이름: {fullName}
- 바이오: {bio}
- 최근 피드 이미지: {feedImagesDescription}

## 응답 형식 (JSON)
{ "gender": "male" | "female" | "unknown", "confidence": 0.0~1.0, "reasoning": "판단 근거" }

## 신뢰도 기준
- ≥ 0.80 → 확정
- 0.60 ~ 0.80 → 의심
- < 0.60 → 판단불가
`;
```

### 9.2 Photogenic Quality 분석

```typescript
export const PHOTOGENIC_ANALYSIS_PROMPT = `
당신은 미디어 이미지 분석 전문가입니다.
이미지 속 인물의 "Photogenic Quality (포토제닉 지수)"를 평가합니다.

## 평가 기준
- 얼굴의 조화로움과 균형감
- 표정에서 느껴지는 호감도
- 전체적인 외적 인상
- 사진 속 시각적 존재감

## 응답 형식 (JSON)
{ "ownerIdentified": true|false, "photogenicGrade": 1~5, "confidence": 0.0~1.0, "reasoning": "판단 근거" }

## Grade 기준
5: 매우 높은 시각적 매력 | 4: 평균 이상 | 3: 보통 | 2: 평균 이하 | 1: 판단 어려움
`;
```

### 9.3 노출 정도 분석

```typescript
export const EXPOSURE_ANALYSIS_PROMPT = `
당신은 패션 이미지 분석 전문가입니다.
이미지에서 인물의 의상 커버리지(Clothing Coverage Level)를 분석합니다.

## 평가 기준
의상으로 덮이지 않은 피부 면적 비율을 평가합니다.

## 응답 형식 (JSON)
{ "ownerIdentified": true|false, "skinVisibility": "high"|"low", "confidence": 0.0~1.0, "reasoning": "판단 근거" }

## 분류 기준
- high: 피부 가시 면적이 넓음 (민소매, 반바지, 비키니, 크롭탑 등)
- low: 피부 가시 면적이 적음 (긴팔, 긴바지, 정장 등)
`;
```

---

## 10. 점수 계산

```typescript
const SCORES = {
  PHOTOGENIC: [20, 40, 60, 80, 100], // Grade 1~5
  EXPOSURE_HIGH: 40,
  TAG: 30,
};

// 최대 170점
const totalScore = photogenicScore + exposureScore + tagScore;
```

### 위험순위 분류

- **≥100명**: 상위 **10명** = 고위험군
- **<100명**: 상위 **10%** = 고위험군
- 나머지의 20% = 주의, 80% = 보통

---

## 11. 분석 파이프라인

```typescript
async function runAnalysis(requestId) {
  // 1. 프로필 수집
  // 2. 팔로워/팔로잉 수집 (베이직 500명 / 스탠다드 1000명)
  // 3. 맞팔 추출
  // 4. 공개/비공개 분류 (먼저)
  // 5. 공개 계정 프로필 스크래핑 (최대 350개)
  // 6. 성별 판단
  // 7. Photogenic + 노출 + 태그 분석
  // 8. 점수 계산 및 위험순위 분류
  // 9. 결과 저장 + 이메일
}
```

---

## 변경 이력

| 버전 | 날짜 | 변경 |
|------|------|------|
| 1.0 | 2025-01-22 | 초안 |
| 2.0 | 2026-01-29 | 전면 재설계 |
| 2.1 | 2026-01-29 | 유저 플로우, 요금제(500/1000), 외모 표현 제거, 파이프라인 순서 |
| 2.2 | 2026-01-29 | 고위험군 10명/10%로 변경, 팔로잉 스크래퍼 쿠키 필요 명시 |
