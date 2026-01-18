import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Unmock stability provider so we can mock it with controlled values
vi.unmock('@/providers/stability-provider');

import { useStableSession } from './use-stable-session';

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/providers/stability-provider', () => ({
  useStability: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { useStability } from '@/providers/stability-provider';

const mockedUseSession = vi.mocked(useSession);
const mockedUseStability = vi.mocked(useStability);

describe('useStableSession', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('session', () => {
    it('returns null when no session data', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.session).toBeNull();
    });

    it('returns session data when available', () => {
      const sessionData = {
        user: { id: 'user-123', email: 'test@example.com' },
        session: { id: 'session-456' },
      };
      mockedUseSession.mockReturnValue({
        data: sessionData,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.session).toEqual(sessionData);
    });

    it('returns undefined session as null', () => {
      mockedUseSession.mockReturnValue({
        data: undefined,
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: false,
        isBalanceStable: true,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.session).toBeNull();
    });
  });

  describe('isAuthenticated', () => {
    it('returns false when auth is not stable', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: false,
        isBalanceStable: true,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableSession());

      // Even though session data exists, not stable yet
      expect(result.current.isAuthenticated).toBe(false);
    });

    it('returns false when stable but no user', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.isAuthenticated).toBe(false);
    });

    it('returns true when stable and user exists', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123', email: 'test@example.com' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.isAuthenticated).toBe(true);
    });
  });

  describe('isStable', () => {
    it('returns isAuthStable from stability provider', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: false,
        isBalanceStable: true,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.isStable).toBe(false);
    });

    it('returns true when auth is stable', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.isStable).toBe(true);
    });
  });

  describe('isPending', () => {
    it('returns isPending from useSession', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: false,
        isBalanceStable: true,
        isAppStable: false,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.isPending).toBe(true);
    });

    it('returns false when session query completes', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseStability.mockReturnValue({
        isAuthStable: true,
        isBalanceStable: true,
        isAppStable: true,
      });

      const { result } = renderHook(() => useStableSession());

      expect(result.current.isPending).toBe(false);
    });
  });
});
