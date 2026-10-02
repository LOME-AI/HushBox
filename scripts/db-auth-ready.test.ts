import { describe, it, expect } from 'vitest';

// Pure-IO CLI wiring: the repair itself is tested in
// lib/stack/postgres-auth-method.test.ts and
// lib/stack/postgres-auth-method-docker.test.ts. This smoke test only pins that
// the entry module loads cleanly (ESM `.js` resolution, no top-level throw)
// without running its main guard — importing it under Vitest never matches
// `isMainModule`, so no docker command fires.
describe('db-auth-ready entry', () => {
  it('imports without executing its CLI main', async () => {
    const entryModule = await import('./db-auth-ready.js');
    expect(entryModule).toBeDefined();
  });
});
