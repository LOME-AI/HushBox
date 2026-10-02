import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { STACK_MODES, type StackMode } from './port-plan.js';
import { redisCommand } from './srh-command.js';
import { envModeForStack } from './stack-mode.js';
import { tokenFor } from './srh-tokens.js';

/**
 * That the stacks share no Redis, executed rather than reasoned about.
 *
 * Isolation is a property of the CONNECTION: the local Serverless-Redis-HTTP
 * container fronts one logical database per bearer token, every client takes
 * its token from the env registry, and which registry entry a run reads is
 * decided by the stack it selected. So the chain this asserts — stack, to the
 * mode that writes it, to that mode's token, to a keyspace — is the whole of
 * what keeps a `pnpm test` out of a running `pnpm dev`'s data.
 *
 * It needs the local stack, which is what `pnpm test` brings up.
 */

function requireRestUrl(): string {
  const url = process.env['UPSTASH_REDIS_REST_URL'];
  if (url === undefined || url === '') {
    throw new Error(
      'UPSTASH_REDIS_REST_URL is required for the stack Redis-isolation test — run vitest through `tsx scripts/with-env.ts`, which is what loads the env files'
    );
  }
  return url;
}

const REST_URL = requireRestUrl();

/** The token a run of that stack reaches Redis with. */
function stackToken(stackMode: StackMode): string {
  return tokenFor(envModeForStack(stackMode));
}

/**
 * One Upstash-REST command on the connection the bearer token selects.
 *
 * The helper's own bound is what keeps a proxy that takes the connection and
 * never answers from expiring the runner's budget and reading as a starved
 * worker; the case declares none of its own, because a case-level budget can
 * only be reached by starvation the bound has already ruled out.
 */
async function command(token: string, argv: readonly [string, ...string[]]): Promise<unknown> {
  return redisCommand(REST_URL, token, argv);
}

describe('Redis isolation between stacks', () => {
  it('gives every stack a token no other stack holds', () => {
    const tokens = STACK_MODES.map((stackMode) => stackToken(stackMode));

    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it.each([...STACK_MODES])(
    'hides a key written on the %s stack from every other stack',
    async (writer: StackMode) => {
      const key = `stack-isolation-probe:${randomUUID()}`;
      const token = stackToken(writer);

      // Expiring, like every key the key registry mints: the `finally` removes it
      // on every path this process controls, and the TTL covers the one it does not.
      await command(token, ['SET', key, `written-on-${writer}`, 'EX', '60']);
      try {
        await expect(command(token, ['GET', key])).resolves.toBe(`written-on-${writer}`);
        for (const reader of STACK_MODES.filter((stackMode) => stackMode !== writer)) {
          await expect(command(stackToken(reader), ['GET', key])).resolves.toBeNull();
        }
      } finally {
        await command(token, ['DEL', key]);
      }
    }
  );
});
