import {
  ERROR_CODES,
  runTimeBounds,
  senderPrincipalId,
  toWireInferenceEvent,
} from '@hushbox/shared';
import { buildPresenceEvent, connectedUserIds } from './presence.js';
import { ReplayBuffer } from './replay-buffer.js';
import { RunControl } from './run-control.js';
import {
  TRIAL_ROOM_PREFIX,
  buildPaidIdentity,
  clientMessageSchema,
  optionalCustomInstructions,
  optionalMockDirectives,
  serializeFrame,
} from './protocol.js';
import { resolveDoName } from './do-identity.js';
import type { DoIdentityStore } from './do-identity.js';
import type {
  ClaimRun,
  ErrorCode,
  FlowExecutor,
  FlowHoldIdentity,
  FlowHookBindings,
  FlowRunOutcome,
  FlowStreamEvent,
  RunContext,
  RunFence,
  RunIdentity,
  SenderPrincipal,
  WorkflowDefinition,
} from '@hushbox/shared';
import type { RealtimeEvent } from './events.js';
import type {
  ClientMessage,
  RunStartBody,
  ServerFrame,
  SocketAttachment,
  StreamCursors,
} from './protocol.js';
import type { MembershipDecision, MembershipVerifier } from './revocation.js';
import type { SessionVerifier } from './session-liveness.js';
import type { RoomTelemetry } from './telemetry.js';
import type { UserRoomTracker } from './user-rooms.js';

/**
 * All conversation-room behavior, as a plain node-covered module. The
 * Durable Object class is a thin shell over this core: it adapts platform
 * WebSockets to `RoomSocket`, storage alarms to `AlarmScheduler`, and routes
 * HTTP control calls — nothing else.
 */

/** DO-storage key under which the room persists its own conversation id. */
export const CONVERSATION_ID_STORAGE_KEY = 'conversationId';

/**
 * Resolve the room's conversation identity across reconstructions (the
 * shared `resolveDoName` mechanism the JobDispatcher also uses): a live
 * `idFromName` construction persists the name, a nameless platform revival
 * (alarm fire, hibernation wake) reads it back.
 */
export function resolveConversationId(
  idName: string | undefined,
  store: DoIdentityStore
): Promise<string> {
  return resolveDoName(idName, store, {
    storageKey: CONVERSATION_ID_STORAGE_KEY,
    missingMessage:
      'ConversationRoom has no conversation identity: id has no name and none was persisted — reach it via idFromName(conversationId) before any platform revival',
  });
}

export interface RoomSocket {
  send(data: string): void;
  close(code: number, reason: string): void;
  attachment(): SocketAttachment | null;
}

/**
 * The hard-stop alarm's two platform writes, shaped like the dispatcher's
 * `DispatcherScheduler`: both return the storage promise so a caller can
 * observe the write instead of discarding it. The alarm is the only bound on a
 * run's time — nothing else limits how long an in-flight step may stream — so a
 * failed arm must reach the caller rather than leaving an unbounded run.
 */
interface AlarmScheduler {
  setAlarm(at: number): Promise<void>;
  deleteAlarm(): Promise<void>;
}

/**
 * A principal's broadcast-time delivery state — the thing the room reports on
 * and the thing its transition memo remembers.
 */
type DeliveryState = 'member' | 'paused' | 'evicted';

export interface BroadcastReceipt {
  /** Sockets the frame was written to. */
  readonly delivered: number;
  /** Principals skipped inside the last-known-good pause window. */
  readonly paused: number;
  /** Principals cut by the broadcast-time revocation check. */
  readonly evicted: number;
}

/**
 * The hook bindings the room reads: the shared policy hooks plus the ids the
 * run's answers are stored under, in the definition's node order, which the room
 * names on the run start and on an attach. A binder that stores no answers, as
 * a trial's, names an empty list.
 */
export type RoomHookBindings = FlowHookBindings & {
  readonly assistantMessageIds: readonly string[];
};

type RunStartResult =
  | {
      readonly ok: true;
      readonly outcome: 'executor';
      readonly runId: string;
      readonly deadlineAt: number;
      readonly assistantMessageIds: readonly string[];
    }
  | { readonly ok: true; readonly outcome: 'replay'; readonly response: unknown }
  // The ids name the live run's messages, or are null when no run under this
  // key is live in the room.
  | {
      readonly ok: true;
      readonly outcome: 'attach';
      readonly userMessageId: string | null;
      readonly assistantMessageIds: readonly string[] | null;
    }
  // The concurrent-run block and the referee's body-mismatch conflict both
  // answer 409; the code distinguishes them (CONCURRENT_RUN vs the referee's).
  | { readonly ok: false; readonly code: ErrorCode };

/**
 * The post-settlement push side-band: a succeeded paid run persisted a new
 * message, so members who are not present get a content-free notification. The
 * present-user set is snapshotted at fire time so the downstream selector can
 * suppress members already watching the conversation live. Never carries the
 * message itself — the payload is generic by construction (a push notification
 * sits outside the E2E envelope).
 */
export interface RoomPushNotification {
  readonly conversationId: string;
  readonly senderUserId: string;
  /** Users with an open socket at fire time — suppressed downstream (they saw it live). */
  readonly presentUserIds: readonly string[];
}

/**
 * The injected best-effort push capability. Fired at the run's terminal sink
 * for a succeeded paid run; never throws and never blocks completion. Absent
 * (optional) when no push is wired — the room then finishes runs unchanged.
 */
export type RoomNotify = (notification: RoomPushNotification) => Promise<void>;

