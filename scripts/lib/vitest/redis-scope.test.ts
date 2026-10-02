import { describe, expect, it, vi } from 'vitest';
import {
  applyCommandScope,
  createCommandDescriber,
  createRunScopedFetch,
  decodeCommandShape,
  installRedisRunScope,
  matchPatternPosition,
  needsServerNamedKeys,
  planCommandScope,
  runKeyScope,
  stripScope,
} from './redis-scope.js';
import type { RedisCommandShape } from './redis-scope.js';

/** A command shape as Redis reports one, with the fields a case does not exercise defaulted. */
function shape(overrides: Partial<RedisCommandShape> = {}): RedisCommandShape {
  return {
    firstKey: 1,
    lastKey: 1,
    keyStep: 1,
    movableKeys: false,
    addressesKeyspace: false,
    ...overrides,
  };
}

/** One `COMMAND INFO` row's fields, as the server orders them. */
interface CommandInfoFields {
  readonly name: string;
  readonly firstKey: number;
  readonly lastKey: number;
  readonly step: number;
  readonly flags: readonly string[];
  readonly categories: readonly string[];
}

/** `COMMAND INFO` as the server returns it: one row per name, ten fields per row. */
function commandInfoRow(row: CommandInfoFields): unknown {
  return [row.name, 0, row.flags, row.firstKey, row.lastKey, row.step, row.categories, [], [], []];
}

describe('runKeyScope', () => {
  it('builds a scope that carries the run token', () => {
    expect(runKeyScope('a1b2c3d4e5')).toContain('a1b2c3d4e5');
  });

  it('ends the scope with a separator so a key cannot merge into it', () => {
    expect(runKeyScope('a1b2c3d4e5').endsWith(':')).toBe(true);
  });

  it('refuses a token that is not the harness-minted shape', () => {
    expect(() => runKeyScope('Not A Token')).toThrow(/run token/);
  });
});

describe('decodeCommandShape', () => {
  it('reads the key positions off a keyed command', () => {
    const decoded = decodeCommandShape(
      commandInfoRow({
        name: 'del',
        firstKey: 1,
        lastKey: -1,
        step: 1,
        flags: ['write'],
        categories: ['@keyspace', '@write'],
      })
    );

    expect(decoded).toMatchObject({ firstKey: 1, lastKey: -1, keyStep: 1 });
  });

  it('reports a command Redis places in the keyspace category as addressing the keyspace', () => {
    const decoded = decodeCommandShape(
      commandInfoRow({
        name: 'scan',
        firstKey: 0,
        lastKey: 0,
        step: 0,
        flags: ['readonly'],
        categories: ['@keyspace', '@read'],
      })
    );

    expect(decoded.addressesKeyspace).toBe(true);
  });

  it('reports a connection-level command as addressing no keyspace', () => {
    const decoded = decodeCommandShape(
      commandInfoRow({
        name: 'ping',
        firstKey: 0,
        lastKey: 0,
        step: 0,
        flags: ['fast'],
        categories: ['@fast', '@connection'],
      })
    );

    expect(decoded.addressesKeyspace).toBe(false);
  });

  it('reports the movable-keys flag', () => {
    const decoded = decodeCommandShape(
      commandInfoRow({
        name: 'eval',
        firstKey: 0,
        lastKey: 0,
        step: 0,
        flags: ['movablekeys'],
        categories: ['@slow', '@scripting'],
      })
    );

    expect(decoded.movableKeys).toBe(true);
  });

  it('throws when the server reports no such command', () => {
    expect(() => decodeCommandShape(null)).toThrow(/unknown/i);
  });

  it('throws when a key-position field is not a number', () => {
    expect(() => decodeCommandShape(['get', 2, ['readonly'], 'one', 1, 1, [], [], [], []])).toThrow(
      /not a number/
    );
  });

  it('reads absent flags as no flags rather than failing', () => {
    const decoded = decodeCommandShape(['get', 2, undefined, 1, 1, 1, undefined, [], [], []]);

    expect(decoded).toMatchObject({ movableKeys: false, addressesKeyspace: false });
  });
});

