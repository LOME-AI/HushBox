import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { CROSS_CHECK_MODULE } from './rate-limit-entries-reach-the-cross-check.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const ENTRIES_PATH = 'apps/api/src/slices/identity/domain/rate-limit.ts';

const THROTTLE_ENTRY = `export const loginIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 20,
  windowSeconds: 900,
  buildKey: (ipHash: string) => \`ratelimit:identity:login:ip:\${ipHash}\`,
} as const satisfies ThrottleLimit;\n`;

const MAP_ENTRY = `export const IDENTITY_KEYS = {
  loginLockout: {
    kind: 'reservation',
    maxAttempts: 5,
    windowSeconds: 900,
    buildKey: (id: string) => \`ratelimit:identity:login:lockout:\${id}\`,
  } as const satisfies ReservationLimit,
} as const;\n`;

function subjectHolding(body: string): string {
  return `const DECLARED_LIMITS: Readonly<Record<string, RateLimitDefinition>> = {
${body}};\n`;
}

describe('rate-limit-entries-reach-the-cross-check', () => {
  it('accepts a declaration the subject names', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [CROSS_CHECK_MODULE]: subjectHolding('  loginIpRateLimit,\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a map-held declaration the subject names by its property path', () => {
    const project = projectWith({
      [ENTRIES_PATH]: MAP_ENTRY,
      [CROSS_CHECK_MODULE]: subjectHolding('  loginLockout: IDENTITY_KEYS.loginLockout,\n'),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a declaration the subject does not name', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [CROSS_CHECK_MODULE]: subjectHolding(''),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRIES_PATH });
    expect(violations[0]?.message).toMatch(/loginIpRateLimit/);
  });

  it('flags a map-held declaration the subject does not name', () => {
    const project = projectWith({
      [ENTRIES_PATH]: MAP_ENTRY,
      [CROSS_CHECK_MODULE]: subjectHolding(''),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toMatch(/IDENTITY_KEYS\.loginLockout/);
  });

  it('flags a subject entry no declaration answers', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [CROSS_CHECK_MODULE]: subjectHolding('  loginIpRateLimit,\n  retiredRateLimit,\n'),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: CROSS_CHECK_MODULE });
    expect(violations[0]?.message).toMatch(/retiredRateLimit/);
  });

  it('flags a declaration in a form no name reaches', () => {
    const project = projectWith({
      [ENTRIES_PATH]: `export function limitsFor(prefix: string) {
        return {
          lockout: {
            kind: 'reservation',
            maxAttempts: 5,
            windowSeconds: 900,
            buildKey: (id: string) => prefix + id,
          } as const satisfies ReservationLimit,
        };
      }\n`,
      [CROSS_CHECK_MODULE]: subjectHolding(''),
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRIES_PATH });
    expect(violations[0]?.message).toMatch(/no name reaches/);
  });

  it('ignores a throwaway declaration inside a test file', () => {
    const project = projectWith({
      'apps/api/src/middleware/pipeline-rate-limit.test.ts': THROTTLE_ENTRY,
      [CROSS_CHECK_MODULE]: subjectHolding(''),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a declaration outside the api source tree', () => {
    const project = projectWith({
      'packages/shared/src/notes.ts': THROTTLE_ENTRY,
      [CROSS_CHECK_MODULE]: subjectHolding(''),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('throws when the cross-check module is gone', () => {
    const project = projectWith({ [ENTRIES_PATH]: THROTTLE_ENTRY });

    expect(() => rule.check(project)).toThrow(/app-rate-limit-counters/);
  });

  it('throws when the subject declaration is gone', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [CROSS_CHECK_MODULE]: 'const OTHER = {};\n',
    });

    expect(() => rule.check(project)).toThrow(/DECLARED_LIMITS/);
  });

  it('throws when the subject is not an object literal', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [CROSS_CHECK_MODULE]: 'const DECLARED_LIMITS = entriesFrom(slices);\n',
    });

    expect(() => rule.check(project)).toThrow(/object literal/);
  });

  it('throws on a subject entry written in a form it cannot read', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [CROSS_CHECK_MODULE]: subjectHolding('  ...IDENTITY_KEYS,\n'),
    });

    expect(() => rule.check(project)).toThrow(/cannot read/);
  });
});