interface RoomCoreOptions {
  readonly conversationId: string;
  readonly executor: FlowExecutor;
  readonly verifier: MembershipVerifier;
  /**
   * Broadcast-time SESSION-liveness backstop, applied per socket ALONGSIDE the
   * membership check: a real user's socket receives a frame only if its session
   * is still valid. This is the correctness guarantee that closes the
   * push-eviction under-inclusion window (a socket held past the active-room-set
   * TTL that an all-session revocation misses). Optional: when absent the room
   * is membership-only (the worker wires it in production); guests and trial
   * principals carry no session snapshot and are never session-checked.
   */
  readonly sessionVerifier?: SessionVerifier;
  readonly telemetry: RoomTelemetry;
  readonly scheduler: AlarmScheduler;
  /** Claims the durable run referee before start, capturing the settlement fence. */
  readonly claimRun: ClaimRun;
  /** Resolves a definition's named policy hooks, closing them over the run context. */
  readonly bindHooks: (context: RunContext, definition: WorkflowDefinition) => RoomHookBindings;
  readonly maxStreamBytes: number;
  readonly maxRunBytes: number;
  readonly now: () => number;
  readonly newRunId: () => string;
  /** The live socket list — the DO supplies ctx.getWebSockets() adapted. */
  readonly sockets: () => readonly RoomSocket[];
  /**
   * Releases an admission hold at the run's terminal sink (paid runs only) —
   * best-effort: a failure leaves the hold to its TTL, never fails the run.
   */
  readonly releaseHold: (hold: FlowHoldIdentity) => Promise<void>;
  /**
   * Fenced key-row lease touch for the live run. `lost` means a retry
   * superseded this run's claim — the room aborts the zombie.
   */
  readonly heartbeat: (fence: RunFence) => Promise<'alive' | 'lost'>;
  /**
   * Fenced `claimed → failed` flip for a run that reached a terminal state
   * without settling, freeing the key for one serialized retry. A settled row
   * matches zero rows (a no-op) — the fence keeps this safe on every terminal.
   */
  readonly failRun: (fence: RunFence) => Promise<void>;
  /**
   * Records/removes this room in the connecting user's active-room set so a
   * session revocation can fan an eviction out to it (ARCHITECTURE §Streaming & realtime).
   * Optional: absent in tests and until the worker wires the Redis-backed
   * tracker into the DO bindings.
   */
  readonly userRooms?: UserRoomTracker;
  /**
   * Best-effort push for a persisted new message, fired at the terminal sink of
   * a succeeded paid run (never trial, never a failed/stopped run). Optional:
   * absent when no push is wired — a notify failure never affects run
   * completion (fired fire-and-forget through the same best-effort swallow as
   * the money duties).
   */
  readonly notify?: RoomNotify;
  /**
   * The platform's `ctx.waitUntil`, wired by the DO shell. The run-continuation
   * watcher and the terminal best-effort duties (hold release, key-row fail,
   * push) are registered with it so the runtime flushes them before reclaiming
   * the isolate, instead of relying on the in-flight executor keeping the DO
   * resident. Optional: absent in tests and any caller that omits it, the
   * duties run as bare fire-and-forget promises (the mechanism's own TTL/lease
   * backstops still recover them) — identical happy-path behavior either way.
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * The userId to track for eviction, or null when the socket is not a revocable
 * user session. Link guests (`isGuest`) hold no revocable session — their
 * eviction is the separate link-revoke path — and trial-session principals
 * (sentinel-prefixed ids streaming their own trial room) have no session to
 * revoke; everything else is a real authenticated user.
 */
function trackableUserId(attachment: SocketAttachment): string | null {
  if (attachment.isGuest) return null;
  if (attachment.principalId.startsWith(TRIAL_ROOM_PREFIX)) return null;
  return attachment.principalId;
}

/**
 * Under half the 90-second run lease so one missed tick never lapses a
 * healthy run's lease.
 */
export const RUN_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * The most concurrent sockets one principal may hold in this room. A link
 * guest's principal is its link, so a shared link's whole guest audience draws
 * on one budget — the intended bound on an anonymous audience, not a defect.
 *
 * Derived as 6 x 2. Six is borrowed by analogy from the platform's
 * simultaneous-connection width, which governs outbound fetches rather than
 * inbound sockets and so bounds nothing here: it is taken as a generous
 * ceiling on the realms (tabs plus devices) one principal usefully holds on
 * one conversation. The doubling covers reconnect overlap, since each live
 * realm can leave one silently-dead socket behind for as long as the client's
 * heartbeat-plus-pong window takes to notice. Neither factor is measured, the
 * pooled-guest audience least of all, and the value is expected to move.
 *
 * What makes an unmeasured number tolerable is how this cap fails: at the cap
 * the principal's oldest socket is evicted and its client reconnects and
 * replays its declared gap, so an undersized value costs socket rotation,
 * never lockout. Refusing the upgrade instead would turn the same error into a
 * lockout for the user's newest device, which is why that design was rejected.
 */
export const MAX_SOCKETS_PER_PRINCIPAL = 12;

const CLOSE_POLICY_VIOLATION = 1008;
const CLOSE_INTERNAL_ERROR = 1011;

/**
 * A run event as the stream frame a socket receives: a projected copy, so the
 * emitted event the executor still holds keeps its cost and usage for the
 * in-process readers, while no socket receives them.
 */
function streamFrame(event: FlowStreamEvent): ServerFrame {
  return {
    type: 'stream',
    streamId: event.streamId,
    cursor: event.cursor,
    event: toWireInferenceEvent(event.event),
  };
}

function closeQuietly(socket: RoomSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed — nothing to clean up.
  }
}

/**
 * A paid run's two identities: the principal that sent it, and the user whose
 * wallet a settlement debits.
 */
interface PaidRunPrincipals {
  readonly sender: SenderPrincipal;
  readonly payerUserId: string;
}

/**
 * What a stop request resolved to. `no-run` covers both a room with nothing
 * running and a repeat stop after the run finished — benign either way — while
 * `refused` is an authorization failure the caller must be able to tell apart.
 */
type RunStopOutcome = 'stopped' | 'no-run' | 'refused';

/**
 * The paid run's principals to carry on the live-run record: the sender (the
 * post-settlement push names it, and a stop is authorized against it) and the
 * payer whose wallet the stop's partial settlement would debit. A trial run has
 * neither — no conversation to notify, no wallet to charge — so it carries
 * nothing and the absence doubles as the paid marker. Extracted so the branch
 * lives here rather than inflating `startRun`.
 */
function liveRunPrincipals(identity: RunIdentity): { readonly paid?: PaidRunPrincipals } {
  if (identity.mode !== 'paid') return {};
  return { paid: { sender: identity.sender, payerUserId: identity.payerUserId } };
}

/** Whether two sender principals name the same caller, kind included. */
function samePrincipal(a: SenderPrincipal, b: SenderPrincipal): boolean {
  return a.kind === 'user'
    ? b.kind === 'user' && a.userId === b.userId
    : b.kind === 'linkGuest' && a.linkId === b.linkId;
}

/**
 * Who may stop a run: the principal that sent it, or the user whose wallet the
 * stop's partial settlement debits. Nobody else — a role-holder with no money
 * at stake must not be able to trigger a charge to the payer. A link guest is
 * never a payer, so it matches only as the sender. A trial run reaches this
 * with no principals at all and refuses: it has no payer, and no trial caller
 * can reach the stop route today.
 */
function stopAuthorized(paid: PaidRunPrincipals | undefined, caller: SenderPrincipal): boolean {
  if (paid === undefined) return false;
  if (samePrincipal(paid.sender, caller)) return true;
  return caller.kind === 'user' && caller.userId === paid.payerUserId;
}