describe('matchPatternPosition', () => {
  it('finds the argument a MATCH token introduces', () => {
    expect(matchPatternPosition(['scan', 0, 'match', 'hold:*', 'count', 100])).toBe(3);
  });

  it('reads the token case-insensitively', () => {
    expect(matchPatternPosition(['scan', 0, 'MATCH', 'hold:*'])).toBe(3);
  });

  it('returns undefined when the command carries no MATCH', () => {
    expect(matchPatternPosition(['scan', 0, 'count', 100])).toBeUndefined();
  });

  it('returns undefined when MATCH is the last argument', () => {
    expect(matchPatternPosition(['scan', 0, 'match'])).toBeUndefined();
  });
});

describe('needsServerNamedKeys', () => {
  it('asks for a command whose key positions move with its arguments', () => {
    expect(
      needsServerNamedKeys(shape({ firstKey: 0, lastKey: 0, keyStep: 0, movableKeys: true }))
    ).toBe(true);
  });

  it('asks for a command whose fixed fields name no key and which addresses no keyspace', () => {
    expect(needsServerNamedKeys(shape({ firstKey: 0, lastKey: 0, keyStep: 0 }))).toBe(true);
  });

  it('does not ask for a command whose fixed fields already name its key', () => {
    expect(needsServerNamedKeys(shape())).toBe(false);
  });

  it('does not ask for a keyless command that addresses the keyspace', () => {
    expect(
      needsServerNamedKeys(shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true }))
    ).toBe(false);
  });
});

describe('planCommandScope', () => {
  it('scopes the fixed key positions of a keyed command', () => {
    const plan = planCommandScope(['set', 'k', 'v'], shape());

    expect(plan).toStrictEqual({ kind: 'keys', positions: [1] });
  });

  it('walks a variadic key range to the end of the argument list', () => {
    const plan = planCommandScope(['del', 'a', 'b', 'c'], shape({ lastKey: -1 }));

    expect(plan).toStrictEqual({ kind: 'keys', positions: [1, 2, 3] });
  });

  it('steps over the values of an alternating key/value command', () => {
    const plan = planCommandScope(['mset', 'a', '1', 'b', '2'], shape({ lastKey: -1, keyStep: 2 }));

    expect(plan).toStrictEqual({ kind: 'keys', positions: [1, 3] });
  });

  it('takes the key positions of a movable-keys command from the keys the server names', () => {
    const plan = planCommandScope(
      ['eval', 'return 1', 2, 'k1', 'k2', 'arg'],
      shape({ firstKey: 0, lastKey: 0, keyStep: 0, movableKeys: true }),
      ['k1', 'k2']
    );

    expect(plan).toStrictEqual({ kind: 'keys', positions: [3, 4] });
  });

  it('throws when the server names a key the command does not carry', () => {
    expect(() =>
      planCommandScope(
        ['eval', 'return 1', 1, 'k1'],
        shape({ firstKey: 0, lastKey: 0, keyStep: 0, movableKeys: true }),
        ['absent']
      )
    ).toThrow(/not in the command/);
  });

  it('scopes the pattern of a keyless keyspace command', () => {
    const plan = planCommandScope(
      ['scan', 0, 'match', 'hold:*'],
      shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true })
    );

    expect(plan).toStrictEqual({ kind: 'pattern', position: 3 });
  });

  it('refuses a keyless keyspace command that names no pattern', () => {
    const plan = planCommandScope(
      ['flushall'],
      shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true })
    );

    expect(plan).toMatchObject({ kind: 'unscopable' });
  });

  it('scopes the key of a container command, which only the server can find', () => {
    const plan = planCommandScope(
      ['object', 'encoding', 'k'],
      shape({ firstKey: 0, lastKey: 0, keyStep: 0 }),
      ['k']
    );

    expect(plan).toStrictEqual({ kind: 'keys', positions: [2] });
  });

  it('passes a keyless command that addresses no keyspace straight through', () => {
    const plan = planCommandScope(['ping'], shape({ firstKey: 0, lastKey: 0, keyStep: 0 }), []);

    expect(plan).toStrictEqual({ kind: 'passthrough' });
  });
});

