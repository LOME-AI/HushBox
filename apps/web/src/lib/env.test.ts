import { describe, it, expect } from 'vitest';
import { env } from './env.js';

describe('env', () => {
  it('exports an EnvUtils object with all expected properties', () => {
    expect(env).toBeDefined();
    expect(typeof env.isDev).toBe('boolean');
    expect(typeof env.isLocalDev).toBe('boolean');
    expect(typeof env.isProduction).toBe('boolean');
    expect(typeof env.isCI).toBe('boolean');
    expect(typeof env.requiresRealServices).toBe('boolean');
  });

  it('has consistent boolean relationships', () => {
    // isLocalDev can only be true if isDev is true
    if (env.isLocalDev) {
      expect(env.isDev).toBe(true);
    }

    // requiresRealServices is true if isProduction or isCI
    if (env.requiresRealServices) {
      expect(env.isProduction || env.isCI).toBe(true);
    }

    // isDev and isProduction are mutually exclusive
    expect(env.isDev && env.isProduction).toBe(false);
  });

  it('reflects test environment correctly', () => {
    // Vitest runs with MODE='test'. Only 'development' counts as dev mode,
    // so isDev is false under vitest; tests that need a dev-true env mock
    // @/lib/env directly.
    expect(env.isDev).toBe(false);
    expect(env.isLocalDev).toBe(false);
    expect(env.isProduction).toBe(false);
  });
});
