// 분석 관련 타입 정의

import type { AnalysisResult } from './database';

// AI 성별 판단 응답
export interface GenderAnalysisResponse {
    gender: 'male' | 'female' | 'unknown';
    confidence: number;
    reasoning: string;
}

// AI 외모 분석 응답
export interface AppearanceAnalysisResponse {
    ownerIdentified: boolean;
    attractivenessLevel: 'high' | 'medium' | 'low';
    confidence: number;
    reasoning: string;
}

// AI 댓글 친밀도 분석 응답
export interface IntimacyAnalysisResponse {
    intimacyLevel: 'intimate' | 'normal';
    confidence: number;
    indicators: string[];
    reasoning: string;
}

// 점수 계산 입력 데이터
export interface ScoreCalculationInput {
    likesCount: number;
    normalCommentsCount: number;
    intimateCommentsCount: number;
    repliesCount: number;
    postTagsCount: number;
    captionMentionsCount: number;
    attractivenessLevel: 'high' | 'medium' | 'low' | null;
    durationMonths: number;
    isRecentSurge: boolean;
}

// 점수 계산 결과
export interface ScoreCalculationResult {
    baseScore: number;
    weightedScore: number;
    finalScore: number;
    breakdown: {
        likes: number;
        normalComments: number;
        intimateComments: number;
        replies: number;
        postTags: number;
        captionMentions: number;
        attractiveness: number;
        durationMultiplier: number;
        surgeMultiplier: number;
    };
}

// 분석 요약 (프론트엔드용)
export interface AnalysisSummary {
    targetInstagramId: string;
    totalFollowers: number;
    mutualFollows: number;
    oppositeGenderCount: number;
    privateAccountsCount: number;
    confidenceScore: number;
}

// 결과 리포트 (프론트엔드용)
export interface AnalysisReport {
    requestId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    summary: AnalysisSummary;
    topResult: AnalysisResult | null;
    lockedResults: {
        rank: number;
        riskScore: number;
        isUnlocked: boolean;
        unlockPrice: number;
    }[];
    privateAccounts: {
        instagramId: string;
        profileImage?: string;
    }[];
}

// 분석 진행 상태
export interface AnalysisProgress {
    requestId: string;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    progress: number;
    progressStep: string;
    createdAt: string;
    estimatedCompletionTime?: string;
}