describe('applyCommandScope', () => {
  it('prefixes every key position and leaves the values alone', () => {
    const scoped = applyCommandScope(['set', 'k', 'k'], { kind: 'keys', positions: [1] }, 'r:');

    expect(scoped).toStrictEqual(['set', 'r:k', 'k']);
  });

  it('prefixes a pattern so the walk sees only this run', () => {
    const scoped = applyCommandScope(
      ['scan', 0, 'match', 'hold:*'],
      { kind: 'pattern', position: 3 },
      'r:'
    );

    expect(scoped).toStrictEqual(['scan', 0, 'match', 'r:hold:*']);
  });

  it('leaves a passthrough command byte-identical', () => {
    const argv = ['ping'];

    expect(applyCommandScope(argv, { kind: 'passthrough' }, 'r:')).toStrictEqual(argv);
  });

  it('throws when a key position does not hold a string', () => {
    expect(() =>
      applyCommandScope(['set', 7, 'v'], { kind: 'keys', positions: [1] }, 'r:')
    ).toThrow(/key/i);
  });
});

describe('stripScope', () => {
  it('removes the scope from a returned key', () => {
    expect(stripScope('r:hold:1', 'r:', (text) => text)).toBe('hold:1');
  });

  it('leaves a string that never carried the scope alone', () => {
    expect(stripScope('hold:1', 'r:', (text) => text)).toBe('hold:1');
  });

  it('walks into the cursor-and-keys pair a scan returns', () => {
    expect(stripScope(['12', ['r:a', 'r:b']], 'r:', (text) => text)).toStrictEqual([
      '12',
      ['a', 'b'],
    ]);
  });

  it('leaves a non-string inside a walk result alone', () => {
    expect(stripScope([0, ['r:a']], 'r:', (text) => text)).toStrictEqual([0, ['a']]);
  });

  it('decodes and re-encodes when the response carries encoded strings', () => {
    const decode = (text: string): string => Buffer.from(text, 'base64').toString('binary');
    const encode = (text: string): string => Buffer.from(text, 'binary').toString('base64');
    const encoded = encode('r:hold:1');

    expect(stripScope(encoded, 'r:', decode, encode)).toBe(encode('hold:1'));
  });
});

