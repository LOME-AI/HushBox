import { describe, it, expect } from 'vitest';
import { timestamp } from './deps';
import type { CliDeps } from './deps';

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  return {
    repoRoot: '/repo',
    out: () => {},
    err: () => {},
    ...overrides,
  };
}

describe('timestamp', () => {
  it('stamps a day with no time component when no clock is injected', () => {
    expect(timestamp(deps())).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('takes the injected clock over its own', () => {
    expect(timestamp(deps({ now: () => '2026-07-30' }))).toBe('2026-07-30');
  });
});
