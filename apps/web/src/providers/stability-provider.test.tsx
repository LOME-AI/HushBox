import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook } from '@testing-library/react';

// Unmock the stability provider (it's globally mocked in test-setup.ts)
// so we can test the actual implementation
vi.unmock('@/providers/stability-provider');

// Must import after unmock
import { StabilityProvider, useStability } from './stability-provider';

vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
  initAuth: vi.fn().mockImplementation(() => Promise.resolve()),
}));

vi.mock('@/hooks/billing/billing', () => ({
  useBalance: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
  hasStoredAuth: vi.fn(),
}));

import { useSession, initAuth } from '@/lib/auth';
import { useBalance } from '@/hooks/billing/billing';
import { hasStoredAuth } from '@/lib/auth-client';
import type { ReactNode } from 'react';

const mockedUseSession = vi.mocked(useSession);
const mockedUseBalance = vi.mocked(useBalance);
const mockedInitAuth = vi.mocked(initAuth);
const mockedHasStoredAuth = vi.mocked(hasStoredAuth);

function createWrapper(): ({ children }: Readonly<{ children: ReactNode }>) => ReactNode {
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactNode {
    return <StabilityProvider>{children}</StabilityProvider>;
  }
  return Wrapper;
}

describe('StabilityProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders children', () => {
    mockedUseSession.mockReturnValue({
      data: null,
      isPending: false,
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: null,
      isPending: false,
    } as unknown as ReturnType<typeof useBalance>);

    render(
      <StabilityProvider>
        <div data-testid="child">Hello</div>
      </StabilityProvider>
    );

    expect(screen.getByTestId('child')).toBeInTheDocument();
    expect(screen.getByText('Hello')).toBeInTheDocument();
  });

  it('calls initAuth on mount to restore session', () => {
    mockedUseSession.mockReturnValue({
      data: null,
      isPending: true,
    } as unknown as ReturnType<typeof useSession>);
    mockedUseBalance.mockReturnValue({
      data: null,
      isPending: false,
    } as unknown as ReturnType<typeof useBalance>);

    render(
      <StabilityProvider>
        <div>child</div>
      </StabilityProvider>
    );

    expect(mockedInitAuth).toHaveBeenCalledTimes(1);
  });

  it('throws error when useStability is used outside provider', () => {
    // Suppress console.error for this test since React will log the error
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(vi.fn());

    expect(() => {
      renderHook(() => useStability());
    }).toThrow('useStability must be used within StabilityProvider');

    consoleSpy.mockRestore();
  });
});

describe('useStability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isAuthStable', () => {
    it('returns false when session is pending', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAuthStable).toBe(false);
    });

    it('returns true when session query completes (trial)', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAuthStable).toBe(true);
    });

    it('returns true when session query completes (authenticated)', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: { balance: '10.00' },
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAuthStable).toBe(true);
    });
  });

  describe('isBalanceStable', () => {
    it('returns true for trial users (no balance to load)', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isBalanceStable).toBe(true);
    });

    it('returns true for trial users even while balance is pending', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isBalanceStable).toBe(true);
    });

    it('returns false for authenticated users while balance is pending', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
        isError: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isBalanceStable).toBe(false);
    });

    it('returns true for authenticated users when balance loads', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: { balance: '10.00' },
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isBalanceStable).toBe(true);
    });

    it('returns true for authenticated users with cached balance during refetch', () => {
      // isPending: true but data exists = refetching cached data
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: { balance: '5.00' },
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isBalanceStable).toBe(true);
    });

    it('returns true for authenticated users when balance query terminally errors', () => {
      // A terminal balance error (5xx/408/429 after retries) must not pin the
      // splash forever — a settled-with-error query counts as stable.
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isError: true,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isBalanceStable).toBe(true);
    });
  });

  describe('isAppStable', () => {
    it('returns false when auth is not stable', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAppStable).toBe(false);
    });

    it('returns false when balance is not stable', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isPending: true,
        isError: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAppStable).toBe(false);
    });

    it('returns true when both auth and balance are stable (trial)', () => {
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAppStable).toBe(true);
    });

    it('returns true when both auth and balance are stable (authenticated)', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: { balance: '10.00' },
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAppStable).toBe(true);
    });

    it('returns true when balance query terminally errors (splash can hide)', () => {
      mockedUseSession.mockReturnValue({
        data: { user: { id: 'user-123' } },
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: undefined,
        isError: true,
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAppStable).toBe(true);
    });
  });

  describe('optimistic balance query', () => {
    it('fires balance immediately when stored auth exists', () => {
      mockedHasStoredAuth.mockReturnValue(true);
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: true,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: true,
      } as unknown as ReturnType<typeof useBalance>);

      renderHook(() => useStability(), { wrapper: createWrapper() });

      expect(mockedUseBalance).toHaveBeenCalledWith({ enabled: true });
    });

    it('does not fire balance when no stored auth exists', () => {
      mockedHasStoredAuth.mockReturnValue(false);
      mockedUseSession.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useSession>);
      mockedUseBalance.mockReturnValue({
        data: null,
        isPending: false,
      } as unknown as ReturnType<typeof useBalance>);

      renderHook(() => useStability(), { wrapper: createWrapper() });

      expect(mockedUseBalance).toHaveBeenCalledWith({ enabled: false });
    });
  });
});