/** A start the in-memory claim admitted, carried from the claim into the referee step. */
interface ClaimedStart {
  readonly runId: string;
  readonly deadlineAt: number;
  readonly identity: RunIdentity;
  /** Whether this room already held the key live when the start arrived. */
  readonly sameKeyLive: boolean;
  /** Settles the claimed run's answer ids; a no-op for a same-key resend. */
  readonly settleAnswerIds: (answerIds: readonly string[] | null) => void;
}

/** The message ids an attach names. */
type AttachedIds = Pick<
  Extract<RunStartResult, { readonly outcome: 'attach' }>,
  'userMessageId' | 'assistantMessageIds'
>;

export class RoomCore {
  private readonly runControl = new RunControl();
  private buffer: ReplayBuffer | null = null;
  /** Serializes run-frame fan-out so tokens arrive in emission order. */
  private chain: Promise<void> = Promise.resolve();
  /**
   * Per connecting socket, the stream ids it declared at connection setup —
   * exactly the ids its own replay answers, with buffered frames or with
   * `stream-gone` — held until that replay lands. An entry is dropped by the
   * ordering chain itself, never by anything the client does, so a socket that
   * never speaks cannot be starved.
   */
  private readonly withheldFromFanOut = new Map<RoomSocket, ReadonlySet<string>>();
  /**
   * The last DEGRADED delivery state reported per principal, so the room logs
   * state changes instead of one line per principal per frame. Only degraded
   * principals are held and only while they have a live socket
   * ({@link RoomCore.forgetDisconnectedPrincipals}), so the map is bounded by
   * the room's own socket set rather than by everyone it has ever seen.
   */
  private readonly deliveryStates = new Map<string, Exclude<DeliveryState, 'member'>>();
  /**
   * The message ids of the run this room last claimed fresh, keyed by its run
   * key. Written at the claim rather than when the run goes live, so a same-key
   * resend racing the start still names them: the user message id is known at
   * the claim, and `answerIds` settles once the run's hooks are bound, with
   * null when the start fails before binding. Read only while the run control
   * reports that key live, which is what keeps a stale entry unread.
   */
  private claimedRun: {
    readonly runKey: string;
    readonly userMessageId: string | null;
    readonly answerIds: Promise<readonly string[] | null>;
  } | null = null;
  /**
   * The live run's money/lease duties: the settlement fence (heartbeat +
   * fail-on-terminal), the admission hold (released at every terminal), and
   * the heartbeat timer. Guarded by runId like RunControl.release.
   */
  private liveRun: {
    readonly runId: string;
    readonly fence: RunFence;
    /**
     * The run's sender and payer, captured at start. Present only for a paid
     * run, so its presence doubles as the paid marker. The two travel as one
     * object so a half-populated identity is unrepresentable rather than
     * something a check could silently skip.
     */
    readonly paid?: PaidRunPrincipals;
    hold?: FlowHoldIdentity;
    heartbeat?: ReturnType<typeof setInterval>;
  } | null = null;

  constructor(private readonly options: RoomCoreOptions) {}

  /**
   * Connection setup, first half: everything that may fail the upgrade, run
   * while the shell has accepted nothing. A rejection here must leave no
   * socket behind, which is why it cannot be folded into
   * {@link RoomCore.completeOpen}.
   */
  async prepareOpen(socket: RoomSocket): Promise<void> {
    await this.trackSocket(socket);
  }

  /**
   * Connection setup, between the halves: frees a slot for the socket the shell
   * is about to accept, by closing the principal's oldest sockets until it
   * holds fewer than {@link MAX_SOCKETS_PER_PRINCIPAL}. Synchronous, and the
   * shell must call it in the same turn as the acceptance it precedes: a count
   * taken across an await reads a roster that the upgrades racing it have not
   * joined yet, and a whole simultaneous burst slips past the cap.
   *
   * Evicting rather than refusing is also what reaps a silently-dead socket.
   * The idle keepalive pong is answered by the runtime without waking this
   * object and no liveness timer exists, so nothing else bounds how long an
   * orphan holds a slot; a timer or a sweep would be a second mechanism for
   * work this one already does.
   */
  enforceSocketCap(principalId: string): void {
    const held: { socket: RoomSocket; connectedAt: number }[] = [];
    for (const socket of this.options.sockets()) {
      const attachment = socket.attachment();
      if (attachment?.principalId !== principalId) continue;
      held.push({ socket, connectedAt: attachment.connectedAt });
    }
    const excess = held.length - (MAX_SOCKETS_PER_PRINCIPAL - 1);
    if (excess <= 0) return;
    held.sort((a, b) => a.connectedAt - b.connectedAt);
    for (const { socket } of held.slice(0, excess)) {
      closeQuietly(socket, CLOSE_POLICY_VIOLATION, 'socket cap');
    }
  }

  /**
   * Connection setup, second half: the steps that need an accepted socket.
   * `ready` cannot be sent before acceptance, and the presence roster is both
   * built from and delivered to `sockets()`, which does not list the socket
   * until the shell accepts it. Nothing here may fail the upgrade — the socket
   * is already accepted, so a throw would strand it — so the roster broadcast
   * is a swallowed duty, and the shell returns the 101 without awaiting it.
   *
   * `declared` is what the connecting client says it has already seen. The
   * shell must call this in the same synchronous turn as the acceptance it
   * follows: acceptance is what puts the socket in `sockets()`, and the
   * withholding below is what keeps a queued frame for a declared stream from
   * reaching it first.
   */
  completeOpen(socket: RoomSocket, declared: StreamCursors = []): void {
    socket.send(serializeFrame(this.readyFrame()));
    this.replayDeclaredGap(socket, declared);
    this.registerDuty(this.swallowDuty(this.broadcastPresence()));
  }

  /**
   * The opening frame, naming the run this room is live in and naming none
   * when it is live in nothing. The identity is read from the same record
   * {@link RoomCore.declaresAnotherRun} judges a declared cursor against, so
   * the run a client anchors on is the run its next declaration is answered
   * for. This is the only place a socket that connects mid-run learns the run:
   * `run-started` is broadcast once, and a socket connecting after that
   * delivery is not in its fan-out.
   */
  private readyFrame(): ServerFrame {
    const live = this.liveRun;
    return live === null ? { type: 'ready' } : { type: 'ready', runId: live.runId };
  }

  /**
   * Writes a connecting client's declared gap ahead of every live frame for a
   * stream it declared. The socket is held out of fan-out for those stream ids
   * alone ({@link RoomCore.fanOutSockets}) and released on the replay's own
   * link, and that release is registered before any later frame's link awaits
   * the same promise — so the replay lands first and the client's
   * `cursor <= last` dedupe has nothing to discard. Declaring no cursors
   * leaves the socket in full fan-out from acceptance, unchanged: there is no
   * gap to lose a race over.
   */
  private replayDeclaredGap(socket: RoomSocket, declared: StreamCursors): void {
    if (declared.length === 0) {
      return;
    }
    const frames = this.replayFrames(declared);
    this.withheldFromFanOut.set(socket, new Set(declared.map((stream) => stream.streamId)));
    void this.releaseAfter(
      this.enqueueDelivery(() => this.deliverEach(frames, [socket])),
      socket
    );
  }

