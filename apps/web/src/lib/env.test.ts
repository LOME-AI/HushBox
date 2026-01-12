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
    // In vitest, MODE is typically 'test' which defaults to development
    // The actual behavior depends on vitest.config.ts MODE setting
    // This test documents the expected test environment behavior
    expect(env.isDev).toBe(true); // test mode defaults to development
    expect(env.isProduction).toBe(false);
  });
});
