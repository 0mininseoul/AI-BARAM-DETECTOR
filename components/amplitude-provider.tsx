'use client';

import { type ReactNode, useEffect, useRef } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
    identifyAnalyticsUser,
    initAmplitude,
    isCanonicalAnalyticsUserId,
    markAnalyticsIdentityPending,
    markAnalyticsIdentityReady,
} from '@/lib/services/analytics';
import {
    analyticsAuthProvider,
    availableAnalyticsSessionStorage,
    completePendingAuthEvent,
    type AuthMarkerStorage,
} from '@/lib/services/analytics-auth';

export interface AuthAnalyticsState {
    provider: 'google' | 'kakao' | null;
    resolved: boolean;
    userId: string | null;
}

interface AuthAnalyticsSnapshot {
    loading: boolean;
    provider: 'google' | 'kakao' | null;
    storage?: AuthMarkerStorage;
    userId: string | null;
}

export function createAuthAnalyticsState(): AuthAnalyticsState {
    return { provider: null, resolved: false, userId: null };
}

export function syncAnalyticsAuth(
    state: AuthAnalyticsState,
    snapshot: AuthAnalyticsSnapshot,
): AuthAnalyticsState {
    if (snapshot.loading) return state;

    const userId = snapshot.userId && isCanonicalAnalyticsUserId(snapshot.userId)
        ? snapshot.userId
        : null;
    const provider = userId ? snapshot.provider : null;
    if (state.resolved && state.userId === userId && state.provider === provider) return state;

    if (!state.resolved && !userId) {
        markAnalyticsIdentityReady();
        return { provider: null, resolved: true, userId: null };
    }

    markAnalyticsIdentityPending();
    identifyAnalyticsUser(userId);
    if (userId) {
        completePendingAuthEvent({
            provider,
            storage: snapshot.storage,
            userId,
        });
    }
    markAnalyticsIdentityReady();

    return { provider, resolved: true, userId };
}

export function AmplitudeProvider({ children }: { children: ReactNode }) {
    const { loading, user } = useAuth();
    const authState = useRef(createAuthAnalyticsState());

    useEffect(() => {
        void initAmplitude();
    }, []);

    useEffect(() => {
        authState.current = syncAnalyticsAuth(authState.current, {
            loading,
            provider: analyticsAuthProvider(
                user?.app_metadata?.provider ?? user?.identities?.[0]?.provider,
            ),
            storage: availableAnalyticsSessionStorage(),
            userId: user?.id ?? null,
        });
    }, [loading, user?.id, user?.app_metadata?.provider, user?.identities]);

    return children;
}
