import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REDIS_REGISTRY_OPERATIONS } from '../lib/redis-calls.js';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule, { IDENTITY_ARGUMENTS_FROM } from './test-redis-keys-take-no-literal-identity.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('test-redis-keys-take-no-literal-identity', () => {
  it('flags a literal identity on a key a test writes', () => {
    const project = projectWith({
      'apps/api/src/slices/identity/session.integration.test.ts':
        "await redis.set(IDENTITY_KEYS.sessionActive.buildKey('user-1'), 'x');\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1 });
    expect(violations[0]?.message).toContain('identity');
  });

  it('flags a numeric literal identity', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts': 'await redis.get(definition.buildKey(7));\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a template with no substitutions', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        'await redis.del(definition.buildKey(`fixed`));\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a literal reached through a helper inside the same Redis call', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        "await redis.set(track(definition.buildKey('fixed')), 'v');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reports one violation per literal argument', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        "await redis.get(definition.buildKey('a', 'b'));\n",
    });

    expect(rule.check(project)).toHaveLength(2);
  });

  it('leaves an identity taken from a variable alone', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        'await redis.get(definition.buildKey(userId));\n',
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves a key built only to assert its shape alone — it reaches no Redis', () => {
    const project = projectWith({
      'apps/api/src/slices/conversations/rate-limit-posture.test.ts':
        "const expected = [linkCreateRateLimit.buildKey('user-id')];\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves a literal value alone — only the identity is shared between runs', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        "await redis.set(definition.buildKey(id), 'a literal value');\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves production code alone', () => {
    const project = projectWith({
      'apps/api/src/slices/x.ts': "await redis.get(definition.buildKey('fixed'));\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('flags a literal identity a registry helper takes directly', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        "await redisGet(redis, recordDefinition, 'user-1');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a write helper’s literal identity and leaves its literal value alone', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        "await redisSet(redis, wordDefinition, 'a literal value', 'user-1');\n",
    });
    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('identity');
  });

  it('flags a literal identity handed to the multi-get entry builder', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        "await redisMGet(redis, [redisMGetEntry(recordDefinition, 'user-1')]);\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('leaves a registry helper that takes no identity of its own alone', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts': 'await redisMGet(redis, entries);\n',
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves an identity alone where the helper is reached through a call, not by name', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        "await boundOperations()(redis, recordDefinition, 'user-1');\n",
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves an identity a registry helper takes from a variable alone', () => {
    const project = projectWith({
      'apps/api/src/slices/x.integration.test.ts':
        'await redisGet(redis, recordDefinition, userId);\n',
    });

    expect(rule.check(project)).toStrictEqual([]);
  });
});

/**
 * Where each helper's rest parameter sits, read off the declarations
 * themselves — the same fact {@link IDENTITY_ARGUMENTS_FROM} states, taken
 * from the source of truth rather than restated.
 */
function restParameterIndices(): Record<string, number | undefined> {
  const project = new Project({ skipAddingFilesFromTsConfig: true });
  const operations = project.addSourceFileAtPath(
    path.join(REPO_ROOT, 'apps', 'api', 'src', 'lib', 'redis', 'operations.ts')
  );
  return Object.fromEntries(
    REDIS_REGISTRY_OPERATIONS.map((operation) => {
      const parameters = operations.getFunctionOrThrow(operation).getParameters();
      const rest = parameters.findIndex((parameter) => parameter.isRestParameter());
      return [operation, rest === -1 ? undefined : rest];
    })
  );
}

describe('IDENTITY_ARGUMENTS_FROM', () => {
  it('names the argument each helper spreads into buildKey — its rest parameter', () => {
    expect({ ...IDENTITY_ARGUMENTS_FROM }).toStrictEqual(restParameterIndices());
  });
});