  /**
   * Returns the socket to full fan-out once its replay link resolves. The
   * await is registered while `replayDeclaredGap` still holds the turn, so it
   * precedes every later frame's await on that same link and the socket is
   * back in the fan-out before the next frame is written.
   */
  private async releaseAfter(link: Promise<void>, socket: RoomSocket): Promise<void> {
    await link;
    this.withheldFromFanOut.delete(socket);
  }

  async handleClose(socket: RoomSocket): Promise<void> {
    await this.untrackSocket(socket);
    await this.broadcastPresence(socket);
  }

  /**
   * Hibernation error handler. The `web_socket_auto_reply_to_close` compat flag
   * makes the runtime echo the peer's Close frame on `webSocketClose`, but the
   * error path has no peer Close to echo — close the errored socket explicitly
   * with 1011 so a half-open socket does not linger, then run the same untrack +
   * presence-rebroadcast as a clean close. `closeQuietly` swallows a throw from
   * an already-closing socket, so this never double-closes under hibernation.
   */
  async handleError(socket: RoomSocket): Promise<void> {
    closeQuietly(socket, CLOSE_INTERNAL_ERROR, 'WebSocket error');
    await this.handleClose(socket);
  }

  /**
   * Records this room in the user's active-room set. Reliability is
   * load-bearing: a missed track would leave a revoked-but-still-member user
   * receiving plaintext until the membership cache expires, so a track failure
   * propagates and the DO fails the upgrade (fail-closed — no socket without a
   * tracked entry) rather than granting an untracked socket. Guests, trial
   * principals, and attachment-less sockets are skipped.
   */
  private async trackSocket(socket: RoomSocket): Promise<void> {
    const tracker = this.options.userRooms;
    if (tracker === undefined) return;
    const attachment = socket.attachment();
    if (attachment === null) return;
    const userId = trackableUserId(attachment);
    if (userId === null) return;
    await tracker.track(userId, this.options.conversationId);
  }

  /**
   * Removes this room from the user's active-room set only when their LAST
   * socket in it closes. Over-inclusion is safe (a stale entry makes a later
   * eviction a harmless no-op) but under-inclusion — dropping the entry while
   * another live socket remains — would leak plaintext, so a lingering
   * same-user socket suppresses the removal. Best-effort: a failed removal is
   * swallowed and reclaimed by the tracker's crash-orphan backstop.
   */
  private async untrackSocket(socket: RoomSocket): Promise<void> {
    const tracker = this.options.userRooms;
    if (tracker === undefined) return;
    const attachment = socket.attachment();
    if (attachment === null) return;
    const userId = trackableUserId(attachment);
    if (userId === null) return;
    const stillConnected = this.options
      .sockets()
      .some((other) => other !== socket && other.attachment()?.principalId === userId);
    if (stillConnected) return;
    await this.swallowDuty(tracker.untrack(userId, this.options.conversationId));
  }

  async broadcastEvent(event: RealtimeEvent): Promise<BroadcastReceipt> {
    return this.deliverFrame({ type: 'event', event }, this.options.sockets());
  }

  async handleClientMessage(sender: RoomSocket, raw: string): Promise<void> {
    const message = this.parseClientMessage(raw);
    if (message === null) {
      this.options.telemetry.clientMessageRejected({
        conversationId: this.options.conversationId,
      });
      return;
    }
    // Never trust client-provided IDs: the relayed identity comes from the
    // worker-authenticated attachment, and a typing event addressed to another
    // conversation is rejected like any other malformed client message.
    const attachment = sender.attachment();
    if (attachment === null || message.conversationId !== this.options.conversationId) {
      this.options.telemetry.clientMessageRejected({
        conversationId: this.options.conversationId,
      });
      return;
    }
    const event = { ...message, userId: attachment.principalId };
    const others = this.options.sockets().filter((socket) => socket !== sender);
    await this.deliverFrame({ type: 'event', event }, others);
  }

  /**
   * Closes the principal's sockets. With `sessionId` the close is scoped to the
   * one device that session authorizes, so signing out on one device leaves the
   * others connected; without it every socket the principal holds closes, which
   * is what an account-wide revocation (credential rotation, account lock,
   * account deletion) and a membership or link revoke mean.
   *
   * The device is told apart by the attachment's session snapshot and nothing
   * else. A socket carrying no snapshot cannot be attributed to a device, so a
   * scoped close cuts it rather than sparing it: an absent authorization input
   * fails closed, exactly as the broadcast-time session check treats one.
   */
  async evict(principalId: string, sessionId?: string): Promise<number> {
    const all = this.options.sockets();
    const targets = all.filter((socket) => {
      const attachment = socket.attachment();
      if (attachment?.principalId !== principalId) return false;
      if (sessionId === undefined) return true;
      return attachment.session === undefined || attachment.session.id === sessionId;
    });
    for (const socket of targets) {
      closeQuietly(socket, CLOSE_POLICY_VIOLATION, 'evicted');
    }
    const remaining = all.filter((socket) => !targets.includes(socket));
    const attachments = remaining
      .map((socket) => socket.attachment())
      .filter((attachment): attachment is SocketAttachment => attachment !== null);
    if (attachments.length > 0) {
      const presence = buildPresenceEvent(
        this.options.conversationId,
        attachments,
        this.options.now()
      );
      await this.deliverFrame({ type: 'event', event: presence }, remaining);
    }
    return targets.length;
  }

  presenceSnapshot(): string[] {
    const attachments = this.options
      .sockets()
      .map((socket) => socket.attachment())
      .filter((attachment): attachment is SocketAttachment => attachment !== null);
    return connectedUserIds(attachments);
  }

