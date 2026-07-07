import { describe, it, expect } from 'vitest';
import { rapidApiProvider } from './rapidapi';

describe('rapidApiProvider', () => {
    it('getFollowing만 지원한다', () => {
        expect(rapidApiProvider.name).toBe('rapidapi');
        expect(typeof rapidApiProvider.getFollowing).toBe('function');
        expect(rapidApiProvider.getProfile).toBeUndefined();
        expect(rapidApiProvider.getFollowers).toBeUndefined();
    });
});
