import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './tests-issue-no-keyspace-wide-redis-command.rule.js';

function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries(files)) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

describe('tests-issue-no-keyspace-wide-redis-command', () => {
  it('flags a test that walks the keyspace', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/audit.integration.test.ts':
        'const [cursor, keys] = await redis.scan(0, { match: "hold:*" });\n',
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ line: 1 });
    expect(violations[0]?.message).toContain('scan');
  });

  it('flags a test that empties the keyspace', () => {
    const project = projectWith({
      'apps/api/src/lib/redis/reset.integration.test.ts': 'await redis.flushall();\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the command reached through a string index', () => {
    const project = projectWith({
      'apps/api/src/lib/redis/reset.integration.test.ts': "await redis['dbsize']();\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a call on a differently named client', () => {
    const project = projectWith({
      'apps/api/src/lib/redis/reset.integration.test.ts': 'await testRedis.randomkey();\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('leaves a connection-level command alone', () => {
    const project = projectWith({
      'apps/api/src/whole-app/probe.integration.test.ts': 'await redis.ping();\n',
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves a command addressed to a key alone', () => {
    const project = projectWith({
      'apps/api/src/lib/redis/x.integration.test.ts': 'await redis.get(definition.buildKey(id));\n',
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves a same-named call on something that is not a Redis client alone', () => {
    const project = projectWith({
      'apps/web/src/lib/store.test.ts': 'const found = catalog.keys();\n',
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves a command name called as a bare function alone', () => {
    const project = projectWith({
      'apps/api/src/lib/redis/reset.integration.test.ts': 'await flushall();\n',
    });

    expect(rule.check(project)).toStrictEqual([]);
  });

  it('leaves production code alone — it is not a concurrent test run', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/domain/audit/auditors.ts':
        'const [cursor, keys] = await redis.scan(0, { match: "hold:*" });\n',
    });

    expect(rule.check(project)).toStrictEqual([]);
  });
});
