import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

// Unmock the stability provider (it's globally mocked in test-setup.ts)
// so we can test the actual implementation
vi.unmock('@/providers/stability-provider');

// Must import after unmock
import { StabilityProvider, useStability } from './stability-provider';

// Mock dependencies
vi.mock('@/lib/auth', () => ({
  useSession: vi.fn(),
}));

vi.mock('@/hooks/billing', () => ({
  useBalance: vi.fn(),
}));

import { useSession } from '@/lib/auth';
import { useBalance } from '@/hooks/billing';

const mockedUseSession = vi.mocked(useSession);
const mockedUseBalance = vi.mocked(useBalance);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  function Wrapper({ children }: { children: ReactNode }): ReactNode {
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

    it('returns true when session query completes (guest)', () => {
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
    it('returns true for guests (no balance to load)', () => {
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

    it('returns true for guests even while balance is pending', () => {
      // Guests don't need to wait for balance
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

      // Has cached data, so considered stable
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
      } as unknown as ReturnType<typeof useBalance>);

      const { result } = renderHook(() => useStability(), {
        wrapper: createWrapper(),
      });

      expect(result.current.isAppStable).toBe(false);
    });

    it('returns true when both auth and balance are stable (guest)', () => {
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
  });
});