  async startRun(body: RunStartBody): Promise<RunStartResult> {
    const runId = this.options.newRunId();
    const deadlineAt =
      this.options.now() + runTimeBounds(body.definition.deadlineClass).hardStopAfterMs;
    // The in-memory concurrent-run hard block goes first: a synchronous claim
    // rejects a second run before any durable round trip, and holding it
    // across the async referee claim serializes interleaved starts. A resubmit
    // under the SAME run key passes through to the referee, whose attach
    // branch answers — only a different key is the concurrent-run block.
    const claim = this.runControl.claim(runId, body.runKey, deadlineAt);
    if (!claim.ok) {
      this.options.telemetry.runRejected({
        conversationId: this.options.conversationId,
        errorCode: claim.code,
      });
      return { ok: false, code: claim.code };
    }
    // conversationId is the DO's own id, never a body field: the room a run
    // addresses is the room it runs in. A trial run carries no wallet, epoch,
    // or conversation — only its session id.
    const identity: RunIdentity =
      body.mode === 'paid'
        ? buildPaidIdentity(body, this.options.conversationId)
        : { mode: 'trial', sessionId: body.sessionId };
    const settleAnswerIds = this.noteClaimedRun(body.runKey, identity, claim.sameKeyLive);
    try {
      return await this.claimAndStart(body, {
        runId,
        deadlineAt,
        identity,
        sameKeyLive: claim.sameKeyLive,
        settleAnswerIds,
      });
    } finally {
      // Wins only when the start ended before its hooks were bound.
      settleAnswerIds(null);
    }
  }

  /** The referee claim and the start that follows it, for a run the in-memory claim admitted. */
  private async claimAndStart(body: RunStartBody, run: ClaimedStart): Promise<RunStartResult> {
    const { runId, deadlineAt, identity } = run;
    let decision;
    try {
      decision = await this.options.claimRun({
        runKey: body.runKey,
        runId,
        bodyHash: body.bodyHash,
        identity,
      });
    } catch (error) {
      this.runControl.release(runId);
      throw error;
    }
    if (decision.outcome === 'conflict') {
      // A reused key with a different body never executes — release the
      // in-memory claim and answer the referee's 409 code.
      this.runControl.release(runId);
      this.options.telemetry.runRejected({
        conversationId: this.options.conversationId,
        errorCode: decision.code,
      });
      return { ok: false, code: decision.code };
    }
    if (decision.outcome === 'replay') {
      this.runControl.release(runId);
      return { ok: true, outcome: 'replay', response: decision.response };
    }
    if (decision.outcome === 'attach') {
      // The attach branch returns without joining the live stream; the fresh
      // in-memory claim is released because nothing starts here.
      this.runControl.release(runId);
      return { ok: true, outcome: 'attach', ...(await this.attachedIds(body.runKey, run)) };
    }
    if (run.sameKeyLive) {
      // Degenerate race: the referee reclaimed the key while this room still
      // runs it in memory (a lapsed lease under a live run). Nothing starts —
      // the live run keeps streaming and the reclaimed fence idles until its
      // lease lapses again, when a retry can truly re-execute.
      return { ok: true, outcome: 'attach', ...(await this.attachedIds(body.runKey, run)) };
    }
    // Dev/E2E deterministic-inference directives ride the run context untouched
    // (production bodies omit the field); the executor consumes it per-run to
    // select the mock provider, gated DO-side on env mode.
    const context: RunContext = {
      ...identity,
      runId,
      fence: decision.fence,
      ...optionalMockDirectives(body.mockDirectives),
    };
    await this.armDeadline(runId, deadlineAt, decision.fence);
    this.buffer = new ReplayBuffer({
      maxStreamBytes: this.options.maxStreamBytes,
      maxRunBytes: this.options.maxRunBytes,
    });
    let handle;
    let assistantMessageIds: readonly string[];
    try {
      const hooks = this.options.bindHooks(context, body.definition);
      assistantMessageIds = hooks.assistantMessageIds;
      run.settleAnswerIds(assistantMessageIds);
      handle = this.options.executor.start({
        definition: body.definition,
        inputs: body.inputs,
        history: body.history,
        ...optionalCustomInstructions(body.customInstructions),
        hooks,
        runKey: body.runKey,
        runId,
        ...optionalMockDirectives(context.mockDirectives),
        emit: (event) => {
          this.onStreamEvent(runId, event);
        },
      });
    } catch (error) {
      this.runControl.release(runId);
      await this.swallowDuty(this.options.scheduler.deleteAlarm());
      this.buffer = null;
      // Nothing started, but the referee's claim is real: fail it so the key
      // frees for one serialized retry instead of waiting out the lease.
      this.failRunQuietly(decision.fence);
      throw error;
    }
    // Enqueued only after start() returns: a synchronous throw must never leave
    // a run-started frame with no matching run-finished. start() returns the
    // handle synchronously and emits only asynchronously, so this still precedes
    // the first stream frame.
    this.enqueueFrame({ type: 'run-started', runId });
    this.runControl.attach(handle);
    this.liveRun = { runId, fence: decision.fence, ...liveRunPrincipals(identity) };
    this.options.telemetry.runStarted({ conversationId: this.options.conversationId, runId });
    this.registerDuty(this.watchRun(runId, handle.done));
    // Admission is decided inside the executor (the one place the policy
    // lives); awaiting it here makes every refusal a synchronous HTTP answer
    // rather than only a run-failed WS event. The refused run terminal-fails
    // through the normal sink above.
    const admission = await handle.admitted;
    if (!admission.admitted) {
      this.options.telemetry.runRejected({
        conversationId: this.options.conversationId,
        errorCode: admission.code,
      });
      return { ok: false, code: admission.code };
    }
    this.adoptAdmission(runId, admission.hold);
    return { ok: true, outcome: 'executor', runId, deadlineAt, assistantMessageIds };
  }

  /**
   * Records a fresh claim's message ids against its run key and returns what
   * settles its answer ids. A same-key resend records nothing, and settling its
   * ids does nothing: the live run's ids are the ones an attach must name.
   */
  private noteClaimedRun(
    runKey: string,
    identity: RunIdentity,
    sameKeyLive: boolean
  ): (answerIds: readonly string[] | null) => void {
    // A same-key resend's ids are the live run's, never its own.
    if (sameKeyLive) return (): void => undefined;
    let settle!: (answerIds: readonly string[] | null) => void;
    const answerIds = new Promise<readonly string[] | null>((resolve) => {
      settle = resolve;
    });
    this.claimedRun = {
      runKey,
      userMessageId: identity.mode === 'paid' ? identity.userMessage.id : null,
      answerIds,
    };
    return settle;
  }

  /**
   * The message ids an attach names: the live run's, when the run control held
   * this key live at the resend's claim, and otherwise null. Its answer ids are
   * awaited, since a resend can race the start that binds them. A referee attach
   * with no live run here means the key's lease outlived the room's in-memory run.
   */
  private async attachedIds(runKey: string, run: ClaimedStart): Promise<AttachedIds> {
    const claimed = this.claimedRun;
    if (!run.sameKeyLive || claimed?.runKey !== runKey) {
      return { userMessageId: null, assistantMessageIds: null };
    }
    return { userMessageId: claimed.userMessageId, assistantMessageIds: await claimed.answerIds };
  }

