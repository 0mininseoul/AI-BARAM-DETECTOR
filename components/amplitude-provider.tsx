'use client';

import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useAuth } from '@/hooks/useAuth';
import {
    EVENTS,
    identifyAnalyticsUser,
    initAmplitude,
    isCanonicalAnalyticsUserId,
    trackEvent,
} from '@/lib/services/analytics';

const AUTH_STARTED_STORAGE_KEY = 'amplitude_auth_started';

type AuthMarkerStorage = Pick<Storage, 'getItem' | 'removeItem'>;

export interface AuthAnalyticsState {
    userId: string | null | undefined;
}

interface AuthAnalyticsSnapshot {
    loading: boolean;
    userId: string | null;
    storage?: AuthMarkerStorage;
}

export function completePendingAuthEvent(
    userId: string | null,
    storage?: AuthMarkerStorage,
): boolean {
    if (!userId || !isCanonicalAnalyticsUserId(userId) || !storage) return false;

    try {
        if (storage.getItem(AUTH_STARTED_STORAGE_KEY) === null) return false;

        storage.removeItem(AUTH_STARTED_STORAGE_KEY);
        trackEvent(EVENTS.AUTH_COMPLETED);
        return true;
    } catch {
        return false;
    }
}

export function createAuthAnalyticsState(): AuthAnalyticsState {
    return { userId: undefined };
}

export function syncAnalyticsAuth(
    state: AuthAnalyticsState,
    snapshot: AuthAnalyticsSnapshot,
): AuthAnalyticsState {
    if (snapshot.loading || state.userId === snapshot.userId) return state;

    identifyAnalyticsUser(snapshot.userId);
    completePendingAuthEvent(snapshot.userId, snapshot.storage);

    return { userId: snapshot.userId };
}

function availableSessionStorage(): AuthMarkerStorage | undefined {
    try {
        return window.sessionStorage;
    } catch {
        return undefined;
    }
}

export function AmplitudeProvider({ children }: { children: ReactNode }) {
    const { loading, user } = useAuth();
    const [analyticsReady, setAnalyticsReady] = useState(false);
    const authState = useRef(createAuthAnalyticsState());

    useEffect(() => {
        let active = true;

        void initAmplitude().then((ready) => {
            if (active && ready) setAnalyticsReady(true);
        });

        return () => {
            active = false;
        };
    }, []);

    useEffect(() => {
        if (!analyticsReady) return;

        authState.current = syncAnalyticsAuth(authState.current, {
            loading,
            userId: user?.id ?? null,
            storage: availableSessionStorage(),
        });
    }, [analyticsReady, loading, user?.id]);

    return children;
}
