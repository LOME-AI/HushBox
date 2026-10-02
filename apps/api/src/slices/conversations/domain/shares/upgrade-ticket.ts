import { z } from 'zod';
import { toBase64 } from '@hushbox/shared';
import { defineKey, redisGetDel, redisSet } from '../../../../lib/redis/index.js';
import { ResultAsync, okAsync } from '../../../../lib/result/index.js';
import { resolveCallerMember } from './caller.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ByEventIdParams } from '../../../../lib/idempotency/index.js';
import type { Variables } from '../../../../lib/context/index.js';
import type { ConversationsStores } from '../../ports/index.js';
import type { Outcome } from '../outcomes.js';
import type { ConversationCaller } from './caller.js';

/** The per-request Redis client as the pipeline types it (boundaries: domain never imports infra). */
type RedisClient = Variables['redis'];

/** The link guest a ticket opens a socket for, resolved from its credential at mint time. */
interface UpgradeTicketGrant {
  readonly linkId: string;
  readonly conversationId: string;
}

const UPGRADE_TICKET_BYTES = 32;

/** The only spelling a minted ticket has: 32 bytes as unpadded base64url. */
const upgradeTicketSchema = z.string().regex(/^[\w-]{43}$/);

/**
 * A link guest's single-use socket ticket. The key holds the ticket's hash, never
 * the ticket, so a reader of the store cannot open the guest's socket with what it
 * reads there: no store holds a value that authenticates a link guest.
 */
export const UPGRADE_TICKET_KEY = defineKey({
  schema: z.object({ linkId: z.uuid(), conversationId: z.uuid() }),
  ttlSeconds: 60,
  buildKey: (ticketHash: string) => `conversations:upgrade-ticket:${ticketHash}`,
});

/**
 * The name a ticket is stored under: SHA-256 over the ticket as presented, so only
 * its exact issued spelling finds the grant. Both mint and consume key through it.
 */
export function hashUpgradeTicket(ticket: string): ResultAsync<string, DomainError> {
  return ResultAsync.fromSafePromise(
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket))
  ).map((digest) => toBase64(new Uint8Array(digest)));
}

/** Mints a fresh ticket for `grant`, stored for 60 seconds under its hash. */
export function mintUpgradeTicket(
  redis: RedisClient,
  grant: UpgradeTicketGrant
): ResultAsync<string, DomainError> {
  const ticket = toBase64(crypto.getRandomValues(new Uint8Array(UPGRADE_TICKET_BYTES)));
  return hashUpgradeTicket(ticket)
    .andThen((ticketHash) => redisSet(redis, UPGRADE_TICKET_KEY, grant, ticketHash))
    .map(() => ticket);
}

/**
 * Spends a ticket: the grant it was minted for, to exactly one caller, or null for
 * a ticket that is malformed, unknown, expired or already spent. `GETDEL` is what
 * makes it single-use — two racing upgrades cannot both read the grant.
 */
export function consumeUpgradeTicket(
  redis: RedisClient,
  ticket: string
): ResultAsync<UpgradeTicketGrant | null, DomainError> {
  if (!upgradeTicketSchema.safeParse(ticket).success) {
    return okAsync(null);
  }
  return hashUpgradeTicket(ticket).andThen((ticketHash) =>
    redisGetDel(redis, UPGRADE_TICKET_KEY, ticketHash)
  );
}

interface IssueUpgradeTicketParams {
  readonly stores: ConversationsStores;
  readonly redis: RedisClient;
  readonly conversationId: string;
  /** Already matched to `conversationId` by the route's caller gate. */
  readonly caller: ConversationCaller;
}

/**
 * Issues an authorized caller a socket ticket. Only a link guest needs one: a
 * session opens its socket with its cookie, which never enters a URL, so a user
 * is refused. A guest whose member row has left is answered the same
 * existence-hiding not-found as every other guest-reachable read.
 */
export function issueUpgradeTicket(
  params: IssueUpgradeTicketParams
): ResultAsync<Outcome<{ ticket: string }>, DomainError> {
  const { caller, conversationId } = params;
  if (caller.kind === 'user') {
    return okAsync({ refusal: 'forbidden' });
  }
  return resolveCallerMember(params.stores, conversationId, caller).andThen(
    (member): ResultAsync<Outcome<{ ticket: string }>, DomainError> =>
      member === null
        ? okAsync({ refusal: 'not-found' })
        : mintUpgradeTicket(params.redis, { linkId: caller.linkId, conversationId }).map(
            (ticket) => ({ ticket })
          )
  );
}

/**
 * `byEventId` params for a ticket mint. Each call mints an independent random
 * ticket that expires on its own, so every call wins its claim; a retry mints a
 * second ticket and the orphan lapses unused.
 */
export function freshUpgradeTicketGrant<T>(
  execute: () => ResultAsync<T, DomainError>
): ByEventIdParams<T, DomainError> {
  return {
    claim: () => okAsync<boolean, DomainError>(true),
    execute,
    onDuplicate: duplicateFreshTicketDefect,
  };
}

/** Every mint claims, so a duplicate is unreachable: reaching it is a defect. */
function duplicateFreshTicketDefect(): never {
  throw new Error('conversations: duplicate byEventId claim on a freshly minted upgrade ticket');
}