describe('createCommandDescriber', () => {
  it('asks the server once per command name', async () => {
    const issue = vi.fn((argv: readonly unknown[]) => {
      expect(argv).toStrictEqual(['COMMAND', 'INFO', 'get']);
      return Promise.resolve([
        commandInfoRow({
          name: 'get',
          firstKey: 1,
          lastKey: 1,
          step: 1,
          flags: ['readonly'],
          categories: ['@read'],
        }),
      ]);
    });
    const describe_ = createCommandDescriber();

    await describe_(['get', 'a'], issue);
    await describe_(['get', 'b'], issue);

    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('asks the server for the keys of a movable-keys command every time', async () => {
    const issue = vi.fn((argv: readonly unknown[]) =>
      Promise.resolve(
        argv[1] === 'INFO'
          ? [
              commandInfoRow({
                name: 'eval',
                firstKey: 0,
                lastKey: 0,
                step: 0,
                flags: ['movablekeys'],
                categories: ['@scripting'],
              }),
            ]
          : ['k1']
      )
    );
    const describe_ = createCommandDescriber();

    const described = await describe_(['eval', 's', 1, 'k1'], issue);

    expect(described.serverNamedKeys).toStrictEqual(['k1']);
    expect(issue).toHaveBeenCalledWith(['COMMAND', 'GETKEYS', 'eval', 's', 1, 'k1']);
  });

  it('reads an unusable GETKEYS answer as no keys', async () => {
    const issue = vi.fn((argv: readonly unknown[]) =>
      Promise.resolve(
        argv[1] === 'INFO'
          ? [
              commandInfoRow({
                name: 'eval',
                firstKey: 0,
                lastKey: 0,
                step: 0,
                flags: ['movablekeys'],
                categories: ['@scripting'],
              }),
            ]
          : 'not a list'
      )
    );
    const describe_ = createCommandDescriber();

    const described = await describe_(['eval', 's', 0], issue);

    expect(described.serverNamedKeys).toStrictEqual([]);
  });

  it('asks the server for the keys of a command whose fixed fields name none', async () => {
    const issue = vi.fn((argv: readonly unknown[]) =>
      Promise.resolve(
        argv[1] === 'INFO'
          ? [
              commandInfoRow({
                name: 'object',
                firstKey: 0,
                lastKey: 0,
                step: 0,
                flags: [],
                categories: ['@slow'],
              }),
            ]
          : ['k']
      )
    );
    const describe_ = createCommandDescriber();

    const described = await describe_(['object', 'encoding', 'k'], issue);

    expect(described.serverNamedKeys).toStrictEqual(['k']);
    expect(issue).toHaveBeenCalledWith(['COMMAND', 'GETKEYS', 'object', 'encoding', 'k']);
  });

  it('reads the no-key-arguments answer as a command that carries no key', async () => {
    const issue = vi.fn((argv: readonly unknown[]) =>
      argv[1] === 'INFO'
        ? Promise.resolve([
            commandInfoRow({
              name: 'ping',
              firstKey: 0,
              lastKey: 0,
              step: 0,
              flags: ['fast'],
              categories: ['@fast', '@connection'],
            }),
          ])
        : Promise.reject(
            new Error('redis-scope: GETKEYS ping failed: ERR The command has no key arguments')
          )
    );
    const describe_ = createCommandDescriber();

    const described = await describe_(['ping'], issue);

    expect(described.serverNamedKeys).toStrictEqual([]);
  });

  it('lets any other GETKEYS failure through rather than guessing at the keys', async () => {
    const issue = vi.fn((argv: readonly unknown[]) =>
      argv[1] === 'INFO'
        ? Promise.resolve([
            commandInfoRow({
              name: 'object',
              firstKey: 0,
              lastKey: 0,
              step: 0,
              flags: [],
              categories: ['@slow'],
            }),
          ])
        : Promise.reject(
            new Error('redis-scope: GETKEYS object failed: ERR Invalid command specified')
          )
    );
    const describe_ = createCommandDescriber();

    await expect(describe_(['object', 'encoding'], issue)).rejects.toThrow(/Invalid command/);
  });

  it('throws when the server describes nothing at all', async () => {
    const issue = vi.fn(() => Promise.resolve('not a row list'));
    const describe_ = createCommandDescriber();

    await expect(describe_(['nope'], issue)).rejects.toThrow(/unknown/i);
  });
});

/** The body the scoped fetch put on the wire, as the string it must always be. */
function sentBody(init: RequestInit | undefined): string {
  const body = init?.body;
  if (typeof body !== 'string') {
    throw new TypeError('the scoped fetch must send a string body');
  }
  return body;
}

/** A JSON response shaped as the Upstash REST endpoint shapes one. */
function jsonResponse(body: unknown): Response {
  return Response.json(body);
}

const ENDPOINT = 'http://localhost:10900';

describe('createRunScopedFetch', () => {
  it('scopes the key of a single command', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ result: 'v' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(ENDPOINT, { method: 'POST', body: JSON.stringify(['get', 'k']) });

    expect(JSON.parse(sentBody(inner.mock.calls[0]?.[1]))).toStrictEqual(['get', 'r:k']);
  });

  it('scopes a container command, whose key the fixed fields do not name', async () => {
    const inner = vi.fn<typeof globalThis.fetch>((_input, init) => {
      const argv = JSON.parse(sentBody(init)) as unknown[];
      if (argv[1] === 'INFO') {
        return Promise.resolve(
          jsonResponse({
            result: [
              commandInfoRow({
                name: 'object',
                firstKey: 0,
                lastKey: 0,
                step: 0,
                flags: [],
                categories: ['@slow'],
              }),
            ],
          })
        );
      }
      if (argv[1] === 'GETKEYS') return Promise.resolve(jsonResponse({ result: ['k'] }));
      return Promise.resolve(jsonResponse({ result: 'embstr' }));
    });
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: createCommandDescriber(),
    });

    await scoped(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(['object', 'encoding', 'k']),
    });

    const sent = inner.mock.calls.map((call) => JSON.parse(sentBody(call[1])) as unknown[]);
    expect(sent.at(-1)).toStrictEqual(['object', 'encoding', 'r:k']);
  });

  it('scopes every command of a pipeline', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse([{ result: 'v' }, { result: 1 }]))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(`${ENDPOINT}/pipeline`, {
      method: 'POST',
      body: JSON.stringify([
        ['get', 'a'],
        ['del', 'b'],
      ]),
    });

    expect(JSON.parse(sentBody(inner.mock.calls[0]?.[1]))).toStrictEqual([
      ['get', 'r:a'],
      ['del', 'r:b'],
    ]);
  });

  it('strips the scope off the keys a scoped walk returns', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ result: ['0', ['r:hold:1']] }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () =>
        Promise.resolve({
          shape: shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true }),
        }),
    });

    const response = await scoped(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(['scan', 0, 'match', 'hold:*']),
    });

    expect(await response.json()).toStrictEqual({ result: ['0', ['hold:1']] });
  });

  it('refuses a command that cannot be scoped, naming it', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ result: 'OK' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () =>
        Promise.resolve({
          shape: shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true }),
        }),
    });

    await expect(
      scoped(ENDPOINT, { method: 'POST', body: JSON.stringify(['flushall']) })
    ).rejects.toThrow(/flushall/);
    expect(inner).not.toHaveBeenCalled();
  });

  it('passes a request to any other host through untouched', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => {
        throw new Error('the describer must not be reached for a non-Redis request');
      },
    });

    await scoped('http://localhost:13500/chat', { method: 'POST', body: '["get","k"]' });

    expect(sentBody(inner.mock.calls[0]?.[1])).toBe('["get","k"]');
  });

  it('passes a Redis request carrying no command body through untouched', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => {
        throw new Error('the describer must not be reached for a bodyless request');
      },
    });

    await scoped(ENDPOINT, { method: 'GET' });

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('scopes a request whose body is encoded, and strips the scope back off', async () => {
    const encode = (text: string): string => Buffer.from(text, 'binary').toString('base64');
    const inner = vi.fn(() =>
      Promise.resolve(jsonResponse({ result: ['0', [encode('r:hold:1')]] }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () =>
        Promise.resolve({
          shape: shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true }),
        }),
    });

    const response = await scoped(ENDPOINT, {
      method: 'POST',
      headers: { 'Upstash-Encoding': 'base64' },
      body: JSON.stringify(['scan', 0, 'match', 'hold:*']),
    });

    expect(await response.json()).toStrictEqual({ result: ['0', [encode('hold:1')]] });
  });

  it('rejects when the server cannot describe the command', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ error: 'ERR unknown command' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: async (_argv, issue) => {
        await issue(['COMMAND', 'INFO', 'nope']);
        return { shape: shape() };
      },
    });

    await expect(
      scoped(ENDPOINT, { method: 'POST', body: JSON.stringify(['nope', 'k']) })
    ).rejects.toThrow(/unknown command/);
  });

  it('passes a body that is not JSON through untouched', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(ENDPOINT, { method: 'POST', body: 'not json at all' });

    expect(sentBody(inner.mock.calls[0]?.[1])).toBe('not json at all');
  });

  it('passes a JSON body that is not a command through untouched', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(ENDPOINT, { method: 'POST', body: '{"not":"a command"}' });

    expect(sentBody(inner.mock.calls[0]?.[1])).toBe('{"not":"a command"}');
  });

  it('passes a batch whose entries are not all commands through untouched', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(ENDPOINT, { method: 'POST', body: '[["get","k"],"stray"]' });

    expect(sentBody(inner.mock.calls[0]?.[1])).toBe('[["get","k"],"stray"]');
  });

  it('reads the target off a URL object', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ result: 'v' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(new URL(ENDPOINT), { method: 'POST', body: JSON.stringify(['get', 'k']) });

    expect(JSON.parse(sentBody(inner.mock.calls[0]?.[1]))).toStrictEqual(['get', 'r:k']);
  });

  it('reads the target off a Request object', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ result: 'v' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(new Request(ENDPOINT, { method: 'POST' }), {
      method: 'POST',
      body: JSON.stringify(['get', 'k']),
    });

    expect(JSON.parse(sentBody(inner.mock.calls[0]?.[1]))).toStrictEqual(['get', 'r:k']);
  });

  it('leaves a walk whose response is not a result envelope as it stands', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse('bare')));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () =>
        Promise.resolve({
          shape: shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true }),
        }),
    });

    const response = await scoped(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(['scan', 0, 'match', 'hold:*']),
    });

    await expect(response.json()).resolves.toBe('bare');
  });

  it('strips the scope off the keys a scoped walk returns inside a batch', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse([{ result: ['0', ['r:hold:1']] }, { result: ['0', []] }]))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () =>
        Promise.resolve({
          shape: shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true }),
        }),
    });

    const response = await scoped(`${ENDPOINT}/pipeline`, {
      method: 'POST',
      body: JSON.stringify([
        ['scan', 0, 'match', 'hold:*'],
        ['scan', 0, 'match', 'seat:*'],
      ]),
    });

    await expect(response.json()).resolves.toStrictEqual([
      { result: ['0', ['hold:1']] },
      { result: ['0', []] },
    ]);
  });

  it('leaves the result of a keyed command in a batch as it stands', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse([{ result: 'r:not-a-key' }, { result: ['0', ['r:hold:1']] }]))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: (argv) =>
        Promise.resolve({
          shape:
            argv[0] === 'scan'
              ? shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true })
              : shape(),
        }),
    });

    const response = await scoped(`${ENDPOINT}/pipeline`, {
      method: 'POST',
      body: JSON.stringify([
        ['get', 'k'],
        ['scan', 0, 'match', 'hold:*'],
      ]),
    });

    await expect(response.json()).resolves.toStrictEqual([
      { result: 'r:not-a-key' },
      { result: ['0', ['hold:1']] },
    ]);
  });

  it('leaves a batch whose entries are not results as it stands', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse(['bare', { result: ['0', ['r:hold:1']] }]))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () =>
        Promise.resolve({
          shape: shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true }),
        }),
    });

    const response = await scoped(`${ENDPOINT}/pipeline`, {
      method: 'POST',
      body: JSON.stringify([
        ['scan', 0, 'match', 'hold:*'],
        ['scan', 0, 'match', 'seat:*'],
      ]),
    });

    await expect(response.json()).resolves.toStrictEqual(['bare', { result: ['0', ['r:hold:1']] }]);
  });

  it('leaves a walked command whose entry carries no result as it stands', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ error: 'ERR the walk failed' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () =>
        Promise.resolve({
          shape: shape({ firstKey: 0, lastKey: 0, keyStep: 0, addressesKeyspace: true }),
        }),
    });

    const response = await scoped(ENDPOINT, {
      method: 'POST',
      body: JSON.stringify(['scan', 0, 'match', 'hold:*']),
    });

    await expect(response.json()).resolves.toStrictEqual({ error: 'ERR the walk failed' });
  });

  it('refuses a body it cannot read as text rather than sending its keys bare', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => {
        throw new Error('the describer must not be reached for an unreadable body');
      },
    });

    const bytes = new TextEncoder().encode(JSON.stringify(['get', 'k']));

    await expect(scoped(ENDPOINT, { method: 'POST', body: bytes })).rejects.toThrow(/cannot read/i);
    expect(inner).not.toHaveBeenCalled();
  });

  it('leaves a body it cannot read as text alone when it is bound for another host', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => {
        throw new Error('the describer must not be reached for another host');
      },
    });

    const bytes = new TextEncoder().encode('anything at all');
    await scoped('http://localhost:10901/upload', { method: 'POST', body: bytes });

    expect(inner.mock.calls[0]?.[1]?.body).toBe(bytes);
  });

  it('reads the body off the Request when the init nulls its own out', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ result: 'v' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(['get', 'k']) }), {
      body: null,
    });

    expect(JSON.parse(sentBody(inner.mock.calls[0]?.[1]))).toStrictEqual(['get', 'r:k']);
  });

  it('passes a Request carrying no body through untouched', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() => Promise.resolve(jsonResponse({ ok: true })));
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => {
        throw new Error('the describer must not be reached for a bodyless Request');
      },
    });

    await scoped(new Request(ENDPOINT, { method: 'GET' }));

    expect(inner).toHaveBeenCalledTimes(1);
  });

  it('scopes a command whose body rides on the Request object', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ result: 'v' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: () => Promise.resolve({ shape: shape() }),
    });

    await scoped(new Request(ENDPOINT, { method: 'POST', body: JSON.stringify(['get', 'k']) }));

    expect(JSON.parse(sentBody(inner.mock.calls[0]?.[1]))).toStrictEqual(['get', 'r:k']);
  });

  it('describes on the connection whose credentials ride on the Request object', async () => {
    const inner = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(jsonResponse({ result: 'v' }))
    );
    const scoped = createRunScopedFetch({
      fetch: inner,
      endpoint: ENDPOINT,
      scope: 'r:',
      describe: async (_argv, issue) => {
        await issue(['COMMAND', 'INFO', 'get']);
        return { shape: shape() };
      },
    });

    await scoped(
      new Request(ENDPOINT, {
        method: 'POST',
        headers: { authorization: 'Bearer secret' },
        body: JSON.stringify(['get', 'k']),
      })
    );

    expect(new Headers(inner.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      'Bearer secret'
    );
  });
});

describe('installRedisRunScope', () => {
  it('installs nothing when no run token is set — the production path', () => {
    const original = vi.fn();
    const scope_ = { fetch: original } as unknown as { fetch: typeof globalThis.fetch };

    installRedisRunScope({ UPSTASH_REDIS_REST_URL: ENDPOINT }, scope_);

    expect(scope_.fetch).toBe(original);
  });

  it('installs nothing when no Redis endpoint is configured', () => {
    const original = vi.fn();
    const scope_ = { fetch: original } as unknown as { fetch: typeof globalThis.fetch };

    installRedisRunScope({ HB_TEST_RUN_TOKEN: 'a1b2c3d4e5' }, scope_);

    expect(scope_.fetch).toBe(original);
  });

  it('wraps fetch when the harness gave the run both a token and an endpoint', () => {
    const original = vi.fn();
    const scope_ = { fetch: original } as unknown as { fetch: typeof globalThis.fetch };

    installRedisRunScope(
      { HB_TEST_RUN_TOKEN: 'a1b2c3d4e5', UPSTASH_REDIS_REST_URL: ENDPOINT },
      scope_
    );

    expect(scope_.fetch).not.toBe(original);
  });
});
