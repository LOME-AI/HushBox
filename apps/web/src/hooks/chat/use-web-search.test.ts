import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWebSearch } from '@/hooks/chat/use-web-search';

const { mockSearchStore, mockSession, mockToggle } = vi.hoisted(() => ({
  mockSearchStore: {
    current: { webSearchEnabled: false, toggleWebSearch: () => {} } as {
      webSearchEnabled: boolean;
      toggleWebSearch: () => void;
    },
  },
  mockSession: {
    current: { data: null, isPending: false } as {
      data: { user: { id: string } } | null;
      isPending: boolean;
    },
  },
  mockToggle: vi.fn(),
}));

vi.mock('@/stores/search', () => ({
  useSearchStore: () => mockSearchStore.current,
}));

vi.mock('@/lib/auth', () => ({
  useSession: () => mockSession.current,
}));

const AUTHED = { data: { user: { id: 'u1' } }, isPending: false };
const ANON = { data: null, isPending: false };

describe('useWebSearch', () => {
  beforeEach(() => {
    mockSearchStore.current = { webSearchEnabled: false, toggleWebSearch: mockToggle };
    mockSession.current = ANON;
    mockToggle.mockClear();
  });

  it('is active when the preference is on and the user is authenticated', () => {
    mockSearchStore.current = { webSearchEnabled: true, toggleWebSearch: mockToggle };
    mockSession.current = AUTHED;

    const { result } = renderHook(() => useWebSearch());

    expect(result.current.active).toBe(true);
    expect(result.current.canUse).toBe(true);
    expect(result.current.preferred).toBe(true);
  });

  it('is not active for an unauthenticated user even when the preference persists on', () => {
    mockSearchStore.current = { webSearchEnabled: true, toggleWebSearch: mockToggle };
    mockSession.current = ANON;

    const { result } = renderHook(() => useWebSearch());

    expect(result.current.preferred).toBe(true);
    expect(result.current.canUse).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it('is not active when the preference is off', () => {
    mockSearchStore.current = { webSearchEnabled: false, toggleWebSearch: mockToggle };
    mockSession.current = AUTHED;

    const { result } = renderHook(() => useWebSearch());

    expect(result.current.active).toBe(false);
  });

  it('cannot be used while the session is still loading', () => {
    mockSearchStore.current = { webSearchEnabled: true, toggleWebSearch: mockToggle };
    mockSession.current = { data: { user: { id: 'u1' } }, isPending: true };

    const { result } = renderHook(() => useWebSearch());

    expect(result.current.canUse).toBe(false);
    expect(result.current.active).toBe(false);
  });

  it('toggle delegates to the store', () => {
    const { result } = renderHook(() => useWebSearch());

    result.current.toggle();

    expect(mockToggle).toHaveBeenCalledTimes(1);
  });
});
