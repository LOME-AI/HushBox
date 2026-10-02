import { describe, expect, it, vi, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';
import { opCatalog } from '@/test-utils/op-catalog';
import { useAdminRole } from './use-admin-role';

afterEach(() => {
  vi.unstubAllGlobals();
});

function wrapper({ children }: Readonly<{ children: React.ReactNode }>): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useAdminRole', () => {
  it('reports the role the plane resolved for the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ ...opCatalog(), role: 'growth-viewer' }))
    );
    const { result } = renderHook(() => useAdminRole(), { wrapper });
    await waitFor(() => {
      expect(result.current).toBe('growth-viewer');
    });
  });

  it('reports no role when the catalog read fails, rather than guessing one', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    const { result } = renderHook(() => useAdminRole(), { wrapper });
    await waitFor(() => {
      expect(result.current).toBeNull();
    });
  });
});
