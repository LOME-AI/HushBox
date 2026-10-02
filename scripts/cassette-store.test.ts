import { describe, expect, it } from 'vitest';

// Pure-IO CLI wiring: the sync logic is tested in lib/test-run/cassette-store.test.ts
// and lib/test-run/cassette-store.integration.test.ts. This smoke test only pins that
// the entry module loads cleanly (ESM `.js` resolution, no top-level throw)
// without running its main guard — importing it under Vitest never matches
// `isMainModule`, so no store request fires.
describe('cassette-store entry', () => {
  it('imports without executing its CLI main', async () => {
    const entryModule = await import('./cassette-store.js');
    expect(entryModule).toBeDefined();
  });
});
