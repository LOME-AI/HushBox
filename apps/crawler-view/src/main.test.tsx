import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, screen } from '@testing-library/react';

beforeEach(() => {
  vi.resetModules();
  document.body.innerHTML = '';
  // The mounted dashboard fetches its sitemap; a request that never settles keeps
  // the entry point's own behaviour the only thing under test.
  vi.stubGlobal('fetch', () => new Promise<Response>(() => undefined));
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

describe('the browser entry point', () => {
  it('mounts the dashboard into the root element', async () => {
    const root = document.createElement('div');
    root.id = 'root';
    document.body.append(root);

    await act(async () => {
      await import('./main');
    });

    expect(screen.getByRole('heading', { name: 'Crawler View' })).toBeInTheDocument();
  });

  it('fails fast when the document carries no root element', async () => {
    await expect(import('./main')).rejects.toThrow('Root element not found');
  });
});
