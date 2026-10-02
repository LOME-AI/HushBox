import { z } from 'zod';
import {
  ChatHistoryMessage,
  ContentValue,
  WorkflowDefinition,
  mockDirectivesSchema,
  senderPrincipalSchema,
} from '@hushbox/shared';
import { typingStartEventSchema, typingStopEventSchema } from './events.js';
import type {
  FlowRunOutcome,
  MockDirectives,
  PaidRunIdentity,
  WireInferenceEvent,
} from '@hushbox/shared';
import type { RealtimeEvent } from './events.js';

/**
 * The ConversationRoom wire protocol. Three surfaces share these shapes:
 * client→server WebSocket messages, server→client frames, and the
 * worker→DO HTTP control bodies. The broadcast vocabulary itself stays in
 * events.ts (consumed by the web client); this module wraps it in frames.
 */

/**
 * Upper bound on a connection's cursor declaration (client input — bounded at
 * the boundary, and a declaration above it fails the upgrade).
 */
export const MAX_DECLARED_STREAMS = 32;

/**
 * What a client says it has already seen, per stream, on connection setup.
 * `runId` names the run the cursor belongs to: a stream id is a node id plus a
 * per-run sequence, both reset at run start, so one run's `s1` and the next
 * run's `s1` are different streams and a cursor a client carried across a run
 * boundary would otherwise be read against the wrong one. It is required
 * because a cursor naming no run cannot be attributed to a stream at all, and
 * an unattributable cursor is refused here rather than deferred to a fallback
 * reading of it against whichever run the room happens to be live in.
 */
export const streamCursorsSchema = z
  .array(
    z.object({
      streamId: z.string().min(1),
      lastEventId: z.number().int().nonnegative(),
      runId: z.string().min(1),
    })
  )
  .max(MAX_DECLARED_STREAMS);

export type StreamCursors = z.infer<typeof streamCursorsSchema>;

/**
 * Upgrade-URL parameter carrying the connecting client's stream cursors, and
 * the only surface that carries them. It is the one client-supplied value the
 * worker forwards to the DO, and it is what lets the room know a reconnecting
 * socket's gap BEFORE any live run frame can reach that socket. A post-open
 * message was the rejected alternative: the socket is live from the moment the
 * client holds it, so a message can only arrive after frames it needed to
 * precede.
 */
export const DECLARED_CURSORS_PARAM = 'cursors';

export function serializeStreamCursors(cursors: StreamCursors): string {
  return JSON.stringify(cursors);
}

/**
 * The declared-cursor parameter as a parse result. An absent parameter is a
 * declaration of nothing, so it reads as an empty list; a present but malformed
 * one FAILS rather than degrading to empty, so the caller refuses the upgrade
 * instead of silently connecting a socket whose declaration it discarded.
 */
export function parseStreamCursors(
  raw: string | null
): { readonly ok: true; readonly cursors: StreamCursors } | { readonly ok: false } {
  if (raw === null) {
    return { ok: true, cursors: [] };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false };
  }
  const parsed = streamCursorsSchema.safeParse(json);
  return parsed.success ? { ok: true, cursors: parsed.data } : { ok: false };
}

/**
 * Everything a client may send over the socket: the typing relay. All other
 * realtime events are server-published only, and a client's replay state
 * rides the upgrade URL rather than any message.
 */
