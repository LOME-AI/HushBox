import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './rate-limit-keys-use-the-primitive.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const ENTRIES_PATH = 'apps/api/src/slices/identity/domain/rate-limit.ts';
const DOMAIN_PATH = 'apps/api/src/slices/identity/domain/login.ts';

const THROTTLE_ENTRY = `export const loginIpRateLimit = {
  kind: 'throttle',
  maxAttempts: 20,
  windowSeconds: 900,
  buildKey: (ipHash: string) => \`ratelimit:identity:login:ip:\${ipHash}\`,
} as const satisfies ThrottleLimit;\n`;

describe('rate-limit-keys-use-the-primitive', () => {
  it('accepts a rate-limit entry declared as a throttle limit', () => {
    expect(rule.check(projectWith({ [ENTRIES_PATH]: THROTTLE_ENTRY }))).toEqual([]);
  });

  it('accepts a registry entry whose key is outside the rate-limit namespace', () => {
    const project = projectWith({
      [ENTRIES_PATH]: `export const sessionActive = defineKey({
        schema: z.string(),
        ttlSeconds: 60,
        buildKey: (userId: string) => \`sessions:user:active:\${userId}\`,
      });\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a registry entry that builds a rate-limit key', () => {
    const project = projectWith({
      [ENTRIES_PATH]: `export const loginIpRateLimit = defineKey({
        schema: windowSchema,
        ttlSeconds: 900,
        buildKey: (ipHash: string) => \`ratelimit:identity:login:ip:\${ipHash}\`,
      });\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: ENTRIES_PATH });
    expect(violations[0]?.message).toMatch(/consume/);
  });

  it('flags a registry entry that builds a rate-limit key from a plain string', () => {
    const project = projectWith({
      [ENTRIES_PATH]: `export const globalRateLimit = defineKey({
        schema: windowSchema,
        ttlSeconds: 900,
        buildKey: () => 'ratelimit:global',
      });\n`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a registry entry that builds a rate-limit key from an untagged template', () => {
    const project = projectWith({
      [ENTRIES_PATH]: `export const globalRateLimit = defineKey({
        schema: windowSchema,
        ttlSeconds: 900,
        buildKey: () => \`ratelimit:global\`,
      });\n`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a registry entry that declares no key builder', () => {
    const project = projectWith({
      [ENTRIES_PATH]: `export const partial = defineKey({ schema: windowSchema, ttlSeconds: 900 });\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a declaration satisfying an unrelated type', () => {
    const project = projectWith({
      [ENTRIES_PATH]: `export const labels = { login: 'Login' } as const satisfies Record<string, string>;\n`,
      [DOMAIN_PATH]: `export const read = (redis) => redisGet(redis, labels, 'login');\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a limit declared inline in a returned object rather than a variable', () => {
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
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a generic redis call that names no definition at all', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [DOMAIN_PATH]: `export const ping = (redis) => redisGet(redis);\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a generic redis read driven by a rate-limit definition', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [DOMAIN_PATH]: `export function readWindow(redis, ipHash) {
        return redisGet(redis, loginIpRateLimit, ipHash);
      }\n`,
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: DOMAIN_PATH });
    expect(violations[0]?.message).toMatch(/redisGet/);
  });

  it('flags a generic redis write driven by a rate-limit definition held in a map', () => {
    const project = projectWith({
      [ENTRIES_PATH]: `export const IDENTITY_KEYS = {
        loginLockout: {
          kind: 'reservation',
          maxAttempts: 5,
          windowSeconds: 900,
          buildKey: (id: string) => \`ratelimit:identity:login:lockout:\${id}\`,
        } as const satisfies ReservationLimit,
      } as const;\n`,
      [DOMAIN_PATH]: `export function bump(redis, id) {
        return redisSet(redis, IDENTITY_KEYS.loginLockout, { count: 1 }, id);
      }\n`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a multi-get entry built from a rate-limit definition', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [DOMAIN_PATH]: `export function batch(redis, ipHash) {
        return redisMGet(redis, [redisMGetEntry(loginIpRateLimit, ipHash)]);
      }\n`,
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a generic redis read driven by an ordinary registry entry', () => {
    const project = projectWith({
      [ENTRIES_PATH]: THROTTLE_ENTRY,
      [DOMAIN_PATH]: `export function readSession(redis, userId) {
        return redisGet(redis, IDENTITY_KEYS.sessionActive, userId);
      }\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts the rate-limit primitive itself', () => {
    const project = projectWith({
      'apps/api/src/lib/rate-limit/consume.ts': `export const internal = defineKey({
        buildKey: (id: string) => \`ratelimit:internal:\${id}\`,
      });\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores test files', () => {
    const project = projectWith({
      'apps/api/src/slices/identity/domain/rate-limit.test.ts': `const seeded = defineKey({
        buildKey: (id: string) => \`ratelimit:identity:login:ip:\${id}\`,
      });\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores spec files', () => {
    const project = projectWith({
      'apps/api/src/slices/identity/domain/rate-limit.spec.ts': `const seeded = defineKey({
        buildKey: (id: string) => \`ratelimit:identity:login:ip:\${id}\`,
      });\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith({
      'packages/shared/src/notes.ts': `const seeded = defineKey({
        buildKey: (id: string) => \`ratelimit:identity:login:ip:\${id}\`,
      });\n`,
    });

    expect(rule.check(project)).toEqual([]);
  });
});