  /**
   * Arms the run's hard stop. This is the one scheduler write whose failure is
   * fatal: the alarm is the only bound on a run's time — nothing else limits
   * how long an in-flight step may stream — so a rejected write must reach the
   * caller instead of leaving an unbounded run. The in-memory claim and the
   * referee's key row are unwound first, so the key frees for one serialized
   * retry.
   */
  private async armDeadline(runId: string, deadlineAt: number, fence: RunFence): Promise<void> {
    try {
      await this.options.scheduler.setAlarm(deadlineAt);
    } catch (error) {
      this.runControl.release(runId);
      this.failRunQuietly(fence);
      throw error;
    }
  }

  /**
   * Wires the granted admission into the live-run record: the hold to release
   * at the terminal sink and the lease heartbeat. When the run already
   * finished before admission resolved, the sink could not have known the
   * hold — release it here instead.
   */
  private adoptAdmission(runId: string, hold: FlowHoldIdentity | undefined): void {
    const live = this.liveRun;
    if (live?.runId !== runId) {
      if (hold !== undefined) this.releaseHoldQuietly(hold);
      return;
    }
    if (hold !== undefined) live.hold = hold;
    live.heartbeat = setInterval(() => {
      void this.heartbeatTick(runId, live.fence);
    }, RUN_HEARTBEAT_INTERVAL_MS);
  }

  private async heartbeatTick(runId: string, fence: RunFence): Promise<void> {
    try {
      const result = await this.options.heartbeat(fence);
      if (result === 'lost' && this.liveRun?.runId === runId) {
        // A retry superseded this run's claim. Abort the zombie: its
        // settlement would lose the fence anyway, so letting its in-flight
        // step finish would only spend.
        this.runControl.abort('superseded');
      }
    } catch {
      // Best-effort: a transient store failure never stops a healthy run;
      // the fence stays authoritative.
    }
  }

  private async watchRun(runId: string, done: Promise<FlowRunOutcome>): Promise<void> {
    let outcome: FlowRunOutcome;
    try {
      outcome = await done;
    } catch {
      // The executor contract reports failures as outcomes; a rejected
      // `done` is a defect, contained here as a failed run so the room
      // always releases the claim and the alarm.
      outcome = { outcome: 'failed', code: ERROR_CODES.INTERNAL };
    }
    await this.finishRun(runId, outcome);
  }

  /**
   * The explicit user stop, authorized here rather than in the worker: only
   * this room holds the run live at the instant of the stop, so a comparison
   * anywhere else would race run turnover. `no-run` and `refused` stay
   * distinct answers — a repeat stop on a finished run is a benign no-op,
   * an unauthorized one is a refusal.
   */
  stopRun(caller: SenderPrincipal): RunStopOutcome {
    const live = this.liveRun;
    if (live === null) return 'no-run';
    if (!stopAuthorized(live.paid, caller)) return 'refused';
    return this.runControl.stop('user-stop') ? 'stopped' : 'no-run';
  }

  onAlarm(): void {
    const runId = this.runControl.activeRunId();
    if (this.runControl.onAlarm() === 'aborted' && runId !== null) {
      this.options.telemetry.deadlineFired({
        conversationId: this.options.conversationId,
        runId,
      });
    }
  }

  /**
   * Resolves when every enqueued run frame has been fanned out, including
   * frames enqueued by completion microtasks that fire while waiting.
   */
  async settled(): Promise<void> {
    let current: Promise<void>;
    do {
      current = this.chain;
      await current;
    } while (current !== this.chain);
  }

  /**
   * Rebroadcasts the presence roster, excluding a socket that is leaving. The
   * platform may still list a closing socket in the room's socket set while
   * its close handler runs, so a departing socket is excluded explicitly
   * rather than trusted to be gone — the discipline `evict` already applies to
   * its own targets.
   */
  private async broadcastPresence(excluded?: RoomSocket): Promise<void> {
    const sockets = this.options.sockets().filter((socket) => socket !== excluded);
    const attachments = sockets
      .map((socket) => socket.attachment())
      .filter((attachment): attachment is SocketAttachment => attachment !== null);
    if (attachments.length === 0) {
      return;
    }
    const presence = buildPresenceEvent(
      this.options.conversationId,
      attachments,
      this.options.now()
    );
    await this.deliverFrame({ type: 'event', event: presence }, sockets);
  }

