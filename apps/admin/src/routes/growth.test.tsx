import { describe, expect, it, vi, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderRoute } from '@/test-utils/render';
import { Route } from './growth.js';

vi.mock('@/components/ops/op-modal-provider', () => ({
  useRunOp: () => vi.fn(),
}));

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('growth route', () => {
  it('mounts the Growth screen', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json({ code: 'UNAVAILABLE' }, { status: 503 })))
    );

    renderRoute(Route);

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Growth', level: 1 })).toBeInTheDocument();
    });
  });
});
