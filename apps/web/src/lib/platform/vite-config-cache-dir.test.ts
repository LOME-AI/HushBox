import path from 'node:path';
import { describe, it, expect, afterEach, vi } from 'vitest';
import config from '../../../vite.config';

const WEB_ROOT = path.resolve(import.meta.dirname, '..', '..', '..');

// Vite's default cache is the one every server rooted in this app resolves when it names none,
// and a server with a different config deletes that cache's dependencies when it starts on it.
// The dev server keeps a folder of its own so no such server can reach the one it serves from.
describe('the web dev server’s dependency cache', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lives in its own folder under the app’s node_modules/.vite, not in Vite’s default', () => {
    vi.stubEnv('HB_VITE_PORT', '10000');
    vi.stubEnv('HB_API_PORT', '10001');

    const { cacheDir } = config({ command: 'serve', mode: 'development' });

    expect(cacheDir === undefined ? undefined : path.resolve(WEB_ROOT, cacheDir)).toBe(
      path.join(WEB_ROOT, 'node_modules', '.vite', 'dev')
    );
  });
});
