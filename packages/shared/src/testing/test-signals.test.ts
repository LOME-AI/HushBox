import { describe, it, expect } from 'vitest';
import { TEST_SIGNALS } from './test-signals.ts';

describe('TEST_SIGNALS', () => {
  const entries = Object.entries(TEST_SIGNALS);
  const values = Object.values(TEST_SIGNALS);

  it('is a non-empty registry of state-signal attribute names', () => {
    expect(entries.length).toBeGreaterThan(0);
  });

  it('has every value as a data-* attribute name', () => {
    for (const [key, value] of entries) {
      expect(typeof value, `TEST_SIGNALS.${key} is not a string`).toBe('string');
      expect(value, `TEST_SIGNALS.${key} = "${value}" is not a data-* attribute`).toMatch(
        /^data-[a-z0-9]+(?:-[a-z0-9]+)*$/
      );
    }
  });

  it('has every key in camelCase', () => {
    for (const key of Object.keys(TEST_SIGNALS)) {
      expect(key, `TEST_SIGNALS key "${key}" is not camelCase`).toMatch(/^[a-z][a-zA-Z0-9]*$/);
    }
  });

  it('has no duplicate values', () => {
    const unique = new Set(values);
    expect(unique.size, 'TEST_SIGNALS has duplicate values').toBe(values.length);
  });

  it('exposes the announcement banner readiness signal', () => {
    expect(values).toContain('data-banner-settled');
  });

  it('exposes the newsletter signup readiness signal', () => {
    expect(values).toContain('data-newsletter-ready');
  });

  it('exposes the signed-out readiness signal', () => {
    expect(values).toContain('data-signed-out');
  });

  it('exposes the composer affordability readiness signal', () => {
    expect(values).toContain('data-affordability-settled');
  });

  it('exposes the tri-state effort-control signal', () => {
    expect(values).toContain('data-effort-control');
  });

  it('exposes the conversation epoch-state signal', () => {
    expect(TEST_SIGNALS.epochState).toBe('data-epoch-state');
  });

  it('exposes the chat readiness signals the e2e suite gates on', () => {
    expect(values).toContain('data-app-stable');
    expect(values).toContain('data-messages-ready');
    expect(values).toContain('data-ws-connected');
    expect(values).toContain('data-ws-ready');
  });
});