  private parseClientMessage(raw: string): ClientMessage | null {
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return null;
    }
    const parsed = clientMessageSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
  }

  private onStreamEvent(runId: string, event: FlowStreamEvent): void {
    if (this.runControl.activeRunId() !== runId || this.buffer === null) {
      return;
    }
    this.buffer.append(event);
    this.enqueueFrame(streamFrame(event));
    // Each step-finish is one billable gateway generation (one usage_records
    // row). The `billableGeneration` line carries the actual generationId,
    // which outside usage_records is recorded nowhere else — but nothing reads
    // that line, so a killed run, which commits no usage_records row, leaves
    // its provider spend unreconcilable after the fact. The terminal `finish`
    // reuses the last step's generation, so metering only step-finish avoids a
    // double count.
    if (event.event.kind === 'step-finish') {
      this.options.telemetry.billableGeneration({
        conversationId: this.options.conversationId,
        runId,
        generationId: event.event.generationId,
      });
    }
  }

  private async finishRun(runId: string, outcome: FlowRunOutcome): Promise<void> {
    // Capture the live record before settlement clears it — the push decision
    // reads the paid sender it carries.
    const live = this.liveRun?.runId === runId ? this.liveRun : null;
    this.settleRunMoney(runId, outcome);
    this.runControl.release(runId);
    this.buffer = null;
    this.options.telemetry.runFinished({
      conversationId: this.options.conversationId,
      runId,
      ...(outcome.outcome === 'failed' ? { errorCode: outcome.code } : {}),
    });
    // A succeeded paid run persisted a new message: fire the content-free push
    // to absent members. Trial runs (no principals) and non-succeeded runs
    // (nothing persisted) never notify. Best-effort — never blocks the sink.
    if (outcome.outcome === 'succeeded' && live?.paid !== undefined) {
      this.firePushNotify(senderPrincipalId(live.paid.sender));
    }
    this.enqueueFrame({ type: 'run-finished', runId, outcome });
    // Disarming is the asymmetric half of the arm above, and it runs last so
    // the sink's frames and duties are already ordered: the claim is released
    // by now, so an alarm left behind by a failed delete fires into a room with
    // no active run and stops nothing.
    await this.swallowDuty(this.options.scheduler.deleteAlarm());
  }

  /**
   * Fires the injected push capability fire-and-forget with the presence
   * snapshot taken at fire time (absent members are selected downstream). The
   * swallow guards a throwing capability so a push failure can never reach the
   * terminal sink; a missing capability is a no-op.
   */
  private firePushNotify(senderUserId: string): void {
    const notify = this.options.notify;
    if (notify === undefined) return;
    try {
      this.registerDuty(
        this.swallowDuty(
          notify({
            conversationId: this.options.conversationId,
            senderUserId,
            presentUserIds: this.presenceSnapshot(),
          })
        )
      );
    } catch {
      // A synchronous throw from the capability must never reach the sink (an
      // async rejection is caught by swallowDuty); the run still finishes.
    }
  }

  /**
   * The run's money/lease duties at its ONE terminal sink — every outcome
   * (success, stop, failure, deadline, defect) funnels through finishRun, so
   * every run releases its hold here instead of waiting out the TTL, and every
   * unsettled run frees its key row for one serialized retry. All calls are
   * best-effort: TTL expiry and lease lapse remain the backstops.
   */
  private settleRunMoney(runId: string, outcome: FlowRunOutcome): void {
    const live = this.liveRun;
    if (live?.runId !== runId) return;
    this.liveRun = null;
    if (live.heartbeat !== undefined) clearInterval(live.heartbeat);
    if (live.hold !== undefined) this.releaseHoldQuietly(live.hold);
    if (outcome.outcome !== 'succeeded') {
      // Fenced flip to `failed`: a settled row (success, or a stopped run that
      // billed its partial) matches zero rows and no-ops; an unsettled row
      // frees the key so a same-key retry re-executes instead of attaching to
      // a dead run.
      this.failRunQuietly(live.fence);
    }
  }

  /** Best-effort money duty: every failure is swallowed (TTL is the backstop). */
  private releaseHoldQuietly(hold: FlowHoldIdentity): void {
    this.registerDuty(this.swallowDuty(this.options.releaseHold(hold)));
  }

  /** Best-effort lease duty: every failure is swallowed (lease lapse is the backstop). */
  private failRunQuietly(fence: RunFence): void {
    this.registerDuty(this.swallowDuty(this.options.failRun(fence)));
  }

  private async swallowDuty(duty: Promise<void>): Promise<void> {
    try {
      await duty;
    } catch {
      // Best-effort by design: the mechanism's own backstop recovers.
    }
  }

  /**
   * Registers a fire-and-forget terminal duty (hold release, key-row fail,
   * push) or the run-continuation watcher with `ctx.waitUntil` when the shell
   * wired it, so the runtime flushes the promise before reclaiming the isolate.
   * Absent, the promise runs bare — the mechanism's own TTL/lease backstop
   * still recovers it, so the happy path is unchanged.
   */
  private registerDuty(duty: Promise<void>): void {
    const waitUntil = this.options.waitUntil;
    if (waitUntil === undefined) {
      void duty;
      return;
    }
    waitUntil(duty);
  }

  private enqueueFrame(frame: ServerFrame): void {
    void this.enqueueDelivery(() => this.deliverFrame(frame, this.fanOutSockets(frame)));
  }

  /**
   * The room's sockets, less each socket whose connection-setup declaration is
   * about to catch it up on the very stream this frame carries. A declaration
   * is answered by {@link RoomCore.replayFrames}, which walks the declared list
   * and nothing else, so a frame outside that list — a sibling stream's token,
   * a run's opening or terminal frame — is in nothing that socket is about to
   * be sent: withholding it drops it from that socket for good. Delivering it
   * ahead of the replay is safe because the client's dedupe is per stream.
   * Evaluated when the frame's link runs, not when it is enqueued, so a stream
   * frame that queued before a socket connected but delivers after it does not
   * reach that socket ahead of its catch-up.
   */
  private fanOutSockets(frame: ServerFrame): readonly RoomSocket[] {
    const sockets = this.options.sockets();
    if (frame.type !== 'stream' || this.withheldFromFanOut.size === 0) {
      return sockets;
    }
    return sockets.filter(
      (socket) => this.withheldFromFanOut.get(socket)?.has(frame.streamId) !== true
    );
  }

  /**
   * Appends a delivery to the room's ordering chain and hands back the link it
   * appended, so a caller that must observe its own delivery can await it
   * without stepping outside the order the chain imposes.
   */
  private enqueueDelivery(deliver: () => Promise<unknown>): Promise<void> {
    const link = this.deliverAfter(this.chain, deliver);
    this.chain = link;
    return link;
  }

  /**
   * Every link RESOLVES, whatever its delivery did. That is what keeps one
   * failure from poisoning the conversation: a rejecting link would be
   * re-awaited by its successor at `await previous` and by every link after
   * that, killing run-frame fan-out for the life of the DO instance. The
   * resolving link is also the one handed back, so a caller that awaits its
   * own delivery — the release of a socket withheld for its declared replay —
   * sees a best-effort delivery finish rather than an error it cannot act on,
   * and a failed replay cannot strand that socket outside the fan-out.
   * `previous` is awaited OUTSIDE the guard on that same invariant — inside,
   * one failure would report itself once per queued link behind it.
   */
  private async deliverAfter(
    previous: Promise<void>,
    deliver: () => Promise<unknown>
  ): Promise<void> {
    await previous;
    try {
      await deliver();
    } catch {
      this.options.telemetry.deliveryFailed({ conversationId: this.options.conversationId });
    }
  }

  /**
   * Whether a declared cursor belongs to a run this room is not live in —
   * a room with no live run included, since it is live in none of them. Stream
   * ids repeat across runs — a stream id is a node id plus a per-run sequence,
   * both reset at run start — so a cursor a client carried across a run
   * boundary names a stream of the live run that it has never seen: replaying
   * from it would deliver that stream's tail and silently withhold its head.
   */
  private declaresAnotherRun(cursor: StreamCursors[number]): boolean {
    return cursor.runId !== this.liveRun?.runId;
  }

  /**
   * A declared cursor list as the frames answering it: each stream's buffered
   * events past the declared cursor, or the explicit `stream-gone` when that
   * cursor cannot be answered: it belongs to a run the room is not live in (a
   * room running nothing included), or the live run's buffer cannot answer it.
   */
  private replayFrames(streams: StreamCursors): ServerFrame[] {
    return streams.flatMap((stream): ServerFrame[] => {
      const result = this.declaresAnotherRun(stream)
        ? { kind: 'gone' as const }
        : (this.buffer?.resume(stream.streamId, stream.lastEventId) ?? {
            kind: 'gone' as const,
          });
      if (result.kind === 'gone') {
        return [{ type: 'stream-gone', streamId: stream.streamId }];
      }
      return result.events.map((event) => streamFrame(event));
    });
  }

  private async deliverFrame(
    frame: ServerFrame,
    sockets: readonly RoomSocket[]
  ): Promise<BroadcastReceipt> {
    return this.deliverEach([frame], sockets);
  }

  private async deliverEach(
    frames: readonly ServerFrame[],
    sockets: readonly RoomSocket[]
  ): Promise<BroadcastReceipt> {
    const byPrincipal = this.groupByPrincipal(sockets);
    const receipt = { delivered: 0, paused: 0, evicted: 0 };
    for (const [principalId, group] of byPrincipal) {
      const decision = await this.options.verifier.verify(this.options.conversationId, principalId);
      if (decision !== 'member') {
        this.reportDeliveryState(principalId, this.applyNonMember(decision, group, receipt));
        continue;
      }
      // Member by membership — now the per-socket session backstop. A socket
      // whose authorizing session was revoked (logout, or a password-changed
      // watermark past its snapshot) is cut here even though its principal is
      // still a member, closing the leak the membership check alone cannot.
      let state: DeliveryState = 'member';
      for (const socket of group) {
        const socketState = await this.deliverToMember(socket, frames, receipt);
        // The group reports the strongest degradation any of its sockets hit,
        // so a principal on two devices is not reported healthy because one of
        // them still receives.
        if (socketState === 'evicted' || (socketState === 'paused' && state === 'member')) {
          state = socketState;
        }
      }
      this.reportDeliveryState(principalId, state);
    }
    this.forgetDisconnectedPrincipals();
    return receipt;
  }

  /**
   * Emits a delivery-state line only when the principal's state MOVES. What
   * the fan-out re-decides on every frame is a condition, not an event, and
   * frames are stream tokens — logging it per frame makes log volume track
   * throughput at exactly the moment the system is degraded. A principal that
   * flips repeatedly still produces one line per flip.
   */
  private reportDeliveryState(principalId: string, state: DeliveryState): void {
    const previous = this.deliveryStates.get(principalId);
    if (state === 'member') {
      if (previous === undefined) return;
      this.deliveryStates.delete(principalId);
      this.options.telemetry.deliveryResumed({ conversationId: this.options.conversationId });
      return;
    }
    if (previous === state) return;
    this.deliveryStates.set(principalId, state);
    if (state === 'evicted') {
      this.options.telemetry.principalEvicted({ conversationId: this.options.conversationId });
      return;
    }
    this.options.telemetry.deliveryPaused({ conversationId: this.options.conversationId });
  }

  /**
   * Drops remembered states for principals with no socket left in the room —
   * the bound on the memo. A reconnecting principal is reported afresh, which
   * is the honest reading: its new socket has never been told anything.
   * Skipped outright while nothing is degraded, which is the ordinary case.
   */
  private forgetDisconnectedPrincipals(): void {
    if (this.deliveryStates.size === 0) return;
    const connected = new Set(
      this.options
        .sockets()
        .map((socket) => socket.attachment()?.principalId)
        .filter((principalId): principalId is string => principalId !== undefined)
    );
    for (const principalId of this.deliveryStates.keys()) {
      if (!connected.has(principalId)) this.deliveryStates.delete(principalId);
    }
  }

  /** Principals with a remembered degraded state — the boundedness the sweep maintains. */
  deliveryStateCount(): number {
    return this.deliveryStates.size;
  }

  private async deliverToMember(
    socket: RoomSocket,
    frames: readonly ServerFrame[],
    receipt: { delivered: number; paused: number; evicted: number }
  ): Promise<DeliveryState> {
    const session = await this.checkSession(socket);
    if (session === 'revoked' || session === 'unverifiable') {
      closeQuietly(
        socket,
        CLOSE_POLICY_VIOLATION,
        session === 'revoked' ? 'session-revoked' : 'session-unverifiable'
      );
      receipt.evicted += 1;
      return 'evicted';
    }
    if (session === 'pause') {
      receipt.paused += 1;
      return 'paused';
    }
    if (this.sendQuietly(socket, frames)) {
      receipt.delivered += 1;
    }
    return 'member';
  }

  /**
   * The socket's session-liveness decision. `live` when there is no session
   * verifier wired (membership-only mode) or the socket holds no revocable
   * session (a link guest, a trial principal); `unverifiable` when a real
   * user's socket carries no session at all — an absent authorization input is
   * never read as a satisfied one, so that socket is cut rather than trusted,
   * which is also what closes a socket attached under a retired attachment
   * shape on the first broadcast after a deploy.
   */
  private async checkSession(
    socket: RoomSocket
  ): Promise<'live' | 'revoked' | 'pause' | 'unverifiable'> {
    const verifier = this.options.sessionVerifier;
    if (verifier === undefined) return 'live';
    const attachment = socket.attachment();
    // Unreachable, and deliberately not deleted: {@link RoomCore.groupByPrincipal}
    // closes every null-attachment socket before the fan-out that reaches here,
    // so this branch is a property of the callers rather than of this function.
    // It stays fail-closed because a caller can move; nothing here may read an
    // absent authorization input as a satisfied one.
    if (attachment === null) return 'unverifiable';
    if (trackableUserId(attachment) === null) return 'live';
    const session = attachment.session;
    if (session === undefined) return 'unverifiable';
    return verifier.verify({
      userId: attachment.principalId,
      sessionId: session.id,
      sessionCreatedAt: session.createdAt,
    });
  }

  /** Sockets without a readable attachment are closed — they can never be verified. */
  private groupByPrincipal(sockets: readonly RoomSocket[]): Map<string, RoomSocket[]> {
    const byPrincipal = new Map<string, RoomSocket[]>();
    for (const socket of sockets) {
      const attachment = socket.attachment();
      if (attachment === null) {
        closeQuietly(socket, CLOSE_INTERNAL_ERROR, 'invalid attachment');
        continue;
      }
      const group = byPrincipal.get(attachment.principalId) ?? [];
      group.push(socket);
      byPrincipal.set(attachment.principalId, group);
    }
    return byPrincipal;
  }

  /** Applies a non-member broadcast decision to the whole principal group. */
  private applyNonMember(
    decision: Exclude<MembershipDecision, 'member'>,
    group: readonly RoomSocket[],
    receipt: { delivered: number; paused: number; evicted: number }
  ): Exclude<DeliveryState, 'member'> {
    if (decision === 'revoked') {
      for (const socket of group) {
        closeQuietly(socket, CLOSE_POLICY_VIOLATION, 'revoked');
      }
      receipt.evicted += 1;
      return 'evicted';
    }
    receipt.paused += 1;
    return 'paused';
  }

  private sendQuietly(socket: RoomSocket, frames: readonly ServerFrame[]): boolean {
    try {
      for (const frame of frames) {
        socket.send(serializeFrame(frame));
      }
      return true;
    } catch {
      closeQuietly(socket, CLOSE_INTERNAL_ERROR, 'send failed');
      return false;
    }
  }
}
