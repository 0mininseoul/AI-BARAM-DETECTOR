// 인스타그램 관련 타입 정의

export interface InstagramProfile {
    username: string;
    fullName?: string;
    bio?: string;
    profilePicUrl?: string;
    followersCount: number;
    followingCount: number;
    postsCount: number;
    isPrivate: boolean;
    isVerified: boolean;
}

export interface InstagramPost {
    id: string;
    shortCode: string;
    caption?: string;
    imageUrl?: string;
    videoUrl?: string;
    type: 'image' | 'video' | 'carousel' | 'reel';
    likesCount: number;
    commentsCount: number;
    timestamp: string;
    taggedUsers: string[];
    mentionedUsers: string[];
}

export interface InstagramComment {
    id: string;
    text: string;
    ownerUsername: string;
    timestamp: string;
    likesCount: number;
    replies?: InstagramComment[];
}

export interface InstagramFollower {
    username: string;
    fullName?: string;
    profilePicUrl?: string;
    isPrivate: boolean;
    isVerified: boolean;
}

// 맞팔 계정 (분석 대상)
export interface MutualFollow extends InstagramFollower {
    // AI 분석 결과
    gender?: 'male' | 'female' | 'unknown';
    genderConfidence?: number;
}

// 상호작용 데이터
export interface InteractionData {
    targetUsername: string;  // 분석 대상 (애인)
    suspectUsername: string; // 위험 인물 후보

    // 좋아요
    likesFromTarget: number;  // 애인 → 용의자 게시물
    likesFromSuspect: number; // 용의자 → 애인 게시물

    // 댓글
    commentsFromTarget: InstagramComment[];
    commentsFromSuspect: InstagramComment[];

    // 태그/언급
    postTagsFromTarget: number;
    postTagsFromSuspect: number;
    captionMentionsFromTarget: number;
    captionMentionsFromSuspect: number;

    // 기간 분석용
    firstInteractionDate?: string;
    recentInteractionDates: string[];
}
