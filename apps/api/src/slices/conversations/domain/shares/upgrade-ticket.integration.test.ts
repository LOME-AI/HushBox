import { Redis } from '@upstash/redis';
import { describe, expect, it } from 'vitest';
import {
  UPGRADE_TICKET_KEY,
  consumeUpgradeTicket,
  freshUpgradeTicketGrant,
  hashUpgradeTicket,
  mintUpgradeTicket,
} from './upgrade-ticket.js';

const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('UPSTASH_REDIS_REST_* are required for the upgrade ticket tests');
}

const redis = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });

// A client whose every call fails fast: nothing listens on the discard port.
const unreachableRedis = new Redis({ url: 'http://127.0.0.1:9', token: 'unused', retry: false });

function grant(): { linkId: string; conversationId: string } {
  return { linkId: crypto.randomUUID(), conversationId: crypto.randomUUID() };
}

async function minted(value = grant(), client: Redis = redis): Promise<string> {
  const ticket = await mintUpgradeTicket(client, value);
  return ticket._unsafeUnwrap();
}

async function hashOf(ticket: string): Promise<string> {
  const hash = await hashUpgradeTicket(ticket);
  return hash._unsafeUnwrap();
}

async function storedKeyOf(ticket: string): Promise<string> {
  return UPGRADE_TICKET_KEY.buildKey(await hashOf(ticket));
}

/**
 * A live client that records every command it sends, as the wire carries it. A
 * test may not walk the shared keyspace, so what a mint could have left in Redis
 * is read off the commands the mint itself issued: it is the only writer.
 */
function recordingRedis(): { readonly client: Redis; readonly commands: unknown[] } {
  const client = new Redis({ url: UPSTASH_REDIS_REST_URL, token: UPSTASH_REDIS_REST_TOKEN });
  const commands: unknown[] = [];
  client.use((request, next) => {
    commands.push(request.body);
    return next(request);
  });
  return { client, commands };
}

describe('mintUpgradeTicket', () => {
  it('issues 32 random bytes as 43 base64url characters', async () => {
    const ticket = await minted();
    expect(ticket).toMatch(/^[\w-]{43}$/);
  });

  it('issues a different ticket on every call for the same grant', async () => {
    const value = grant();
    expect(await minted(value)).not.toBe(await minted(value));
  });

  it('sends Redis no command that carries the ticket', async () => {
    const { client, commands } = recordingRedis();
    const ticket = await minted(grant(), client);
    expect(commands).toHaveLength(1);
    expect(JSON.stringify(commands)).not.toContain(ticket);
  });

  it('stores the grant under the hash of the ticket', async () => {
    const { client, commands } = recordingRedis();
    const ticket = await minted(grant(), client);
    expect(JSON.stringify(commands)).toContain(JSON.stringify(await storedKeyOf(ticket)));
    expect(await redis.exists(await storedKeyOf(ticket))).toBe(1);
  });

  it('stores no value that contains the ticket', async () => {
    const ticket = await minted();
    const stored: unknown = await redis.get(await storedKeyOf(ticket));
    expect(JSON.stringify(stored)).not.toContain(ticket);
  });

  it('expires the stored grant after 60 seconds', async () => {
    const ticket = await minted();
    const ttl = await redis.ttl(await storedKeyOf(ticket));
    expect(UPGRADE_TICKET_KEY.ttlSeconds).toBe(60);
    expect(ttl).toBeGreaterThan(55);
    expect(ttl).toBeLessThanOrEqual(60);
  });

  it('answers unavailable when Redis cannot be reached', async () => {
    const result = await mintUpgradeTicket(unreachableRedis, grant());
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('consumeUpgradeTicket', () => {
  it('hands the first consumer the grant the ticket was minted for', async () => {
    const value = grant();
    const ticket = await minted(value);
    const consumed = await consumeUpgradeTicket(redis, ticket);
    expect(consumed._unsafeUnwrap()).toEqual(value);
  });

  it('reads null for a ticket already consumed', async () => {
    const ticket = await minted();
    const first = await consumeUpgradeTicket(redis, ticket);
    expect(first.isOk()).toBe(true);
    const again = await consumeUpgradeTicket(redis, ticket);
    expect(again._unsafeUnwrap()).toBeNull();
  });

  it('hands exactly one of two concurrent consumers the grant', async () => {
    const value = grant();
    const ticket = await minted(value);
    const results = await Promise.all([
      consumeUpgradeTicket(redis, ticket),
      consumeUpgradeTicket(redis, ticket),
    ]);
    const outcomes = results.map((result) => result._unsafeUnwrap());
    expect(outcomes.filter((outcome) => outcome !== null)).toEqual([value]);
    expect(outcomes.filter((outcome) => outcome === null)).toHaveLength(1);
  });

  it('reads null for a well-formed ticket nobody minted', async () => {
    const unknown = 'A'.repeat(43);
    const consumed = await consumeUpgradeTicket(redis, unknown);
    expect(consumed._unsafeUnwrap()).toBeNull();
  });

  it('reads null for the stored hash presented as a ticket', async () => {
    const ticket = await minted();
    const consumed = await consumeUpgradeTicket(redis, await hashOf(ticket));
    expect(consumed._unsafeUnwrap()).toBeNull();
    expect(await redis.exists(await storedKeyOf(ticket))).toBe(1);
  });

  it('reads null for a malformed ticket without reaching Redis', async () => {
    const consumed = await consumeUpgradeTicket(unreachableRedis, 'not a ticket');
    expect(consumed._unsafeUnwrap()).toBeNull();
  });

  it('answers unavailable when Redis cannot be reached', async () => {
    const consumed = await consumeUpgradeTicket(unreachableRedis, 'A'.repeat(43));
    expect(consumed._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

describe('freshUpgradeTicketGrant', () => {
  it('claims every call, since each mints an independent ticket', async () => {
    const params = freshUpgradeTicketGrant(() => mintUpgradeTicket(redis, grant()));
    const claimed = await params.claim();
    expect(claimed._unsafeUnwrap()).toBe(true);
  });

  it('treats a duplicate claim as a defect', () => {
    const params = freshUpgradeTicketGrant(() => mintUpgradeTicket(redis, grant()));
    expect(() => params.onDuplicate()).toThrow(/duplicate/);
  });
});
