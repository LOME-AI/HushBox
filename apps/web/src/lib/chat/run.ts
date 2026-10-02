/**
 * The client half of the run protocol: HTTP starts/stops a run, the
 * conversation WebSocket carries the streamed output. This module owns one
 * run's lifecycle — gate the POST on an attached socket, demux `stream`
 * frames onto the pre-allocated per-model tiles via each stream's
 * `stream-start` label, arm the client-side deadline from the 201's
 * `deadlineAt`, and auto-resubmit the same Idempotency-Key once after a
 * reconnect (attach → keep streaming; replay → settled; fresh 201 → clean
 * re-execution, tiles reset). Pure with respect to React and the network:
 * the hook layer supplies `postRun` (typed client, key bound) and a socket.
 */
import {
  assistantAnswerText,
  ERROR_CODES,
  MAX_RUN_HARD_STOP_MS,
  SMART_MODEL_ID,
} from '@hushbox/shared';
import { createStreamContentBuilder } from './stream-content-builder.js';
import type { StreamContentBuilder } from './stream-content-builder.js';
import type { RunFrame } from '../api/server-frames.js';
import type {
  ResolvedReasoningEffort,
  RunAttachResponse,
  RunStartedResponse,
} from '@hushbox/shared';

export interface RunTransportSocket {
  connect(): void;
  waitForReady(timeoutMs: number): Promise<boolean>;
  readonly ready: boolean;
  onRunFrame(listener: (frame: RunFrame) => void): () => void;
  onStateChange(listener: () => void): () => void;
}

/** Calls a listener once per rendered frame until the returned function is called. */
export interface FrameSource {
  onFrame(listener: () => void): () => void;
}

/**
 * A run-start POST's outcome, its fields read off the shared response bodies.
 * `assistantMessageIds` are the ids the server minted for the run's answers, in
 * the selected order, which settlement stores them under; null when the response
 * named none: a trial run start, and an attach that found no live run.
 */
export type RunStartResponse =
  | (Pick<RunStartedResponse, 'runId' | 'deadlineAt'> & {
      kind: 'started';
      assistantMessageIds: RunAttachResponse['assistantMessageIds'];
    })
  | (Pick<RunAttachResponse, 'assistantMessageIds'> & { kind: 'attach' })
  | { kind: 'replay' };

export interface ChatRunTile {
  readonly modelId: string;
  readonly assistantMessageId: string;
}

/**
 * The tiles keyed by the answer ids a run-start or attach response named, in the
 * selected order, which is the tile order, so each live tile is the message its
 * stored row will be. A response naming none, and a run storing no answers,
 * leave every tile on its key. Any other count is a broken contract, never a
 * reason to keep a local key.
 */
export function keyTiles(
  tiles: readonly ChatRunTile[],
  assistantMessageIds: readonly string[] | null
): ChatRunTile[] {
  if (assistantMessageIds === null || assistantMessageIds.length === 0) return [...tiles];
  const mismatch = (): Error =>
    new Error(
      `run start named ${String(assistantMessageIds.length)} answer ids for ${String(tiles.length)} tiles`
    );
  if (assistantMessageIds.length > tiles.length) throw mismatch();
  return tiles.map((tile, index) => {
    const assistantMessageId = assistantMessageIds[index];
    if (assistantMessageId === undefined) throw mismatch();
    return { ...tile, assistantMessageId };
  });
}

