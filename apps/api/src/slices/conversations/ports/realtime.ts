import type { ErrorCode, SenderPrincipal } from '@hushbox/shared';
import type { BroadcastReceipt, RealtimeEvent, RunStartBody } from '@hushbox/realtime';
import type { DomainError } from '../../../lib/errors/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';

/**
 * The RealtimeBroadcast port (ARCHITECTURE.md infra edge): the worker's
 * typed surface onto a conversation's ConversationRoom Durable Object.
 * One DO per conversation, addressed by `idFromName(conversationId)`.
 *
 * A 409-class rejection rides the SUCCESS channel as a typed outcome — an
 * expected domain answer the route maps to its wire code (CONCURRENT_RUN for
 * the one-run block, IDEMPOTENCY_BODY_MISMATCH for a reused key with a
 * different body), not an infrastructure failure. The DomainError channel
 * carries transport/contract failures only.
 */

export interface RunStartReceipt {
  readonly runId: string;
  /** Epoch ms; the room's single alarm fires run control at this instant. */
  readonly deadlineAt: number;
  /**
   * The ids the run's answers are stored under, minted when the room bound the
   * run's hooks, in the selected order. Empty for a trial run, which stores none.
   */
  readonly assistantMessageIds: readonly string[];
}

/**
 * The room referee's four verdicts for a run start, all on the SUCCESS
 * channel (expected domain answers, not transport failures):
 * - `started: true`  — a fresh run began; the route hands back the run handle.
 * - `started: false` — a typed refusal, mapped to a wire code: the
 *   concurrent-run block, the reused-key-different-body conflict, or a
 *   synchronous admission refusal (insufficient balance, admission
 *   infrastructure down, trial capacity).
 * - `outcome: 'replay'` — the run already settled under this key; the stored
 *   turn response replays verbatim (a duplicate POST is never a transport
 *   error). `response` is the referee's stored payload.
 * - `outcome: 'attach'` — a run is still live for this key; the client rejoins
 *   its stream over the conversation WebSocket rather than starting a second.
 *
 * An attach's `userMessageId` and `assistantMessageIds` are that live run's
 * message ids, or null when the room holds no live run for the key (the
 * referee's lease outlived the room's in-memory run).
 */
export type RunStartOutcome =
  | ({ readonly started: true } & RunStartReceipt)
  | { readonly started: false; readonly code: ErrorCode }
  | { readonly outcome: 'replay'; readonly response: unknown }
  | {
      readonly outcome: 'attach';
      readonly userMessageId: string | null;
      readonly assistantMessageIds: readonly string[] | null;
    };

/**
 * The upgrade principal the worker authenticated before proxying the socket to
 * the DO. `principalId` is a userId (or, for link guests, a linkId); the DO
 * binds it into the hibernation-surviving socket attachment.
 *
 * `session` is the authorizing session snapshot (a real authenticated user
 * only) the DO binds so the broadcast-time session-liveness check can validate
 * the socket against `sessionActive` + the password-changed watermark. Absent
 * for link guests and trial principals — they hold no revocable session.
 */
export interface UpgradePrincipal {
  readonly principalId: string;
  readonly isGuest: boolean;
  readonly displayName?: string;
  readonly session?: { readonly id: string; readonly createdAt: number };
}

export interface RealtimeBroadcast {
  /** Fan an event out to the conversation's sockets (broadcast-time revalidation applies). */
  broadcast(
    conversationId: string,
    event: RealtimeEvent
  ): ResultAsync<BroadcastReceipt, DomainError>;

  /**
   * Close the principal's sockets in the room; resolves the count closed.
   * `sessionId` scopes the close to the one device that session authorizes;
   * omitted, every socket the principal holds closes — which is what a
   * membership change, a link revoke, and an account-wide session revocation
   * all mean. Optional rather than required so an omission over-closes rather
   * than leaving a revoked session connected.
   */
  evict(
    conversationId: string,
    principalId: string,
    sessionId?: string
  ): ResultAsync<number, DomainError>;

  /** Deduplicated authenticated userIds with an open socket (push suppression). */
  presence(conversationId: string): ResultAsync<readonly string[], DomainError>;

  /** Hand a run off to the room (the DO owns claim, deadline, and streaming). */
  startRun(
    conversationId: string,
    request: RunStartBody
  ): ResultAsync<RunStartOutcome, DomainError>;

  /**
   * Plain-HTTP user stop — never WS-dependent. Resolves false when no run is
   * active. `caller` is the principal asking: the room authorizes it against
   * the run it holds live and answers a caller that may not stop it with a
   * `forbidden` error, so this never resolves for an unauthorized stop.
   */
  stopRun(conversationId: string, caller: SenderPrincipal): ResultAsync<boolean, DomainError>;

  /**
   * Proxy an authenticated WebSocket upgrade to the conversation's DO. The
   * worker route authorizes membership first; this forwards the principal (as
   * DO query params) and the client's upgrade headers, returning the DO's
   * `101` response untouched so the socket reaches the client.
   *
   * `declaredCursors` is the client's raw per-stream replay position from the
   * upgrade query — the one client-supplied value that crosses this seam, so
   * that the room knows a reconnecting socket's gap before any live run frame
   * can reach it. It is bounded here rather than trusted: a malformed
   * declaration answers a `validation` error and never reaches the room. The
   * remaining DomainError cases are transport failures.
   */
  upgrade(
    conversationId: string,
    principal: UpgradePrincipal,
    headers: Headers,
    declaredCursors: string | null
  ): ResultAsync<Response, DomainError>;
}
