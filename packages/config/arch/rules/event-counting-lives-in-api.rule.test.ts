import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './event-counting-lives-in-api.rule.js';

const PACKAGE_PATH = 'packages/shared/src/limits/attempts.ts';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

describe('event-counting-lives-in-api', () => {
  it('flags a redis INCR client call in a package tree', () => {
    const project = projectWith(
      PACKAGE_PATH,
      `export async function bump(redis, key) {
        return await redis.incr(key);
      }\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: PACKAGE_PATH, line: 2 });
  });

  it('names moving the counter into the api tree as the remedy', () => {
    const project = projectWith(PACKAGE_PATH, 'const count = await redis.incr(key);\n');

    expect(rule.check(project)[0]?.message).toMatch(/move it into `apps\/api\/src\/`/);
  });

  it('flags a counting call in a web tree', () => {
    const project = projectWith(
      'apps/web/src/lib/attempts.ts',
      'const count = await redis.incr(key);\n'
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a countdown client call, because direction is not part of the shape', () => {
    const project = projectWith(PACKAGE_PATH, 'const left = await redis.decr(key);\n');

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an INCRBY that advances by exactly one', () => {
    const project = projectWith(PACKAGE_PATH, 'await redis.incrby(key, 1);\n');

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an HINCRBY that advances by minus one', () => {
    const project = projectWith(PACKAGE_PATH, 'await redis.hincrby(key, field, -1);\n');

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an amount of one written as a quoted string', () => {
    const project = projectWith(PACKAGE_PATH, "await redis.incrbyfloat(key, '1');\n");

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a client call reached by string index', () => {
    const project = projectWith(PACKAGE_PATH, "await redis['incr'](key);\n");

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an INCRBY whose amount carries an explicit plus sign', () => {
    const project = projectWith(PACKAGE_PATH, 'await redis.incrby(key, +1);\n');

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags an INCRBY whose sign is spaced away from its amount', () => {
    const project = projectWith(PACKAGE_PATH, 'await redis.incrby(key, - 1);\n');

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores an INCRBY whose amount is a variable, which folds a quantity', () => {
    const project = projectWith(PACKAGE_PATH, 'await redis.incrby(key, amountNanoUsd);\n');

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an amount-carrying call with no arguments at all', () => {
    const project = projectWith(PACKAGE_PATH, 'await redis.incrby();\n');

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a client method reached by a computed index', () => {
    const project = projectWith(PACKAGE_PATH, 'await redis[command](key);\n');

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a call that is not a method call', () => {
    const project = projectWith(PACKAGE_PATH, 'const decision = consume(redis, definition, id);\n');

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores a Lua dispatch carrying no argument after its command', () => {
    const project = projectWith(PACKAGE_PATH, "export const SCRIPT = `redis.call('INCRBY')`;\n");

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores an ordinary redis read', () => {
    const project = projectWith(PACKAGE_PATH, 'const stored = await redis.get(key);\n');

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a Lua INCR embedded in a script literal', () => {
    const project = projectWith(
      PACKAGE_PATH,
      `export const SCRIPT = \`
        local count = redis.call('INCR', KEYS[1])
        return count
      \`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua dispatch under the server alias and pcall spelling', () => {
    const project = projectWith(
      PACKAGE_PATH,
      `export const SCRIPT = "local count = server.pcall(\\"incr\\", KEYS[1])";\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBY of one inside an interpolated script template', () => {
    const project = projectWith(
      PACKAGE_PATH,
      "export const SCRIPT = `local k = ${prefix}\\nlocal c = redis.call('INCRBY', KEYS[1], 1)`;\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the inner dispatch when one Lua call nests inside another', () => {
    const project = projectWith(
      PACKAGE_PATH,
      "export const SCRIPT = `redis.call('SET', KEYS[2], redis.call('INCR', KEYS[1]))`;\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a Lua INCRBY whose amount stands in an interpolation hole', () => {
    const project = projectWith(
      PACKAGE_PATH,
      "export const SCRIPT = `local c = redis.call('INCRBY', KEYS[1], ${amount})`;\n"
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a Lua INCRBY of one whose key carries a close paren inside quotes', () => {
    const project = projectWith(
      PACKAGE_PATH,
      'export const SCRIPT = `redis.call(\'INCRBY\', "attempts)", 1)`;\n'
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBY of one whose key carries a bare apostrophe', () => {
    const project = projectWith(
      PACKAGE_PATH,
      "export const SCRIPT = `redis.call('INCRBY', 'user's attempts', 1)`;\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a Lua read', () => {
    const project = projectWith(
      PACKAGE_PATH,
      "export const SCRIPT = `local v = redis.call('GET', KEYS[1])`;\n"
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('reports one violation per line when both spellings sit on it', () => {
    const project = projectWith(
      PACKAGE_PATH,
      "await redis.incr(key); const s = `redis.call('INCR', KEYS[1])`;\n"
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores the api tree, where the sibling rules gate the shape', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/domain/quota.ts',
      'const count = await redis.incr(key);\n'
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'packages/shared/src/limits/attempts.test.ts',
      'const count = await redis.incr(key);\n'
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores component test files', () => {
    const project = projectWith(
      'apps/web/src/lib/attempts.test.tsx',
      'const count = await redis.incr(key);\n'
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores spec files', () => {
    const project = projectWith('e2e/attempts.spec.ts', 'const count = await redis.incr(key);\n');

    expect(rule.check(project)).toEqual([]);
  });

  it('sorts violations by line', () => {
    const project = projectWith(
      PACKAGE_PATH,
      `const s = \`redis.call('INCR', KEYS[1])\`;
await redis.decr(key);\n`
    );

    expect(rule.check(project).map((violation) => violation.line)).toEqual([1, 2]);
  });
});
