import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule from './event-counting-in-rate-limit.rule.js';

function projectWith(filePath: string, source: string): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  project.createSourceFile(filePath, source);
  return project;
}

const QUOTA_PATH = 'apps/api/src/slices/chat/domain/quota.ts';

describe('event-counting-in-rate-limit', () => {
  it('accepts a gate that goes through the primitive', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export function gate(redis, definition, id) {
        return consume(redis, definition, id);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a redis INCR call outside the primitive', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key) {
        const count = await redis.incr(key);
        await redis.expire(key, 3600, 'NX');
        return count;
      }\n`
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: QUOTA_PATH, line: 2 });
    expect(violations[0]?.message).toMatch(/consume/);
  });

  it('flags a Lua INCR embedded in a script literal', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`
        local count = redis.call('INCR', KEYS[1])
        return count
      \`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCR written with double quotes', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = "local count = redis.call(\\"INCR\\", KEYS[1])";\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua incr written in lower case', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.call('incr', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBY that advances by exactly one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.call('INCRBY', KEYS[1], 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY that advances a field by exactly one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.call('HINCRBY', KEYS[1], ARGV[1], 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a client incrby that advances by exactly one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key) {
        return redis.incrby(key, 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a client hincrby that advances a field by exactly one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key, field) {
        return redis.hincrby(key, field, 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBY whose amount is quoted', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.call('INCRBY', KEYS[1], '1')\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua pcall INCR', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.pcall('INCR', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY whose amount is double quoted', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.call("HINCRBY", KEYS[1], ARGV[1], "1")\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBY whose amount is written as a decimal', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.call('INCRBY', KEYS[1], 1.0)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCR reached by index rather than by field', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis['call']('INCR', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCR called through the server alias', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = server.call('INCR', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a client incrby whose amount is a quoted one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key) {
        return redis.incrby(key, '1');
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCR whose key is interpolated into the script', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.call('INCR', \${keyName})\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY whose amount follows an interpolated key', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local count = redis.call('HINCRBY', \${keyName}, 'attempts', 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCR in a script assembled by concatenation', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = 'local count = redis.call("INCR", ' + key + ')';\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCR nested inside another dispatch', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('SET', KEYS[2], redis.call('INCR', KEYS[1]))\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY nested inside another dispatch', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('SET', KEYS[2], redis.call('HINCRBY', KEYS[1], 'attempts', 1))\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a nested Lua INCRBY folding a variable amount', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`redis.call('SET', KEYS[2], redis.call('INCRBY', KEYS[1], ARGV[1]))\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a Lua INCRBY whose key argument is itself a dispatch', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('INCRBY', redis.call('GET', KEYS[1]), 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBY whose key argument carries a paren', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('INCRBY', KEYS[1] .. tostring(id), 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY whose field argument is a dispatch', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('HINCRBY', KEYS[1], redis.call('GET', KEYS[2]), 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a Lua INCRBY whose amount is a nested dispatch', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`redis.call('INCRBY', KEYS[1], redis.call('GET', 1))\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a Lua INCRBY whose key is quoted text carrying a paren', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('INCRBY', "attempts)", 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY whose script carries a second lone quote after it', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('HINCRBY', KEYS[1], 'user\\'s attempts', 1)
-- don\\'t reset the TTL here
if redis.call('TTL', KEYS[1]) < 0 then redis.call('EXPIRE', KEYS[1], 900) end\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY whose lone quote is closed by a later dispatch argument', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('HINCRBY', KEYS[1], 'user\\'s attempts', 1)
redis.call('SET', KEYS[2], 'don\\'t reset')\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY whose field carries an escaped quote', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('HINCRBY', KEYS[1], 'user\\'s attempts', 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBY whose key carries an escaped quote', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('INCRBY', 'lock\\'out', 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBY whose key carries an escaped double quote', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('INCRBY', "ke\\"y", 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua dispatch written with space around its member access', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis . call('INCR', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua dispatch whose member access follows a line break', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis\n  .call('INCR', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua DECR', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('DECR', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua DECRBY counting down by one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('DECRBY', KEYS[1], 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua HINCRBY counting a field down by one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('HINCRBY', KEYS[1], 'attempts', -1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a Lua DECRBY folding a variable amount', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`redis.call('DECRBY', KEYS[1], ARGV[1])\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a client decr', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function spend(redis, key) {
        await redis.decr(key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a client incrby whose amount carries an explicit plus sign', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key) {
        await redis.incrby(key, +1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('ignores a client incrby whose amount is a variable, which folds a quantity', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function fold(redis, key, amountNanoUsd) {
        await redis.incrby(key, amountNanoUsd);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a client incrby counting down by one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function spend(redis, key) {
        await redis.incrby(key, -1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua INCRBYFLOAT advancing by one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call('INCRBYFLOAT', KEYS[1], 1)\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a Lua INCRBYFLOAT folding a variable amount', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`redis.call('INCRBYFLOAT', KEYS[1], ARGV[1])\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a client hincrbyfloat advancing by one', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key) {
        await redis.hincrbyfloat(key, 'attempts', 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a Lua dispatch written with a space before its arguments', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`redis.call ('INCR', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a client incr reached by index rather than by field', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key) {
        return redis['incr'](key);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a client hincrby reached by index', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key, field) {
        return redis["hincrby"](key, field, 1);
      }\n`
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('accepts a Lua INCRBY whose interpolated amount the rule cannot read', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`local total = redis.call('INCRBY', KEYS[1], \${amount})\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a Lua INCRBY whose amount is computed by a call', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`local total = redis.call('INCRBY', KEYS[1], tonumber(ARGV[1]))\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a client increment named by a computed index', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export async function bump(redis, key, incr) {
        return redis[incr](key);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a Lua pcall INCRBY folding a variable amount', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`local total = redis.pcall('INCRBY', KEYS[1], ARGV[1])\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a Lua INCRBY advancing by a quoted amount other than one', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`local total = redis.call('INCRBY', KEYS[1], '2')\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a client incrby folding a variable amount', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/trial-spend.ts',
      `export async function fold(redis, key, amountNanoUsd) {
        return redis.incrby(key, amountNanoUsd);
      }\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an INCRBY that accrues an amount rather than counting events', () => {
    const project = projectWith(
      'apps/api/src/slices/billing/domain/admission-scripts.ts',
      `export const SCRIPT = \`
        local total = redis.call('INCRBY', KEYS[1], ARGV[1])
        return total
      \`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts an INCRBY carrying no amount at all', () => {
    const project = projectWith(
      QUOTA_PATH,
      `export const SCRIPT = \`local total = redis.call('INCRBY')\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts prose naming INCR in a comment', () => {
    const project = projectWith(
      QUOTA_PATH,
      `// A refusal happens before the quota INCR, so it burns no slot.
      export const noop = 1;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts the rate-limit primitive itself', () => {
    const project = projectWith(
      'apps/api/src/lib/rate-limit/script.ts',
      `export const SCRIPT = \`local count = redis.call('INCR', KEYS[1])\`;\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores test files', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/domain/quota.test.ts',
      `await redis.incr(key);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores spec files', () => {
    const project = projectWith(
      'apps/api/src/slices/chat/domain/quota.spec.ts',
      `await redis.incr(key);\n`
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores files outside the api source tree', () => {
    const project = projectWith('packages/shared/src/notes.ts', `await redis.incr(key);\n`);

    expect(rule.check(project)).toEqual([]);
  });
});
