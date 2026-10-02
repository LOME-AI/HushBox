import { Project, SyntaxKind } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { isOne } from './event-counting.js';
import {
  LUA_CALL,
  REDIS_REGISTRY_OPERATIONS,
  calledMember,
  luaDispatches,
  receiverTailNamesRedis,
  receiverTextNamesRedis,
  scriptLiterals,
  templateText,
} from './redis-calls.js';
import type { CallExpression, Node, SourceFile, TemplateExpression } from 'ts-morph';

/** The command names a script's dispatches carry, in source order. */
function commandsIn(script: string): string[] {
  return [...script.matchAll(LUA_CALL)].map((match) => match.groups?.['command'] ?? '');
}

/** A snippet parsed the way the rules parse a file. */
function sourceOf(code: string): SourceFile {
  return new Project({ useInMemoryFileSystem: true }).createSourceFile('snippet.ts', code);
}

/** The one call expression in a snippet. */
function firstCall(code: string): CallExpression {
  return sourceOf(code).getDescendantsOfKind(SyntaxKind.CallExpression)[0]!;
}

/** The receiver of the one member call in a snippet. */
function firstReceiver(code: string): Node {
  return calledMember(firstCall(code))!.receiver;
}

/** The one interpolated template in a snippet. */
function firstTemplate(code: string): TemplateExpression {
  return sourceOf(code).getDescendantsOfKind(SyntaxKind.TemplateExpression)[0]!;
}

describe('LUA_CALL', () => {
  it('captures the command of a dispatch', () => {
    expect(commandsIn(`redis.call('INCR', KEYS[1])`)).toEqual(['INCR']);
  });

  it('captures a dispatch under the server alias and the pcall spelling', () => {
    expect(commandsIn(`server.pcall("DECR", KEYS[1])`)).toEqual(['DECR']);
  });

  it('captures a dispatch reached by index rather than by field', () => {
    expect(commandsIn(`redis['call']('INCRBY', KEYS[1], 1)`)).toEqual(['INCRBY']);
  });

  it('captures a dispatch written with space around its member access', () => {
    expect(commandsIn(`redis . call ('INCR', KEYS[1])`)).toEqual(['INCR']);
  });

  it('captures a nested dispatch in its own right, ending each match at its command', () => {
    expect(commandsIn(`redis.call('SET', KEYS[2], redis.call('INCR', KEYS[1]))`)).toEqual([
      'SET',
      'INCR',
    ]);
  });

  it('captures a dispatch spelled in uppercase', () => {
    expect(commandsIn(`REDIS.CALL('INCR', KEYS[1])`)).toEqual(['INCR']);
  });

  it('leaves out a dispatch whose command is a variable rather than a quoted name', () => {
    expect(commandsIn('redis.call(ARGV[1], KEYS[1])')).toEqual([]);
  });
});

describe('luaDispatches', () => {
  it('lower-cases the command, because Redis reads command names either way', () => {
    expect(luaDispatches(`REDIS.CALL('INCR', KEYS[1])`).map((d) => d.command)).toEqual(['incr']);
  });

  it('points past the command name, at the rest of the argument list', () => {
    const script = `redis.call('INCRBY', KEYS[1], 1)`;
    const [dispatch] = luaDispatches(script);
    expect(script.slice(dispatch!.argumentsAt)).toBe(`, KEYS[1], 1)`);
  });

  it('decodes each dispatch of a script separately', () => {
    const dispatches = luaDispatches(`redis.call('SET', KEYS[2], redis.call('INCR', KEYS[1]))`);
    expect(dispatches.map((d) => d.command)).toEqual(['set', 'incr']);
  });

  it('finds nothing in a script that dispatches no command', () => {
    expect(luaDispatches('return tonumber(ARGV[1])')).toEqual([]);
  });
});

describe('REDIS_REGISTRY_OPERATIONS', () => {
  it('carries the whole published registry, so a rule can only select out of it', () => {
    expect([...REDIS_REGISTRY_OPERATIONS]).toEqual([
      'redisDel',
      'redisGet',
      'redisGetDel',
      'redisMGet',
      'redisMGetEntry',
      'redisSet',
      'redisSetNx',
      'redisTtl',
    ]);
  });
});

describe('templateText', () => {
  it('reads a template as one script, each hole stood in for', () => {
    const template = firstTemplate(
      'const s = `redis.call("HINCRBY", ${key}, "attempts", ${amount})`;'
    );
    expect(templateText(template)).toBe('redis.call("HINCRBY", HOLE, "attempts", HOLE)');
  });

  it('keeps a command name from closing up across a hole', () => {
    const template = firstTemplate('const s = `redis.call("INC${part}BY", KEYS[1], 1)`;');
    expect(templateText(template)).toBe('redis.call("INCHOLEBY", KEYS[1], 1)');
  });

  it('stands in for a hole with text that does not read as an amount of one', () => {
    const template = firstTemplate('const s = `${amount}`;');
    expect(isOne(templateText(template))).toBe(false);
  });
});

