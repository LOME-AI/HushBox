import { request } from 'node:http';
import { Redis } from '@upstash/redis';
import { afterAll, describe, expect, it } from 'vitest';
import { runKeyScope } from './redis-scope.js';

/**
 * The run scope, end to end against the local Serverless-Redis-HTTP container.
 *
 * The single-run half of the concurrency proof, and the deterministic half: a
 * key with no identity is written through an ordinary client, and the raw
 * connection then shows that NOTHING landed on the unscoped key every
 * concurrent run would otherwise share. Two runs cannot collide on a key
 * neither of them writes.
 *
 * The raw connection is `node:http` rather than a second `fetch`, because the
 * harness has already wrapped the global one: a raw command has to leave this
 * process by a path the scope does not sit on, or it proves nothing.
 *
 * This suite needs the local stack, which is what `pnpm test` brings up.
 */

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') {
    throw new Error(
      `${name} is required for the Redis run-scope integration test — run through \`tsx scripts/with-env.ts\`, which is what loads the env files`
    );
  }
  return value;
}

const REST_URL = requiredEnv('UPSTASH_REDIS_REST_URL');
const REST_TOKEN = requiredEnv('UPSTASH_REDIS_REST_TOKEN');
const RUN_TOKEN = requiredEnv('HB_TEST_RUN_TOKEN');
const SCOPE = runKeyScope(RUN_TOKEN);

