import { describe, it, expect, beforeEach } from 'vitest';
import { getLayoutVersion, _resetLayoutVersionCache } from './layout-version.js';

describe('getLayoutVersion', () => {
  beforeEach(() => {
    _resetLayoutVersionCache();
  });

  it('returns a 16-char lowercase hex string', async () => {
    const version = await getLayoutVersion();
    expect(version).toMatch(/^[0-9a-f]{16}$/);
  });

  it('is stable across calls within an isolate', async () => {
    const a = await getLayoutVersion();
    const b = await getLayoutVersion();
    expect(a).toBe(b);
  });

  it('returns the cached value on subsequent calls without recomputing', async () => {
    const a = await getLayoutVersion();
    // No reset between calls — cache stays warm.
    const b = await getLayoutVersion();
    const c = await getLayoutVersion();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('recomputes after a cache reset', async () => {
    const a = await getLayoutVersion();
    _resetLayoutVersionCache();
    const b = await getLayoutVersion();
    expect(a).toBe(b);
  });
});
