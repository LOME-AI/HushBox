import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './redis-keys-come-from-the-registry.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const DOMAIN_PATH = 'apps/api/src/slices/billing/domain/admission.ts';

/** Every fixture project carries one registry-built call, so the subject set is never empty. */
const REGISTRY_CALL = `export function readSnapshot(redis: RedisClient, walletId: string) {
  return redis.get(BILLING_KEYS.walletSnapshot.buildKey(walletId));
}\n`;

function withRegistryCall(source: string): Record<string, string> {
  return {
    'apps/api/src/slices/billing/domain/snapshot.ts': REGISTRY_CALL,
    [DOMAIN_PATH]: source,
  };
}

/**
 * The live call site this rule must reach, read from disk so that relocating it
 * fails the control loudly instead of leaving it proving nothing.
 */
const LIVE_CALL_SITE = 'apps/api/src/composition/bindings/evict-user-port.ts';
const LIVE_KEY_EXPRESSION = 'REALTIME_REDIS_KEYS.userActiveRooms.buildKey(id)';

describe('redis-keys-come-from-the-registry', () => {
  it('accepts a key built through a registry definition', () => {
    expect(rule.check(projectWith(withRegistryCall(REGISTRY_CALL)))).toEqual([]);
  });

  it('flags a key written as a template literal at the call site', () => {
    const violations = rule.check(
      projectWith(
        withRegistryCall(
          'export const read = (redis: RedisClient, id: string) =>\n' +
            '  redis.get(`billing:wallet-snapshot:${id}`);\n'
        )
      )
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: DOMAIN_PATH });
    expect(violations[0]?.message).toMatch(/buildKey/);
  });

  it('flags a key written as a plain string', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            "export const read = (redis: RedisClient) => redis.get('billing:wallet-snapshot');\n"
          )
        )
      )
    ).toHaveLength(1);
  });

  it('flags a key carried to the call by a file-local binding', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const read = (redis: RedisClient, id: string) => {\n' +
              '  const key = `billing:wallet-snapshot:${id}`;\n' +
              '  return redis.get(key);\n' +
              '};\n'
          )
        )
      )
    ).toHaveLength(1);
  });

  it('flags a key written as a concatenation', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const read = (redis: RedisClient, id: string) =>\n' +
              "  redis.get('billing:wallet-snapshot:' + id);\n"
          )
        )
      )
    ).toHaveLength(1);
  });

  it('flags a literal key inside a script key array', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const run = (redis: RedisClient, args: string[]) =>\n' +
              "  redis.createScript(SCRIPT).exec(['billing:wallet-holds'], args);\n"
          )
        )
      )
    ).toHaveLength(1);
  });

  it('flags a key whose written half is the right operand', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const read = (redis: RedisClient, id: string) =>\n' +
              "  redis.get(id + ':wallet-snapshot');\n"
          )
        )
      )
    ).toHaveLength(1);
  });

  it('reads each spread element of a script key array', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const run = (redis: RedisClient, args: string[]) =>\n' +
              "  redis.createScript(SCRIPT).exec([...['billing:wallet-holds']], args);\n"
          )
        )
      )
    ).toHaveLength(1);
  });

  it('accepts a spread of keys the call site did not write', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const run = (redis: RedisClient, keys: string[], args: string[]) =>\n' +
              '  redis.createScript(SCRIPT).exec([...keys], args);\n'
          )
        )
      )
    ).toEqual([]);
  });

  it('accepts a command that takes no key at all', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall('export const alive = (redis: RedisClient) => redis.ping();\n')
        )
      )
    ).toEqual([]);
  });

  it('accepts a binding that stands for itself', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const read = (redis: RedisClient) => {\n' +
              '  const key = key;\n' +
              '  return redis.get(key);\n' +
              '};\n'
          )
        )
      )
    ).toEqual([]);
  });

  it('accepts a cursor-first scan whose match pattern is a template', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const page = (redis: RedisClient, cursor: string) =>\n' +
              '  redis.scan(cursor, { match: `${SNAPSHOT_KEY_PREFIX}*`, count: 100 });\n'
          )
        )
      )
    ).toEqual([]);
  });

  it('accepts a script literal handed to createScript', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            "export const run = (redis: RedisClient) => redis.createScript('return 1');\n"
          )
        )
      )
    ).toEqual([]);
  });

  it('accepts a chained builder whose chain text mentions a Redis dependency', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            'export const routes = (deps: Deps) =>\n' +
              "  new Hono().post('/a', (c) => read(deps.redis)).post('/b', (c) => c.json({}));\n"
          )
        )
      )
    ).toEqual([]);
  });

  it('accepts a member call on a receiver that is not a Redis client', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall("export const parse = (pattern: RegExp) => pattern.exec('a:b');\n")
        )
      )
    ).toEqual([]);
  });

  it('accepts a client the call site gets from a bare factory call', () => {
    expect(
      rule.check(
        projectWith(
          withRegistryCall(
            "export const read = () => getRedisClient().get('billing:wallet-snapshot');\n"
          )
        )
      )
    ).toEqual([]);
  });

  it('ignores a written key in a test file', () => {
    expect(
      rule.check(
        projectWith({
          'apps/api/src/slices/billing/domain/snapshot.ts': REGISTRY_CALL,
          'apps/api/src/slices/billing/domain/admission.test.ts':
            "export const read = (redis: RedisClient) => redis.get('billing:wallet-snapshot');\n",
        })
      )
    ).toEqual([]);
  });

  it('ignores a written key outside the api source tree', () => {
    expect(
      rule.check(
        projectWith({
          'apps/api/src/slices/billing/domain/snapshot.ts': REGISTRY_CALL,
          'scripts/reset.ts':
            "export const read = (redis: RedisClient) => redis.get('billing:wallet-snapshot');\n",
        })
      )
    ).toEqual([]);
  });

  it('throws when the scanned tree holds no Redis client call at all', () => {
    expect(() => rule.check(projectWith({ [DOMAIN_PATH]: 'export const x = 1;\n' }))).toThrow(
      /no Redis client call/
    );
  });

  describe('against the live call site it must reach', () => {
    const source = readFileSync(path.join(REPO_ROOT, LIVE_CALL_SITE), 'utf8');

    it('passes the key the live call site builds', () => {
      expect(source).toContain(LIVE_KEY_EXPRESSION);
      expect(rule.check(projectWith({ [LIVE_CALL_SITE]: source }))).toEqual([]);
    });

    it('flags that same call once its key is written inline', () => {
      const mutated = source.replace(LIVE_KEY_EXPRESSION, '`realtime:user-active-rooms:${id}`');
      expect(mutated).not.toEqual(source);

      const violations = rule.check(projectWith({ [LIVE_CALL_SITE]: mutated }));

      expect(violations).toHaveLength(1);
      expect(violations[0]).toMatchObject({ file: LIVE_CALL_SITE });
    });
  });
});