/** One command on the connection, outside the scoped global fetch entirely. */
function rawCommand(argv: readonly unknown[]): Promise<unknown> {
  const url = new URL(REST_URL);
  const body = JSON.stringify(argv);
  return new Promise((resolve, reject) => {
    const outbound = request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          authorization: `Bearer ${REST_TOKEN}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => (text += chunk));
        response.on('end', () => {
          const parsed = JSON.parse(text) as { result?: unknown; error?: string };
          if (parsed.error !== undefined) {
            reject(new Error(`raw Redis command failed: ${parsed.error}`));
            return;
          }
          resolve(parsed.result);
        });
      }
    );
    outbound.on('error', reject);
    outbound.end(body);
  });
}

const redis = new Redis({ url: REST_URL, token: REST_TOKEN });

/**
 * One command through the installed scope, written on the wire rather than
 * through a client.
 *
 * The two cases below are about commands the scope CLASSIFIES — a keyspace
 * walk and a keyspace-wide read — and issuing those through a client would be
 * a test reading the store that way, which is what
 * `tests-issue-no-keyspace-wide-redis-command` refuses and what this file has
 * no business doing. The client only assembles this body, so driving the
 * transport exercises exactly the same seam.
 */
async function scopedCommand(argv: readonly unknown[]): Promise<unknown> {
  const response = await fetch(REST_URL, {
    method: 'POST',
    headers: { authorization: `Bearer ${REST_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify(argv),
  });
  const body = (await response.json()) as { result?: unknown; error?: string };
  if (body.error !== undefined) throw new Error(`scoped Redis command failed: ${body.error}`);
  return body.result;
}

/** The namespace this file's keys live in, and the pattern that walks it. */
const PROBE_NAMESPACE = 'run-scope-probe:';
const PROBE_PATTERN = `${PROBE_NAMESPACE}*`;

/**
 * A key built from no identity at all — the shape that forces the scope. The
 * repository's own instance of it is the global trial daily-spend key, built
 * from the calendar day; every concurrent run on the same date builds the same
 * string, and no test-side identity can change that.
 */
const NO_IDENTITY_KEY = `${PROBE_NAMESPACE}global`;

/**
 * The key standing in for another run's, written outside this run's scope and
 * inside the walked namespace: the specimen that makes the walk below a real
 * assertion rather than one nothing could falsify.
 *
 * It carries this run's token so that it is this run's specimen to create and
 * to remove. Named after the namespace alone, every concurrent copy of this
 * file would write and delete one string, and each would be tearing down a
 * specimen another run was still asserting against.
 */
const FOREIGN_KEY = `${PROBE_NAMESPACE}foreign-${RUN_TOKEN}`;

/**
 * A `SCAN` walked to the end of its cursor, deduplicated.
 *
 * `COUNT` is a per-call hint at how many slots the server visits, not a page
 * size, so a keyspace carrying other runs' keys answers the first call with a
 * cursor and no match whatever the pattern selects. An assertion on one call's
 * answer is therefore an assertion about how much of the keyspace every OTHER
 * run happened to be holding, which is the machine-wide property this walk
 * must not depend on. A cursor walked to its end depends on none of it. Redis
 * may return a key twice across a rehash, so the answer is a set.
 */
async function walkToEnd(
  issue: (argv: readonly unknown[]) => Promise<unknown>,
  pattern: string
): Promise<string[]> {
  const found = new Set<string>();
  let cursor = '0';
  do {
    const page = (await issue(['SCAN', cursor, 'MATCH', pattern, 'COUNT', 1000])) as [
      string,
      string[],
    ];
    cursor = page[0];
    for (const key of page[1]) found.add(key);
  } while (cursor !== '0');
  return [...found].toSorted((left, right) => left.localeCompare(right));
}

afterAll(async () => {
  await redis.del(NO_IDENTITY_KEY);
  await rawCommand(['DEL', NO_IDENTITY_KEY]);
});

describe('the run scope, against the live Redis', () => {
  it('reads back what this run wrote to a key with no identity', async () => {
    await redis.set(NO_IDENTITY_KEY, 'written-by-this-run', { ex: 60 });

    await expect(redis.get(NO_IDENTITY_KEY)).resolves.toBe('written-by-this-run');
  });

  it('writes nothing to the unscoped key every concurrent run would share', async () => {
    await redis.set(NO_IDENTITY_KEY, 'written-by-this-run', { ex: 60 });

    await expect(rawCommand(['GET', NO_IDENTITY_KEY])).resolves.toBeNull();
  });

  it("stores the value under this run's own scope", async () => {
    await redis.set(NO_IDENTITY_KEY, 'written-by-this-run', { ex: 60 });

    await expect(rawCommand(['GET', `${SCOPE}${NO_IDENTITY_KEY}`])).resolves.toBe(
      'written-by-this-run'
    );
  });

  it("walks only this run's keys when a scan names a pattern", async () => {
    await redis.set(NO_IDENTITY_KEY, 'written-by-this-run', { ex: 60 });
    await rawCommand(['SET', FOREIGN_KEY, 'written-by-another-run', 'EX', '60']);

    try {
      await expect(walkToEnd(scopedCommand, PROBE_PATTERN)).resolves.toStrictEqual([
        NO_IDENTITY_KEY,
      ]);
    } finally {
      await rawCommand(['DEL', FOREIGN_KEY]);
    }
  });

  /**
   * The control on the walk above. The specimen sits in the walked namespace
   * and outside this run's scope, so a scope that stopped reaching a pattern
   * would return it there and that assertion would fail. Without this, "only
   * this run's keys" would also pass for a walk that reached nothing at all.
   */
  it('reaches the same specimen when the walk is not scoped to this run', async () => {
    await rawCommand(['SET', FOREIGN_KEY, 'written-by-another-run', 'EX', '60']);

    try {
      await expect(walkToEnd(rawCommand, PROBE_PATTERN)).resolves.toContain(FOREIGN_KEY);
    } finally {
      await rawCommand(['DEL', FOREIGN_KEY]);
    }
  });

  it('scopes a key the fixed key fields do not name, by asking the server for it', async () => {
    await redis.set(NO_IDENTITY_KEY, 'written-by-this-run', { ex: 60 });

    await expect(scopedCommand(['OBJECT', 'ENCODING', NO_IDENTITY_KEY])).resolves.toBeTypeOf(
      'string'
    );
    await expect(rawCommand(['OBJECT', 'ENCODING', NO_IDENTITY_KEY])).resolves.toBeNull();
  });

  it('refuses a command that addresses the whole keyspace', async () => {
    await expect(scopedCommand(['DBSIZE'])).rejects.toThrow(/DBSIZE/);
  });
});