export const clientMessageSchema = z.discriminatedUnion('type', [
  typingStartEventSchema,
  typingStopEventSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

/**
 * Worker→DO run-start handoff, discriminated by policy `mode`. Hooks are bound
 * DO-side (functions cannot cross the fetch boundary). The run identity the
 * policy hooks close over rides the body: a paid run carries the paying wallet
 * and send-time epoch; a trial run carries only its session id (no wallet, no
 * epoch, no conversation). `conversationId` is never a body field — the DO
 * fills it from its own id rather than trust a worker-adjacent value that must
 * equal the room it addresses.
 */
const runStartCommonShape = {
  runKey: z.string().min(1),
  /** Canonical-JSON hash of the client's run request; feeds the referee's body-hash 409. */
  bodyHash: z.string().min(1),
  definition: WorkflowDefinition,
  inputs: z.record(z.string(), ContentValue),
  /**
   * Client-supplied prior turns (paid and trial): E2E crypto keeps the server
   * from reconstructing history, so the client resends it each send. Threaded
   * to the executor as run-scoped context, never as a graph value. Absent
   * normalizes to [] here so every consumer sees one shape.
   */
  history: z.array(ChatHistoryMessage).default([]),
  /**
   * Client-supplied plaintext custom instructions (paid and trial): stored
   * E2E-encrypted, so — like history — the client decrypts and resends them
   * each send. Threaded to the executor as run-scoped context, never into the
   * definition (which must stay free of user content, safe to log). Absent
   * leaves the base system prompt untouched.
   */
  customInstructions: z.string().max(5000).optional(),
  /**
   * Dev/E2E deterministic-inference directives, set by the chat route ONLY in
   * dev/E2E (production never populates it). Optional — a production body omits
   * it, and even if a crafted body carries it, the DO-side provider selection
   * gates on env mode, so the mock stays unreachable in production.
   */
  mockDirectives: mockDirectivesSchema.optional(),
};

const paidRunStartBodySchema = z.object({
  mode: z.literal('paid'),
  ...runStartCommonShape,
  userId: z.string().min(1),
  // The sender principal (member or link-guest) — the sole carrier of the
  // sender's identity on this body; every consumer derives the principal id
  // (persisted as `messages.senderId`, and keying the idempotency scope) with
  // `senderPrincipalId`. Required: the route always resolves a sender before
  // starting a run, so a body without one is a defect rather than an older
  // shape to tolerate.
  sender: senderPrincipalSchema,
  walletId: z.string().min(1),
  epochNumber: z.number().int().positive(),
  // The initiator's message: its content is persisted (epoch-wrapped) with the
  // assistant's reply, under the id the worker route minted for this start. A
  // retry stores no new user row and carries its anchor's id, the request's
  // validated `targetMessageId`.
  userMessage: z.object({
    id: z.string().min(1),
    content: z.string().min(1),
  }),
  // The branch the turn extends, when the client sends onto a fork; the DO
  // threads it into the run identity so settlement chains onto the fork's tip
  // and advances it. Absent for a linear send.
  forkId: z.string().min(1).optional(),
  // Present when the turn re-runs an existing turn (regenerate/edit): the DO
  // threads it into the run identity so settlement deletes the superseded
  // reply(s) and re-parents the new reply. Absent for a fresh send.
  regenerate: z
    .object({
      action: z.enum(['retry', 'edit']),
      targetMessageId: z.string().min(1),
      replaceAssistantId: z.string().min(1).optional(),
      // The fork tip the pre-run guard validated its deletable tail against;
      // the settlement asserts the fork-row-locked tip still equals it (the
      // fork-tip TOCTOU fence). Null for a fork with no tip yet.
      observedForkTipId: z.string().min(1).nullish(),
    })
    .optional(),
});

export const runStartBodySchema = z.discriminatedUnion('mode', [
  paidRunStartBodySchema,
  z.object({
    mode: z.literal('trial'),
    ...runStartCommonShape,
    sessionId: z.string().min(1),
  }),
]);

export type RunStartBody = z.infer<typeof runStartBodySchema>;

type PaidRunStartBody = Extract<RunStartBody, { readonly mode: 'paid' }>;

/**
 * Assembles the paid run identity from the worker→DO body, filling
 * `conversationId` from the DO's own id (never a body field). The optional
 * `forkId` / `regenerate` are spread only when present so the exact-optional
 * identity shape matches.
 */
export function buildPaidIdentity(body: PaidRunStartBody, conversationId: string): PaidRunIdentity {
  const { regenerate } = body;
  return {
    mode: 'paid',
    payerUserId: body.userId,
    sender: body.sender,
    conversationId,
    walletId: body.walletId,
    epochNumber: body.epochNumber,
    userMessage: body.userMessage,
    ...(body.forkId === undefined ? {} : { forkId: body.forkId }),
    ...(regenerate === undefined
      ? {}
      : {
          regenerate: {
            action: regenerate.action,
            targetMessageId: regenerate.targetMessageId,
            ...(regenerate.replaceAssistantId === undefined
              ? {}
              : { replaceAssistantId: regenerate.replaceAssistantId }),
            ...(regenerate.observedForkTipId === undefined
              ? {}
              : { observedForkTipId: regenerate.observedForkTipId }),
          },
        }),
  };
}

/**
 * The run's dev/E2E directives as a spread-ready object, present only when the
 * body carried them (production omits the field).
 */
export function optionalMockDirectives(mockDirectives: MockDirectives | undefined): {
  readonly mockDirectives?: MockDirectives;
} {
  return mockDirectives === undefined ? {} : { mockDirectives };
}

/**
 * Run-scoped custom instructions for the executor start request, present only
 * when the client supplied them. Threaded as run context, never into the
 * definition, which must stay free of user content (safe to log).
 */
export function optionalCustomInstructions(customInstructions: string | undefined): {
  readonly customInstructions?: string;
} {
  return customInstructions === undefined ? {} : { customInstructions };
}

/**
 * `sessionId` scopes the close to the one device that session authorizes;
 * omitted, every socket the principal holds closes. Optional rather than
 * required so that the account-wide callers — and any caller not migrated —
 * keep the all-devices form, making an omission over-evict rather than leave a
 * revoked session connected.
 */
export const evictBodySchema = z.object({
  principalId: z.string().min(1),
  sessionId: z.string().min(1).optional(),
});

export type EvictBody = z.infer<typeof evictBodySchema>;

/**
 * A trial session's room is a Durable Object keyed by a sentinel-prefixed
 * session id — no conversation row backs it. The prefix is what lets the
 * broadcast-time membership verifier recognize a trial self-room without a DB
 * lookup: a conversation id is a bare uuid and never carries it.
 */
export const TRIAL_ROOM_PREFIX = 'trial:';

/** The DO id (room name) for a trial session. */
export function trialRoomName(sessionId: string): string {
  return `${TRIAL_ROOM_PREFIX}${sessionId}`;
}

/**
 * Whether a (conversationId, principalId) pair is a trial session streaming its
 * OWN trial room. A trial principal's id and its room's DO id are the same
 * sentinel-prefixed string, so the prefix plus equality admits exactly the
 * self-room case and nothing else: a trial principal addressing another room
 * fails the equality, and no conversation member ever matches the prefix — both
 * fall through to the authoritative membership check.
 */
export function isTrialRoomSelf(conversationId: string, principalId: string): boolean {
  return principalId.startsWith(TRIAL_ROOM_PREFIX) && conversationId === principalId;
}

/**
 * Over HTTP only a user stop exists. Every other halt starts inside the room
 * or the executor — the executor's drain check, the room's hard-stop alarm, a
 * superseded claim. `caller` is the principal asking to stop, carried because
 * the DO authorizes it against the run live at the instant of the stop — a
 * worker-side comparison would race run turnover.
 */
export const runStopBodySchema = z.object({
  reason: z.literal('user-stop'),
  caller: senderPrincipalSchema,
});

export type RunStopBody = z.infer<typeof runStopBodySchema>;

/**
 * Per-socket state surviving hibernation via serializeAttachment. The
 * principal is authenticated by the worker before the upgrade reaches the
 * DO; `principalId` is a userId, a linkId (link guests), or a trial room name
 * (trial sessions — see `trialRoomName`).
 *
 * `session` is the authorizing session snapshot the broadcast-time
 * session-liveness check validates (session-liveness.ts): `id` keys the
 * `sessionActive` read and `createdAt` is compared against the
 * password-changed watermark. The two travel as one object so a half-populated
 * session is unrepresentable — an authorization input that arrives with one
 * half missing fails the parse rather than reaching a check that could skip it.
 * Optional as a whole: only a real authenticated user carries a session, while
 * link guests and trial-session principals hold none to revoke.
 */
export const socketAttachmentSchema = z.object({
  principalId: z.string().min(1),
  conversationId: z.string().min(1),
  displayName: z.string().optional(),
  isGuest: z.boolean(),
  connectedAt: z.number(),
  session: z
    .object({
      id: z.string().min(1),
      createdAt: z.number(),
    })
    .optional(),
});

export type SocketAttachment = z.infer<typeof socketAttachmentSchema>;

/**
 * Server→client frames. `event` carries the broadcast vocabulary
 * (events.ts); `stream` carries run output with the per-stream monotonic
 * cursor a reconnecting client declares and the room replays from;
 * `stream-gone` is the explicit no-silent-gap signal (client falls back to
 * fetch-after-settlement).
 *
 * `ready` names the run the room is live in, and omits `runId` when it is
 * live in none. It is the first frame of every connection, so it is where a
 * client that did not observe a run's start learns which run to attribute its
 * cursors to — `run-started` is broadcast once, and a socket connecting after
 * that delivery is not in its fan-out.
 */
export type ServerFrame =
  | { readonly type: 'ready'; readonly runId?: string }
  | { readonly type: 'event'; readonly event: RealtimeEvent }
  | {
      readonly type: 'stream';
      readonly streamId: string;
      readonly cursor: number;
      readonly event: WireInferenceEvent;
    }
  | { readonly type: 'stream-gone'; readonly streamId: string }
  | { readonly type: 'run-started'; readonly runId: string }
  | { readonly type: 'run-finished'; readonly runId: string; readonly outcome: FlowRunOutcome };

export function serializeFrame(frame: ServerFrame): string {
  return JSON.stringify(frame);
}