describe('calledMember', () => {
  it('names a method reached by field', () => {
    expect(calledMember(firstCall('redis.incr(key);'))?.name).toBe('incr');
  });

  it('names a method reached by string index', () => {
    expect(calledMember(firstCall("redis['incr'](key);"))?.name).toBe('incr');
  });

  it('names the receiver a method reached by field is called on', () => {
    expect(calledMember(firstCall('limiter.incr(key);'))?.receiver.getText()).toBe('limiter');
  });

  it('names the receiver a method reached by string index is called on', () => {
    expect(calledMember(firstCall("limiter['incr'](key);"))?.receiver.getText()).toBe('limiter');
  });

  it('leaves out a method named by a computed index', () => {
    expect(calledMember(firstCall('redis[command](key);'))).toBeUndefined();
  });

  it('leaves out a call reaching no member at all', () => {
    expect(calledMember(firstCall('incr(key);'))).toBeUndefined();
  });
});

describe('scriptLiterals', () => {
  it('reads a plain string literal as a script', () => {
    const scripts = scriptLiterals(sourceOf(`const s = "redis.call('INCR', KEYS[1])";`));
    expect(scripts.map((script) => script.text)).toEqual([`redis.call('INCR', KEYS[1])`]);
  });

  it('reads a template carrying no substitutions as a script', () => {
    const scripts = scriptLiterals(sourceOf('const s = `redis.call("INCR", KEYS[1])`;'));
    expect(scripts.map((script) => script.text)).toEqual(['redis.call("INCR", KEYS[1])']);
  });

  it('reads an interpolated template as one script, each hole stood in for', () => {
    const scripts = scriptLiterals(sourceOf('const s = `redis.call("INCRBY", ${key}, 1)`;'));
    expect(scripts.map((script) => script.text)).toEqual(['redis.call("INCRBY", HOLE, 1)']);
  });

  it('carries the node each script was written on, for the line a rule reports', () => {
    const scripts = scriptLiterals(sourceOf(['const a = 1;', '', 'const s = "INCR";'].join('\n')));
    expect(scripts.map((script) => script.node.getStartLineNumber())).toEqual([3]);
  });
});

describe('receiverTextNamesRedis', () => {
  it('reads a client bound to a bare name', () => {
    expect(receiverTextNamesRedis(firstReceiver('redis.set(key, hold);'))).toBe(true);
  });

  it('reads a client reached through a dependency object', () => {
    expect(receiverTextNamesRedis(firstReceiver('deps.redis.set(key, hold);'))).toBe(true);
  });

  it('reads a client a receiver is assembled out of', () => {
    expect(receiverTextNamesRedis(firstReceiver('withClient(deps.redis).set(key, hold);'))).toBe(
      true
    );
  });

  it('reads a chain naming a client only in an argument', () => {
    expect(
      receiverTextNamesRedis(
        firstReceiver("new Hono().post('/a', (c) => read(deps.redis)).post('/b', handler);")
      )
    ).toBe(true);
  });

  it('leaves out a receiver naming no client', () => {
    expect(receiverTextNamesRedis(firstReceiver("pattern.exec('a:b');"))).toBe(false);
  });
});

describe('receiverTailNamesRedis', () => {
  it('reads a client bound to a bare name', () => {
    expect(receiverTailNamesRedis(firstReceiver('redis.set(key, hold);'))).toBe(true);
  });

  it('reads a client reached through a dependency object', () => {
    expect(receiverTailNamesRedis(firstReceiver('deps.redis.set(key, hold);'))).toBe(true);
  });

  it('reads through a builder chained off a client', () => {
    expect(
      receiverTailNamesRedis(firstReceiver('deps.redis.createScript(script).exec(keys, args);'))
    ).toBe(true);
  });

  it('leaves out a chain naming a client only in an argument', () => {
    expect(
      receiverTailNamesRedis(
        firstReceiver("new Hono().post('/a', (c) => read(deps.redis)).post('/b', handler);")
      )
    ).toBe(false);
  });

  it('leaves out a receiver assembled by a call reaching no member', () => {
    expect(receiverTailNamesRedis(firstReceiver('withClient(deps.redis).set(key, hold);'))).toBe(
      false
    );
  });

  it('leaves out a receiver naming no client', () => {
    expect(receiverTailNamesRedis(firstReceiver("pattern.exec('a:b');"))).toBe(false);
  });
});
