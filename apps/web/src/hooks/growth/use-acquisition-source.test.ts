import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement, type ReactNode } from 'react';

const getMock = vi.fn(() => Promise.resolve(new Response()));
const patchMock = vi.fn((_args: unknown) => Promise.resolve(new Response()));

vi.mock('@/lib/api-client', () => ({
  client: {
    auth: {
      account: {
        'acquisition-source': {
          $get: () => getMock(),
          $patch: (args: unknown) => patchMock(args),
        },
      },
    },
  },
  fetchJson: vi.fn(),
}));

vi.mock('@/hooks/auth/use-stable-session', () => ({
  useStableSession: vi.fn(),
}));

import { fetchJson } from '@/lib/api-client';
import { useStableSession } from '@/hooks/auth/use-stable-session';
import {
  acquisitionSourceKeys,
  useAcquisitionSource,
  useSelfReport,
} from '@/hooks/growth/use-acquisition-source';

const mockFetchJson = vi.mocked(fetchJson);
const mockUseStableSession = vi.mocked(useStableSession);

function createWrapper(): ({ children }: { children: ReactNode }) => ReactNode {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: Readonly<{ children: ReactNode }>): ReactElement {
    return createElement(QueryClientProvider, { client: queryClient }, children);
  }
  Wrapper.displayName = 'TestWrapper';
  return Wrapper;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUseStableSession.mockReturnValue({
    session: null,
    isAuthenticated: true,
    isStable: true,
    isPending: false,
  });
});

describe('acquisitionSourceKeys', () => {
  it('builds the due-prompt key under its own root', () => {
    expect(acquisitionSourceKeys.due()).toEqual(['acquisition-source', 'due']);
  });
});

describe('useAcquisitionSource', () => {
  it('answers what the server says is due', async () => {
    mockFetchJson.mockResolvedValue({ duePrompt: 'post_signup' });

    const { result } = renderHook(() => useAcquisitionSource(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.data).toEqual({ duePrompt: 'post_signup' });
    });
  });

  it('asks the server nothing while no one is signed in', () => {
    mockUseStableSession.mockReturnValue({
      session: null,
      isAuthenticated: false,
      isStable: true,
      isPending: false,
    });

    const { result } = renderHook(() => useAcquisitionSource(), { wrapper: createWrapper() });

    expect(result.current.fetchStatus).toBe('idle');
    expect(getMock).not.toHaveBeenCalled();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });

  it('fails rather than rendering a prompt the contract does not name', async () => {
    mockFetchJson.mockResolvedValue({ duePrompt: 'whenever' });

    const { result } = renderHook(() => useAcquisitionSource(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isError).toBe(true);
    });
  });
});

describe('useSelfReport', () => {
  it('sends the verb as the body of one call', async () => {
    mockFetchJson.mockResolvedValue({ duePrompt: null });
    const { result } = renderHook(() => useSelfReport(), { wrapper: createWrapper() });

    act(() => {
      result.current.submit({ action: 'skip', context: 'post_signup' });
    });

    await waitFor(() => {
      expect(patchMock).toHaveBeenCalledWith({
        json: { action: 'skip', context: 'post_signup' },
      });
    });
  });

  it('adopts the view the server answers with as what is due next', async () => {
    mockFetchJson.mockResolvedValue({ duePrompt: 'first_payment' });
    const wrapper = createWrapper();
    const { result } = renderHook(
      () => ({ report: useSelfReport(), source: useAcquisitionSource() }),
      { wrapper }
    );

    act(() => {
      result.current.report.submit({ action: 'skip', context: 'post_signup' });
    });

    await waitFor(() => {
      expect(result.current.source.data).toEqual({ duePrompt: 'first_payment' });
    });
  });

  it('reports that a verb is in flight', async () => {
    mockFetchJson.mockReturnValue(new Promise(() => undefined));
    const { result } = renderHook(() => useSelfReport(), { wrapper: createWrapper() });

    act(() => {
      result.current.submit({ action: 'skip', context: 'post_signup' });
    });

    await waitFor(() => {
      expect(result.current.isSubmitting).toBe(true);
    });
  });
});
