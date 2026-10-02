import { describe, it, expect, vi, afterEach } from 'vitest';
import { env } from './env.js';

describe('env module construction (VITE_CI / VITE_E2E spreads)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('forwards CI and E2E to createEnvUtilities when both vars are present', async () => {
    vi.stubEnv('VITE_CI', 'true');
    vi.stubEnv('VITE_E2E', 'true');
    vi.resetModules();
    const { env: reloaded } = await import('./env.js');
    expect(reloaded.isCI).toBe(true);
    expect(reloaded.isE2E).toBe(true);
  });

  it('omits CI and E2E when the vars are absent', async () => {
    vi.stubEnv('VITE_CI', '');
    vi.stubEnv('VITE_E2E', '');
    vi.resetModules();
    const { env: reloaded } = await import('./env.js');
    expect(reloaded.isCI).toBe(false);
    expect(reloaded.isE2E).toBe(false);
  });
});

describe('env', () => {
  it('exports the full EnvUtils shape', () => {
    expect(typeof env.isDev).toBe('boolean');
    expect(typeof env.isLocalDev).toBe('boolean');
    expect(typeof env.isProduction).toBe('boolean');
    expect(typeof env.isCI).toBe('boolean');
    expect(typeof env.isE2E).toBe('boolean');
  });
});
