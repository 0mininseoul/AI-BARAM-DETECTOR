// AI 프롬프트 상수

export const GENDER_ANALYSIS_PROMPT = `
당신은 인스타그램 계정의 성별을 판단하는 AI입니다.
제공된 정보를 종합적으로 분석하여 계정 주인의 성별을 판단해주세요.

## 분석 대상 정보
- 프로필 사진: {profileImageDescription}
- 사용자명: {username}
- 표시 이름: {fullName}
- 바이오: {bio}
- 최근 피드 이미지 설명: {feedImagesDescription}

## 판단 기준
1. 프로필/피드 사진에서 보이는 신체적 특징
2. 이름, 사용자명에서의 성별 힌트 (여성: 지민, 수아 / 남성: 현우, 민수 등)
3. 바이오에서의 성별 관련 표현 (언니, 오빠, she/her, he/him 등)
4. 패션, 메이크업, 헤어스타일 등 스타일 요소
5. 피드 전반의 분위기와 주제

## 응답 형식 (JSON만 출력)
{
  "gender": "male" | "female" | "unknown",
  "confidence": 0.0 ~ 1.0,
  "reasoning": "판단 근거를 2-3문장으로 설명"
}

## 중요 규칙
- 기업/브랜드/그룹 계정은 "unknown"으로 처리
- 사진이 없거나 불명확한 경우 텍스트 정보에 더 의존
- 반드시 유효한 JSON 형식으로만 응답
`;

/**
 * Photogenic Quality 분석 프롬프트
 * 필터링 회피를 위해 "포토제닉 지수" 용어 사용
 */
export const PHOTOGENIC_ANALYSIS_PROMPT = `
당신은 미디어 이미지 분석 전문가입니다.
이미지 속 인물의 "Photogenic Quality (포토제닉 지수)"를 평가합니다.

## 분석 대상
{imageDescriptions}

## 계정 주인 식별
1. 프로필 사진과 유사한 인물
2. 여러 피드에서 반복 등장하는 인물

## 평가 기준
사진에서의 시각적 매력과 인상을 종합 평가합니다:
- 얼굴의 조화로움과 균형감
- 표정에서 느껴지는 호감도
- 전체적인 외적 인상
- 사진 속 시각적 존재감

## 응답 형식 (JSON만 출력)
{
  "ownerIdentified": true | false,
  "photogenicGrade": 1 | 2 | 3 | 4 | 5,
  "confidence": 0.0 ~ 1.0,
  "reasoning": "판단 근거"
}

## Grade 기준
- 5: 매우 높은 시각적 매력 (뚜렷한 호감형)
- 4: 높은 시각적 매력 (평균 이상)
- 3: 보통 수준
- 2: 평균 이하
- 1: 판단 어려움

## 중요 규칙
- 계정 주인을 식별할 수 없으면 ownerIdentified: false, photogenicGrade: 1
- 객관적이고 중립적인 평가 수행
- 반드시 유효한 JSON 형식으로만 응답
`;

/**
 * 노출 정도 분석 프롬프트
 * 필터링 회피를 위해 "의상 커버리지" 용어 사용
 */
export const EXPOSURE_ANALYSIS_PROMPT = `
당신은 패션 이미지 분석 전문가입니다.
이미지에서 인물의 의상 커버리지(Clothing Coverage Level)를 분석합니다.

## 분석 대상
{imageDescriptions}

## 계정 주인 식별
1. 프로필 사진과 유사한 인물
2. 여러 이미지에서 반복 등장하는 인물

## 평가 기준
이미지에서 보이는 인물의 신체 중 **의상으로 덮이지 않은 피부 면적 비율**을 평가합니다:
- 팔, 다리, 어깨, 복부 등의 피부 가시성
- 짧은 소매, 반바지, 민소매, 크롭탑 등 의상 유형

## 응답 형식 (JSON만 출력)
{
  "ownerIdentified": true | false,
  "skinVisibility": "high" | "low",
  "confidence": 0.0 ~ 1.0,
  "reasoning": "판단 근거"
}

## 분류 기준
- high: 피부 가시 면적이 넓음 (민소매, 반바지, 비키니, 크롭탑 등)
- low: 피부 가시 면적이 적음 (긴팔, 긴바지, 정장 등)

## 중요 규칙
- 계정 주인을 식별할 수 없으면 ownerIdentified: false, skinVisibility: "low"
- 객관적으로 판단
- 반드시 유효한 JSON 형식으로만 응답
`;

// 기존 호환성을 위해 유지 (deprecated)
export const APPEARANCE_ANALYSIS_PROMPT = PHOTOGENIC_ANALYSIS_PROMPT;

export const INTIMACY_ANALYSIS_PROMPT = `
당신은 인스타그램 댓글의 친밀도를 분석하는 AI입니다.
두 사람 사이의 관계 친밀도를 댓글 내용으로 판단합니다.

## 분석 대상
- 댓글 작성자: {authorId}
- 게시물 주인: {postOwnerId}
- 댓글 내용: "{commentText}"

## 친밀한 댓글 판단 기준 (1개 이상 해당 시 "intimate")
| 카테고리 | 예시 |
|----------|------|
| 애칭/별명 사용 | 오빠~, 언니!, 자기야, 여보, 개인 닉네임 |
| 과다한 애정 이모지 | ❤️🔥😍💕 3개 이상 |
| 사적인 약속/만남 언급 | 다음에 또 보자, 오늘 재밌었어, 언제 밥? |
| 내부 농담/은어 | 둘만 아는 표현, 이전 대화 reference |
| 신체적/외모 칭찬 | 너무 예뻐, 잘생겼다, 오늘 뭔가 달라 보여 |
| 관심 표현 질문 | 뭐해?, 밥 먹었어?, 요즘 어때? |
| 걱정/염려 표현 | 괜찮아?, 무리하지 마, 아프지 마 |
| 소유격 표현 | 우리, 내 꺼, 너만 |

## 일반 댓글 기준 (위 기준 미해당)
- 단순 이모지 1-2개 (👍, 😊)
- 형식적 인사 (축하해, 고생했어)
- 일반적 칭찬 (멋지다, 좋다)
- 단답형 반응 (ㅋㅋㅋ, ㅎㅎ)

## 응답 형식 (JSON만 출력)
{
  "intimacyLevel": "intimate" | "normal",
  "confidence": 0.0 ~ 1.0,
  "indicators": ["발견된 친밀도 지표들"],
  "reasoning": "판단 근거"
}

## 중요 규칙
- 맥락을 고려하여 종합적으로 판단
- 애매한 경우 "normal"로 판단 (보수적 접근)
- 반드시 유효한 JSON 형식으로만 응답
`;