export interface ChatRunCallbacks {
  onRunStarted?: ((runId: string) => void) | undefined;
  /** The stream's `stream-start` label — Smart Model's resolved model id included. */
  onModelResolved?: ((assistantMessageId: string, modelId: string) => void) | undefined;
  /** A resubmit began a clean re-execution: reset these tiles' content. */
  onRestart?: ((assistantMessageIds: string[]) => void) | undefined;
  /**
   * A tile's content, built from every one of its stream events: at most once
   * per rendered frame while it streams, and at once, settled, when the tile
   * finishes or the run ends.
   */
  onContent?: ((content: string, assistantMessageId: string) => void) | undefined;
  /**
   * The answer text a reader would hear, as it grows, for read-aloud: each call
   * carries what the tile's answer projection gained since the last one, so
   * reasoning, search rows and a think block the model wrote into its text are
   * never spoken. Content itself comes from `onContent`.
   */
  onTextDelta?: ((text: string, assistantMessageId: string) => void) | undefined;
  /**
   * The finish frame's `usage.reasoningTokens` — the live billed count for
   * models that reason without emitting visible text. Fired only when the
   * provider reported one; a reasoning-free stream fires nothing.
   */
  onReasoningTokens?: ((count: number, assistantMessageId: string) => void) | undefined;
  /**
   * The finish frame's resolved reasoning level — the rung the server minted
   * this call's wire at, and the same resolution it persists. Fired only when
   * the frame records one, so a levelless stream leaves the badge off; `off` is
   * a recorded level and arrives as itself.
   */
  onReasoningEffort?:
    | ((effort: ResolvedReasoningEffort, assistantMessageId: string) => void)
    | undefined;
  onModelDone?: ((data: { assistantMessageId: string; modelId: string }) => void) | undefined;
  onModelError?:
    | ((data: { assistantMessageId: string; modelId: string; code: string }) => void)
    | undefined;
  onMediaStart?:
    | ((data: { assistantMessageId: string; mediaType: string; mimeType: string }) => void)
    | undefined;
  onMediaDone?: ((data: { assistantMessageId: string }) => void) | undefined;
  /**
   * Synthetic per-node generation progress (video). Percent never reaches
   * 100 on the wire — media-done / the run's terminal frames are completion.
   */
  onMediaProgress?: ((data: { assistantMessageId: string; percent: number }) => void) | undefined;
  /** Every tile reached a terminal stream event (or the run finished). */
  onAllModelsComplete?: (() => void) | undefined;
}

export interface ChatRunModelResult {
  modelId: string;
  assistantMessageId: string;
  errorCode?: string;
}

export type ChatRunResult =
  | { outcome: 'succeeded' | 'stopped'; models: ChatRunModelResult[] }
  | { outcome: 'replayed' }
  | { outcome: 'failed'; code: string; models: ChatRunModelResult[] }
  | { outcome: 'deadline'; models: ChatRunModelResult[] };

interface ExecuteChatRunDeps {
  socket: RunTransportSocket;
  /** Bound run-start POST; MUST reuse the same Idempotency-Key across calls. */
  postRun: () => Promise<RunStartResponse>;
  /** Pre-allocated tiles in the user's selected model order. */
  tiles: readonly ChatRunTile[];
  callbacks: ChatRunCallbacks;
  /** When tile content is published while it streams. */
  frames: FrameSource;
  /** Client-side grace past the server's deadlineAt before declaring the turn dead. */
  deadlineGraceMs?: number;
  readyTimeoutMs?: number;
}

/** Per-stream terminal error code when a branch fails (no billing implied). */
const STREAM_ERROR_CODE = ERROR_CODES.STREAM_ERROR;
/** Failure code when the transport cannot carry the run at all. */
const TRANSPORT_FAILED_CODE = ERROR_CODES.CHAT_STREAM_FAILED;
/** Floor for the client deadline timer — absorbs client/server clock skew. */
const MIN_DEADLINE_MS = 30_000;

const DEFAULT_READY_TIMEOUT_MS = 10_000;
/**
 * Ready-wait attempts before the turn is declared dead. Raising this buys
 * wall-clock for a room slow to send its `ready` frame, not further connection
 * attempts: `connect()` in `apps/web/src/lib/api/ws-client.ts` returns at once
 * while a socket object exists, so the attempts are one continuous wait. The
 * POST stays gated on a ready socket, so an exhausted budget fails exactly as a
 * single expiry did — before anything could bill.
 */
const READY_ATTEMPTS = 3;
const DEFAULT_DEADLINE_GRACE_MS = 5000;

/**
 * A tile and its mutable run state, paired so every lookup that finds one
 * finds the other — no index juggling between parallel arrays.
 */
interface TileSlot {
  /** Re-keyed when a response names the tile's answer id. */
  tile: ChatRunTile;
  readonly content: StreamContentBuilder;
  /** How much of the tile's answer projection read-aloud has already been handed. */
  spoken: number;
  resolvedModelId: string;
  bound: boolean;
  finished: boolean;
  errorCode?: string;
}

export async function executeChatRun(deps: ExecuteChatRunDeps): Promise<ChatRunResult> {
  const { socket, postRun, tiles, callbacks, frames } = deps;
  const graceMs = deps.deadlineGraceMs ?? DEFAULT_DEADLINE_GRACE_MS;

  const ready = await connectUntilReady(socket, deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  if (!ready) {
    // Never POST a run whose frames nobody can watch: an unreachable socket
    // fails the turn BEFORE anything can bill.
    return { outcome: 'failed', code: TRANSPORT_FAILED_CODE, models: [] };
  }

  // Mutable flags live in a box read through a function: they flip inside
  // closures across awaits, which control-flow narrowing cannot see (a bare
  // boolean here trips no-unnecessary-condition on genuinely necessary checks).
  const flags = { settled: false, resubmitPending: false };
  const isSettled = (): boolean => flags.settled;
  let settle!: (result: ChatRunResult) => void;
  const done = new Promise<ChatRunResult>((resolve) => {
    settle = resolve;
  });

  const slots: TileSlot[] = tiles.map((tile) => ({
    tile,
    content: createStreamContentBuilder(),
    spoken: 0,
    resolvedModelId: tile.modelId,
    bound: false,
    finished: false,
  }));
  const bindings = new Map<string, TileSlot>();
  let runId: string | null = null;
  let accepted = false;
  let allCompleteFired = false;
  let resubmitsLeft = 1;
  const timers: { deadline: ReturnType<typeof setTimeout> | null } = { deadline: null };
  const preAcceptBuffer: RunFrame[] = [];

  const models = (): ChatRunModelResult[] =>
    slots.map((slot) => ({
      modelId: slot.resolvedModelId,
      assistantMessageId: slot.tile.assistantMessageId,
      ...(slot.errorCode === undefined ? {} : { errorCode: slot.errorCode }),
    }));

  const publishContent = (slot: TileSlot): void => {
    const content = slot.content.take();
    if (content === undefined) return;
    callbacks.onContent?.(content, slot.tile.assistantMessageId);
    // The answer projection only grows as the stream does, so the tail past what
    // was already handed over is exactly what is new.
    const answer = assistantAnswerText(content);
    if (answer.length > slot.spoken) {
      callbacks.onTextDelta?.(answer.slice(slot.spoken), slot.tile.assistantMessageId);
      slot.spoken = answer.length;
    }
  };

  const settleContent = (slot: TileSlot): void => {
    slot.content.settle();
    publishContent(slot);
  };

  const finish = (result: ChatRunResult): void => {
    if (flags.settled) return;
    flags.settled = true;
    for (const slot of slots) settleContent(slot);
    settle(result);
  };

  const fireAllCompleteOnce = (): void => {
    if (allCompleteFired) return;
    allCompleteFired = true;
    callbacks.onAllModelsComplete?.();
  };

  const armDeadline = (deadlineAt: number): void => {
    if (timers.deadline !== null) clearTimeout(timers.deadline);
    const waitMs = Math.max(deadlineAt - Date.now(), MIN_DEADLINE_MS) + graceMs;
    timers.deadline = setTimeout(() => {
      finish({ outcome: 'deadline', models: models() });
    }, waitMs);
  };

  // A response naming no ids leaves the tiles where they stand: an attach that
  // finds no live run must not move them off the ids the run start named.
  const keySlots = (assistantMessageIds: readonly string[] | null): void => {
    if (assistantMessageIds === null) return;
    const keyed = keyTiles(tiles, assistantMessageIds);
    for (const [index, slot] of slots.entries()) slot.tile = keyed[index] ?? slot.tile;
  };

  const bindStream = (
    streamId: string,
    modelId: string,
    messageId: string | undefined
  ): TileSlot | undefined => {
    // A stream naming its answer id binds to the tile keyed by it. Otherwise it
    // binds to the tile that was allocated for its model; only the Smart tile
    // was allocated for a model nobody knew yet, so it takes what no pinned id
    // claims. Falling straight through to the first unbound tile binds by
    // arrival order, which streams one model's answer under another model's
    // label, and the mis-bound tile keeps the label it was rendered with.
    const slot =
      slots.find((s) => !s.bound && s.tile.assistantMessageId === messageId) ??
      slots.find((s) => !s.bound && s.tile.modelId === modelId) ??
      slots.find((s) => !s.bound && s.tile.modelId === SMART_MODEL_ID) ??
      slots.find((s) => !s.bound);
    if (!slot) return undefined;
    slot.bound = true;
    slot.resolvedModelId = modelId;
    bindings.set(streamId, slot);
    callbacks.onModelResolved?.(slot.tile.assistantMessageId, modelId);
    return slot;
  };

  const finishTile = (slot: TileSlot, errorCode?: string): void => {
    if (slot.finished) return;
    slot.finished = true;
    settleContent(slot);
    if (errorCode === undefined) {
      callbacks.onModelDone?.({
        assistantMessageId: slot.tile.assistantMessageId,
        modelId: slot.resolvedModelId,
      });
    } else {
      slot.errorCode = errorCode;
      callbacks.onModelError?.({
        assistantMessageId: slot.tile.assistantMessageId,
        modelId: slot.resolvedModelId,
        code: errorCode,
      });
    }
    if (slots.every((s) => s.finished)) fireAllCompleteOnce();
  };

  const dispatchFinish = (
    slot: TileSlot,
    event: Extract<Extract<RunFrame, { type: 'stream' }>['event'], { kind: 'finish' }>
  ): void => {
    const reasoningTokens = event.metadata.usage.reasoningTokens;
    if (reasoningTokens !== undefined) {
      callbacks.onReasoningTokens?.(reasoningTokens, slot.tile.assistantMessageId);
    }
    if (event.reasoningEffort !== undefined) {
      callbacks.onReasoningEffort?.(event.reasoningEffort, slot.tile.assistantMessageId);
    }
    finishTile(slot, event.metadata.finishReason === 'error' ? STREAM_ERROR_CODE : undefined);
  };

  const dispatchBoundEvent = (
    slot: TileSlot,
    event: Extract<RunFrame, { type: 'stream' }>['event']
  ): void => {
    slot.content.feed(event);
    switch (event.kind) {
      case 'media-start': {
        callbacks.onMediaStart?.({
          assistantMessageId: slot.tile.assistantMessageId,
          mediaType: event.modality,
          mimeType: event.mimeType,
        });
        break;
      }
      case 'media-done': {
        callbacks.onMediaDone?.({ assistantMessageId: slot.tile.assistantMessageId });
        break;
      }
      case 'media-progress': {
        callbacks.onMediaProgress?.({
          assistantMessageId: slot.tile.assistantMessageId,
          percent: event.percent,
        });
        break;
      }
      case 'finish': {
        dispatchFinish(slot, event);
        break;
      }
      default: {
        // Reasoning, step and tool events reach the tile only through its content.
        break;
      }
    }
  };

  const handleStreamFrame = (frame: Extract<RunFrame, { type: 'stream' }>): void => {
    const event = frame.event;
    if (event.kind === 'stream-start') {
      const slot = bindStream(frame.streamId, event.modelId, event.messageId);
      // A media-family stream announces its output modality up front: swap
      // the tile to its generating state now, with a placeholder mime that
      // media-start's real mime later upserts over (same tile, never a
      // second one).
      if (slot !== undefined && event.outputModality !== undefined) {
        callbacks.onMediaStart?.({
          assistantMessageId: slot.tile.assistantMessageId,
          mediaType: event.outputModality,
          mimeType: `${event.outputModality}/*`,
        });
      }
      return;
    }
    const slot = bindings.get(frame.streamId);
    if (slot === undefined) return;
    dispatchBoundEvent(slot, event);
  };

  const handleRunFinished = (frame: Extract<RunFrame, { type: 'run-finished' }>): void => {
    if (runId !== null && frame.runId !== runId) return;
    if (frame.outcome.outcome === 'succeeded') {
      // A tile with no terminal stream event on a successful run is a failed
      // optional branch — keep its error tile; the successful subset persisted.
      for (const slot of slots) {
        if (!slot.finished) finishTile(slot, STREAM_ERROR_CODE);
      }
      fireAllCompleteOnce();
      finish({ outcome: 'succeeded', models: models() });
      return;
    }
    fireAllCompleteOnce();
    if (frame.outcome.outcome === 'stopped') {
      finish({ outcome: 'stopped', models: models() });
      return;
    }
    finish({ outcome: 'failed', code: frame.outcome.code, models: models() });
  };

  const processFrame = (frame: RunFrame): void => {
    switch (frame.type) {
      case 'run-started': {
        runId ??= frame.runId;
        callbacks.onRunStarted?.(frame.runId);
        break;
      }
      case 'stream': {
        handleStreamFrame(frame);
        break;
      }
      case 'stream-gone': {
        // Replay for this stream is gone (buffer overflow / run over): stop
        // trusting the live buffer and rely on the post-run message refetch.
        break;
      }
      case 'run-finished': {
        handleRunFinished(frame);
        break;
      }
    }
  };

  const offContentFrames = frames.onFrame(() => {
    for (const slot of slots) publishContent(slot);
  });

  const releaseHeldFrames = (): void => {
    for (const frame of preAcceptBuffer.splice(0)) processFrame(frame);
  };

  const offFrames = socket.onRunFrame((frame) => {
    // The run these tiles stream ending cannot be a new run's frame, and the
    // room orders a run's frames before its run-finished, so it settles the
    // run now, after everything held ahead of it.
    const endsCurrentRun = frame.type === 'run-finished' && frame.runId === runId;
    if (!accepted || (flags.resubmitPending && !endsCurrentRun)) {
      preAcceptBuffer.push(frame);
      return;
    }
    if (flags.resubmitPending) releaseHeldFrames();
    processFrame(frame);
  });

  const applyStartResponse = (response: Extract<RunStartResponse, { kind: 'started' }>): void => {
    runId = response.runId;
    accepted = true;
    keySlots(response.assistantMessageIds);
    armDeadline(response.deadlineAt);
  };

  /**
   * A fresh 201 on the same key means the earlier execution died before
   * settlement (billed nothing): clean re-execution, tiles start over, under
   * the fresh answer ids it names.
   */
  const restartTiles = (response: Extract<RunStartResponse, { kind: 'started' }>): void => {
    bindings.clear();
    for (const slot of slots) {
      slot.content.reset();
      slot.spoken = 0;
      slot.resolvedModelId = slot.tile.modelId;
      slot.bound = false;
      slot.finished = false;
      delete slot.errorCode;
    }
    allCompleteFired = false;
    applyStartResponse(response);
    callbacks.onRestart?.(slots.map((slot) => slot.tile.assistantMessageId));
  };

  const resubmit = async (): Promise<void> => {
    if (flags.settled) return;
    if (resubmitsLeft <= 0) {
      finish({ outcome: 'failed', code: TRANSPORT_FAILED_CODE, models: models() });
      return;
    }
    resubmitsLeft -= 1;
    // The room announces a re-execution before it answers the POST, so until
    // the answer says whether the tiles start over, frames wait exactly as
    // they wait for the first POST's answer.
    flags.resubmitPending = true;
    try {
      const response = await postRun();
      if (isSettled()) return;
      if (response.kind === 'replay') {
        finish({ outcome: 'replayed' });
        return;
      }
      if (response.kind === 'started') restartTiles(response);
      else keySlots(response.assistantMessageIds);
      // attach: the run is still live, and its frames resume where they were held.
      flags.resubmitPending = false;
      releaseHeldFrames();
    } catch (error) {
      finish({
        outcome: 'failed',
        code: extractCode(error) ?? TRANSPORT_FAILED_CODE,
        models: models(),
      });
    }
  };

  let wasReady = socket.ready;
  const offState = socket.onStateChange(() => {
    const readyNow = socket.ready;
    if (!wasReady && readyNow && accepted && !flags.settled) {
      void resubmit();
    }
    wasReady = readyNow;
  });

  try {
    const response = await postRun();
    if (response.kind === 'replay') {
      return { outcome: 'replayed' };
    }
    if (response.kind === 'started') {
      applyStartResponse(response);
    } else {
      // attach to a live run this key already started (e.g. a resubmitted
      // send after reload): frames flow, but no 201 named the run's hard stop
      // in this tab, so wait out the latest hard stop of any deadline class.
      accepted = true;
      keySlots(response.assistantMessageIds);
      armDeadline(Date.now() + MAX_RUN_HARD_STOP_MS);
    }
    releaseHeldFrames();
    return await done;
  } finally {
    offFrames();
    offContentFrames();
    offState();
    if (timers.deadline !== null) clearTimeout(timers.deadline);
  }
}

async function connectUntilReady(socket: RunTransportSocket, timeoutMs: number): Promise<boolean> {
  for (let attempt = 0; attempt < READY_ATTEMPTS; attempt += 1) {
    socket.connect();
    if (await socket.waitForReady(timeoutMs)) return true;
  }
  return false;
}

function extractCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const { code } = error as { code: unknown };
  return typeof code === 'string' ? code : undefined;
}
