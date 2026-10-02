/**
 * Chat streaming over the run protocol: HTTP starts/stops the run (typed
 * client, `Idempotency-Key` per logical turn), the conversation WebSocket
 * carries the streamed output (`stream` frames demuxed per model tile by
 * `stream-start`). Replaces the legacy SSE transport wholesale — the run
 * orchestration itself lives in `@/lib/chat/run` (pure, tested without React);
 * this hook binds it to the typed client, the shared sockets, run ownership,
 * TTS, and the streaming-activity stores.
 */
import { useState, useCallback, useRef } from 'react';
import {
  ERROR_CODES,
  SMART_MODEL_ID,
  runAttachResponseSchema,
  runStartedResponseSchema,
  stripReplayHistory,
} from '@hushbox/shared';
import { useAnimationFrame } from '@hushbox/ui';
import { ApiError } from '@/lib/api/api';
import { apiErrorFromResponse } from '@/lib/api/api-error-from-response';
import { idempotencyKeyFor } from '@/lib/api/idempotent-mutation';
import { client } from '@/lib/api-client';
import { getLinkGuestAuth } from '@/lib/auth/link-guest-auth';
import { getTrialToken, setTrialToken } from '@/lib/chat/trial-token';
import { executeChatRun, keyTiles } from '@/lib/chat/run';
import { ChatRequestError } from '@/lib/chat/request-error';
import {
  acquireConversationSocket,
  releaseConversationSocket,
  acquireTrialSocket,
  releaseTrialSocket,
} from '@/lib/api/conversation-socket-registry';
import {
  markPendingLocalRun,
  resolvePendingLocalRun,
  clearPendingLocalRun,
  releaseLocalRun,
} from '@/lib/chat/run-ownership';
import { startChatTtsStream } from '@/lib/tts/chat-tts-stream';
import { queryClient } from '@/providers/query-provider';
import type {
  ChatRunCallbacks,
  ChatRunResult,
  ChatRunTile,
  FrameSource,
  RunStartResponse,
  RunTransportSocket,
} from '@/lib/chat/run';
import type {
  ChatModality,
  ImageConfig,
  VideoConfig,
  AudioConfig,
  ReasoningEffortSelection,
  ResolvedReasoningEffort,
  TurnSource,
} from '@hushbox/shared';
import type { InferRequestType } from 'hono/client';

export { ChatRequestError } from '@/lib/chat/request-error';

type StreamMode = 'authenticated' | 'trial';

/** History entry accepted by the run routes (system prompts never ride history). */
interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** Caller-supplied inference context entry (legacy shape; system entries are dropped). */
export interface InferenceMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface AuthenticatedStreamRequest {
  conversationId: string;
  modality?: ChatModality;
  models: string[];
  /** The prompt. The server mints the user message id and returns it on the run start. */
  userMessage: {
    content: string;
  };
  messagesForInference: InferenceMessage[];
  /** Legacy caller field; funding is resolved server-side and never sent. */
  fundingSource: string;
  webSearchEnabled?: boolean;
  /**
   * Reasoning selection, model-clamped AND lowered to what the payer can fund
   * (see useReasoningEffort); absent = reasoning-free turn.
   */
  reasoningEffort?: ReasoningEffortSelection;
  /**
   * The user's custom instructions in plaintext. Stored E2E-encrypted, so
   * resending them each turn is the only way the server can fold them into the
   * system prompt it prices, hashes and sends.
   */
  customInstructions?: string;
  forkId?: string;
  imageConfig?: ImageConfig;
  videoConfig?: VideoConfig;
  /** Legacy caller field; audio turns are not part of the run protocol. */
  audioConfig?: AudioConfig;
}

interface TrialStreamMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TrialStreamRequest {
  messages: TrialStreamMessage[];
  model: string;
  webSearchEnabled?: boolean;
  /**
   * Reasoning selection, model-clamped AND lowered to what the trial ceiling can
   * fund; the trial route refuses non-fitting levels.
   */
  reasoningEffort?: ReasoningEffortSelection;
}

export interface RegenerateStreamRequest {
  conversationId: string;
  targetMessageId: string;
  action: 'retry' | 'edit';
  replaceAssistantId?: string;
  modality?: ChatModality;
  models: string[];
  userMessage: {
    content: string;
  };
  messagesForInference: InferenceMessage[];
  fundingSource: string;
  forkId?: string;
  webSearchEnabled?: boolean;
  /**
   * Reasoning selection, model-clamped AND lowered to what the payer can fund
   * (see useReasoningEffort); absent = reasoning-free re-run.
   */
  reasoningEffort?: ReasoningEffortSelection;
  customInstructions?: string;
  imageConfig?: ImageConfig;
  videoConfig?: VideoConfig;
  audioConfig?: AudioConfig;
}

type StreamRequest = AuthenticatedStreamRequest | TrialStreamRequest;

export interface ModelResult {
  modelId: string;
  assistantMessageId: string;
  errorCode?: string;
}

export interface StreamResult {
  /** The id the server stores the turn's user message under; null when it named none. */
  userMessageId: string | null;
  models: ModelResult[];
  outcome: 'succeeded' | 'stopped' | 'replayed';
}

export interface StartModelEntry {
  modelId: string;
  assistantMessageId: string;
}

export interface StartEventData {
  /**
   * The id the server minted for the turn's user message, read off the run-start
   * response (a retry's is its anchor's). Null when the response named none: an
   * attach finding no live run in the room, or a trial run, which stores no user
   * message.
   */
  userMessageId: string | null;
  /**
   * One tile per selected model, in the selected order, each under the id the
   * server minted for its answer. A tile stays on a local key when the response
   * named no answer ids: a trial run stores no row.
   */
  models: StartModelEntry[];
}

export interface RekeyEventData extends StartEventData {
  /** The tiles as they stood before the re-execution named new ids. */
  previousModels: StartModelEntry[];
}

export interface ModelDoneData {
  modelId: string;
  assistantMessageId: string;
}

export interface ModelErrorData {
  modelId: string;
  assistantMessageId: string;
  code: string;
}

export interface ModelMediaStartData {
  assistantMessageId: string;
  mediaType: 'image' | 'audio' | 'video';
  mimeType: string;
}

export interface StreamOptions {
  /** The run was accepted — tiles exist; fires once per logical turn. */
  onStart?: (data: StartEventData) => void;
  /**
   * A same-key resubmit started a fresh run whose run-start response named new
   * ids: the fresh answer ids a re-execution mints, and a new user message id for
   * a send or an edit. Settlement stores the turn under them, so the turn's user
   * row and its tiles move onto them. Fires before that run's first frame.
   */
  onRekey?: (data: RekeyEventData) => void;
  /**
   * A tile's content, built from every one of its stream events through the
   * shared builder: at most once per rendered frame while it streams, and at
   * once when the tile finishes or the run ends.
   */
  onContent?: (content: string, assistantMessageId: string) => void;
  /**
   * The finish frame's billed reasoning token count for a tile — the live
   * source for the settled "Reasoned…" label before the persisted refetch.
   */
  onReasoningTokens?: (count: number, assistantMessageId: string) => void;
  /**
   * The finish frame's resolved reasoning level for a tile — the same
   * resolution the run persists, delivered live so the effort badge renders
   * without a reload. Absent on a levelless stream; `off` arrives as itself.
   */
  onReasoningEffort?: (effort: ResolvedReasoningEffort, assistantMessageId: string) => void;
  /**
   * The stream's `stream-start` label. For a Smart Model tile this is the
   * classifier-resolved model id.
   */
  onModelResolved?: (assistantMessageId: string, modelId: string) => void;
  /** A same-key re-execution began after a transport loss: reset tile content. */
  onRestart?: (assistantMessageIds: string[]) => void;
  onModelDone?: (data: ModelDoneData) => void;
  onModelError?: (data: ModelErrorData) => void;
  onModelMediaStart?: (data: ModelMediaStartData) => void;
  /**
   * Synthetic per-node video generation progress. The wire never says 100 —
   * `onModelMediaDone` (or the run's terminal frames) is completion.
   */
  onModelMediaProgress?: (data: { assistantMessageId: string; percent: number }) => void;
  onModelMediaDone?: (data: { assistantMessageId: string }) => void;
  onRunStarted?: (runId: string) => void;
  /** Every tile reached a terminal stream event — tokens stopped flowing. */
  onAllModelsComplete?: () => void;
  /** The run reached its terminal state (settled server-side). */
  onAllStreamsSettled?: () => void;
}

/**
 * A run that terminated without settling content: an involuntary kill
 * (deadline, engine failure) bills nothing — surface "turn failed, not
 * billed" UX keyed on `code`.
 */
export class ChatRunFailedError extends Error {
  constructor(
    public readonly code: string,
    public readonly notBilled = true
  ) {
    super(code);
    this.name = 'ChatRunFailedError';
  }
}

interface ChatStreamHook {
  isStreaming: boolean;
  startStream: (request: StreamRequest, options?: StreamOptions) => Promise<StreamResult>;
  startRegenerateStream: (
    request: RegenerateStreamRequest,
    options?: StreamOptions
  ) => Promise<StreamResult>;
  /** Explicit user stop — plain HTTP; the server settles + bills the partial. */
  stopRun: (conversationId: string) => Promise<boolean>;
}

type MediaEventType = 'image' | 'audio' | 'video';

function isMediaEventType(value: string): value is MediaEventType {
  return value === 'image' || value === 'audio' || value === 'video';
}

function extractErrorBody(data: unknown): { code: string; details?: Record<string, unknown> } {
  if (typeof data === 'object' && data !== null && 'code' in data) {
    const { code } = data as { code: unknown };
    const details =
      'details' in data
        ? ((data as { details?: Record<string, unknown> }).details ?? undefined)
        : undefined;
    if (typeof code === 'string') return { code, ...(details === undefined ? {} : { details }) };
  }
  return { code: 'INTERNAL' };
}

type ParsedRunStart = RunStartResponse & { trialSessionId?: string; userMessageId: string | null };

/** What an authenticated turn has announced of its run starts so far. */
interface AnnouncedStart {
  startFired: boolean;
  /** The id the latest announced run-start response named for the user message. */
  userMessageId: string | null;
  /** The tiles as the latest announced response keyed them; local keys until one names ids. */
  models: StartModelEntry[];
}

function sameTileIds(a: readonly StartModelEntry[], b: readonly StartModelEntry[]): boolean {
  return a.every((entry, index) => entry.assistantMessageId === b[index]?.assistantMessageId);
}

/**
 * Hands an accepted run-start response to the turn's callbacks. The first one
 * starts the turn, its tiles keyed by the answer ids the response named. A later
 * fresh 201 is a same-key re-execution, and when it named new ids the turn
 * re-keys onto them: a re-execution mints fresh answer ids, and the route mints
 * a new user message id for a send or an edit, while a retry keeps its anchor's.
 */
function announceRunStart(
  response: ParsedRunStart,
  announced: AnnouncedStart,
  options: StreamOptions | undefined
): void {
  if (response.kind === 'replay') return;
  const models = keyTiles(announced.models, response.assistantMessageIds);
  if (!announced.startFired) {
    announced.startFired = true;
    announced.userMessageId = response.userMessageId;
    announced.models = models;
    options?.onStart?.({ userMessageId: response.userMessageId, models });
    return;
  }
  if (response.kind !== 'started') return;
  if (response.userMessageId === announced.userMessageId && sameTileIds(models, announced.models)) {
    return;
  }
  const previousModels = announced.models;
  announced.userMessageId = response.userMessageId;
  announced.models = models;
  options?.onRekey?.({ userMessageId: response.userMessageId, models, previousModels });
}

/**
 * Maps an accepted run-start body that is not a fresh run onto the transport
 * outcome union. 200 `{outcome:'attach'}` = same-key run still live (rejoin),
 * parsed with the shared attach schema; any other 200 = replay of the settled
 * run (treat terminal, refetch).
 */
function parseNonStarted(data: unknown): ParsedRunStart {
  if (typeof data === 'object' && data !== null && 'outcome' in data && data.outcome === 'attach') {
    const body = runAttachResponseSchema.parse(data);
    return {
      kind: 'attach',
      userMessageId: body.userMessageId,
      assistantMessageIds: body.assistantMessageIds,
    };
  }
  return { kind: 'replay', userMessageId: null };
}

/**
 * Maps an accepted paid run-start Response onto the transport outcome union.
 * 201 = fresh run (watch the WS), parsed with the shared run-start schema, so a
 * body that names no user message or answer ids rejects the turn.
 */
async function parseRunStartResponse(response: Response): Promise<ParsedRunStart> {
  const data: unknown = await response.json().catch(() => ({}));
  if (response.status !== 201) return parseNonStarted(data);
  const body = runStartedResponseSchema.parse(data);
  return {
    kind: 'started',
    runId: body.runId,
    deadlineAt: body.deadlineAt,
    userMessageId: body.userMessageId,
    assistantMessageIds: body.assistantMessageIds,
  };
}

/**
 * Maps an accepted trial run-start Response onto the transport outcome union. A
 * trial run stores no rows, so its 201 names no message ids, only the trial
 * session it opened.
 */
async function parseTrialRunStartResponse(response: Response): Promise<ParsedRunStart> {
  const data: unknown = await response.json().catch(() => ({}));
  if (response.status !== 201) return parseNonStarted(data);
  const body = data as { runId: string; deadlineAt: number; trialSessionId?: string };
  return {
    kind: 'started',
    runId: body.runId,
    deadlineAt: body.deadlineAt,
    userMessageId: null,
    assistantMessageIds: null,
    ...(body.trialSessionId === undefined ? {} : { trialSessionId: body.trialSessionId }),
  };
}

/**
 * Sends one run-start POST as a mutation on the app's query client, so it is
 * retried exactly as every other keyed write is. The key is minted from the
 * turn object, so every attempt and every resubmit of one turn carries the
 * same key. A refusal the policy stops re-sending surfaces as the
 * `ChatRequestError` callers map to copy.
 */
async function sendRunStart(
  turn: object,
  post: (idempotencyKey: string) => Promise<Response>
): Promise<Response> {
  try {
    return await queryClient
      .getMutationCache()
      .build(queryClient, {
        mutationFn: async (variables: object): Promise<Response> => {
          const response = await post(idempotencyKeyFor(variables));
          if (!response.ok) throw await apiErrorFromResponse(response);
          return response;
        },
      })
      .execute(turn);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    const { code, details } = extractErrorBody(error.data);
    throw new ChatRequestError(code, details, error.status);
  }
}

/**
 * Drops the trailing current-turn user message (it rides `userMessage`, not
 * `history`), strips system entries (instructions ride the body's own
 * `customInstructions` field, never `history`), drops empty contents (the
 * schema requires min(1)), and strips embedded reasoning from assistant turns
 * through the shared trim — the same one the server applies before it counts,
 * so the bytes this body carries are the bytes both sides measure.
 */
function toHistory(
  messages: readonly InferenceMessage[],
  currentUserContent: string
): HistoryMessage[] {
  const entries = [...messages];
  const last = entries.at(-1);
  if (last?.role === 'user' && last.content === currentUserContent) {
    entries.pop();
  }
  const replayable = entries.filter(
    (m): m is HistoryMessage =>
      (m.role === 'user' || m.role === 'assistant') && m.content.length > 0
  );
  return [...stripReplayHistory(replayable)];
}

/** The turn's output modality on the wire (audio never ships on the run routes). */
function wireModality(modality: ChatModality | undefined): 'text' | 'image' | 'video' {
  return modality === 'image' || modality === 'video' ? modality : 'text';
}

/**
 * The send body, derived from the route it is posted to rather than re-typed
 * beside it: a hand-written mirror of a server schema is a sync contract, and
 * this one had already drifted into permitting a field the route no longer
 * carries.
 */
type TurnWireBody = InferRequestType<typeof client.chat.$post>['json'];

/**
 * The client's selection (a flat id list, with the Smart slot carried as the
 * sentinel id the picker stores) encoded onto the wire vocabulary. Order is
 * preserved — it is the tile order.
 */
function toTurnSources(models: readonly string[]): TurnSource[] {
  return models.map((id) => (id === SMART_MODEL_ID ? { kind: 'smart' } : { kind: 'model', id }));
}

function buildTurnBody(request: AuthenticatedStreamRequest): TurnWireBody {
  if (request.models.length === 0) throw new ChatRequestError('VALIDATION');
  return {
    conversationId: request.conversationId,
    turnSources: toTurnSources(request.models),
    modality: wireModality(request.modality),
    ...(request.forkId === undefined ? {} : { forkId: request.forkId }),
    ...(request.webSearchEnabled === undefined
      ? {}
      : { webSearchEnabled: request.webSearchEnabled }),
    ...(request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort }),
    ...(request.imageConfig === undefined ? {} : { imageConfig: request.imageConfig }),
    ...(request.videoConfig === undefined ? {} : { videoConfig: request.videoConfig }),
    ...(request.customInstructions === undefined
      ? {}
      : { customInstructions: request.customInstructions }),
    userMessage: request.userMessage,
    history: toHistory(request.messagesForInference, request.userMessage.content),
  };
}

/**
 * Tiles are pre-allocated client-side in the user's selected order, each on a
 * local key until the run-start response names the id the server minted for its
 * answer. The Smart slot gets its own tile, whose label resolves via
 * `stream-start`; it does not swallow the siblings selected beside it.
 */
function buildTiles(models: readonly string[]): ChatRunTile[] {
  return models.map((modelId) => ({
    modelId,
    assistantMessageId: crypto.randomUUID(),
  }));
}

interface TtsFeederLike {
  feed: (token: string) => void;
  end: () => void;
}

function wireMediaStart(
  options: StreamOptions | undefined
): (data: { assistantMessageId: string; mediaType: string; mimeType: string }) => void {
  return (data) => {
    if (!isMediaEventType(data.mediaType)) return;
    options?.onModelMediaStart?.({
      assistantMessageId: data.assistantMessageId,
      mediaType: data.mediaType,
      mimeType: data.mimeType,
    });
  };
}

/** Reads the primary tile's id as it stands now: its local key, then the id its answer was minted. */
type PrimaryAssistantId = () => string | null;

function wireTextDelta(
  primaryAssistantId: PrimaryAssistantId,
  ttsFeeder: TtsFeederLike | null
): ((text: string, assistantMessageId: string) => void) | undefined {
  if (ttsFeeder === null) return undefined;
  return (text, assistantMessageId) => {
    if (assistantMessageId === primaryAssistantId()) ttsFeeder.feed(text);
  };
}

function wireCallbacks(
  options: StreamOptions | undefined,
  primaryAssistantId: PrimaryAssistantId,
  ttsFeeder: TtsFeederLike | null
): ChatRunCallbacks {
  const handlers = options ?? {};
  return {
    onRunStarted: handlers.onRunStarted,
    onModelResolved: handlers.onModelResolved,
    onRestart: handlers.onRestart,
    onContent: handlers.onContent,
    onTextDelta: wireTextDelta(primaryAssistantId, ttsFeeder),
    onReasoningTokens: handlers.onReasoningTokens,
    onReasoningEffort: handlers.onReasoningEffort,
    onModelDone: handlers.onModelDone,
    onModelError: handlers.onModelError,
    onMediaStart: wireMediaStart(options),
    onMediaProgress: handlers.onModelMediaProgress,
    onMediaDone: handlers.onModelMediaDone,
    onAllModelsComplete: handlers.onAllModelsComplete,
  };
}

function toStreamResult(result: ChatRunResult, userMessageId: string | null): StreamResult {
  if (result.outcome === 'replayed') {
    return { userMessageId, models: [], outcome: 'replayed' };
  }
  if (result.outcome === 'failed' || result.outcome === 'deadline') {
    throw new ChatRunFailedError(
      result.outcome === 'deadline' ? ERROR_CODES.CHAT_STREAM_FAILED : result.code
    );
  }
  return { userMessageId, models: result.models, outcome: result.outcome };
}

/** Persist the server-confirmed trial session id (first send mints it client-side). */
function storeTrialSessionId(trialSessionId: string | undefined): void {
  if (trialSessionId !== undefined) {
    setTrialToken(trialSessionId);
  }
}

export function useChatStream(mode: StreamMode): ChatStreamHook {
  const [isStreaming, setIsStreaming] = useState(false);
  // Counts in-flight turns. A counter (not a boolean) keeps the flag correct
  // if a settling turn's cleanup runs while a newer one is already active.
  const processingCountRef = useRef(0);
  const releaseProcessing = useCallback((): void => {
    processingCountRef.current = Math.max(0, processingCountRef.current - 1);
    setIsStreaming(processingCountRef.current > 0);
  }, []);

  const frameListenersRef = useRef(new Set<() => void>());
  const [frames] = useState<FrameSource>(() => ({
    onFrame(listener) {
      frameListenersRef.current.add(listener);
      return () => {
        frameListenersRef.current.delete(listener);
      };
    },
  }));
  // Streamed text is content, not animation: it must keep updating under reduced motion.
  useAnimationFrame(
    () => {
      for (const listener of frameListenersRef.current) listener();
    },
    { respectMotion: false, paused: !isStreaming }
  );

  const runAuthenticated = useCallback(
    async (run: {
      conversationId: string;
      tiles: ChatRunTile[];
      /** Read once the run ends: the id arrives on the run-start response. */
      userMessageId: () => string | null;
      primaryAssistantId: PrimaryAssistantId;
      postRun: () => Promise<RunStartResponse>;
      options?: StreamOptions | undefined;
    }): Promise<StreamResult> => {
      const { conversationId, tiles, userMessageId, primaryAssistantId, postRun, options } = run;
      const socket = acquireConversationSocket(conversationId);
      const ttsFeeder = await startChatTtsStream({ messageId: primaryAssistantId });
      try {
        const result = await executeChatRun({
          socket: socket as RunTransportSocket,
          postRun,
          tiles,
          callbacks: wireCallbacks(options, primaryAssistantId, ttsFeeder),
          frames,
        });
        return toStreamResult(result, userMessageId());
      } finally {
        ttsFeeder?.end();
        releaseConversationSocket(conversationId);
      }
    },
    [frames]
  );

  const runTurn = useCallback(
    async (
      request: AuthenticatedStreamRequest | RegenerateStreamRequest,
      options: StreamOptions | undefined,
      post: (key: string) => Promise<Response>
    ): Promise<StreamResult> => {
      // The turn's Idempotency-Key is minted from this object, never from the
      // request: a request resent as a new turn must not replay this one.
      const turn = {};
      const tiles = buildTiles(request.models);
      const conversationId = request.conversationId;
      // Boxed: changes inside the postRun closure across awaits, which
      // control-flow narrowing cannot see. `pendingMarks` counts the marks this
      // turn still holds, so the turn's end releases exactly those.
      const ownership = { pendingMarks: 0, posted: false, ended: false };
      const announced: AnnouncedStart = {
        startFired: false,
        userMessageId: null,
        models: tiles.map((tile) => ({
          modelId: tile.modelId,
          assistantMessageId: tile.assistantMessageId,
        })),
      };
      const localRunIds = new Set<string>();
      const markPending = (): void => {
        markPendingLocalRun(conversationId);
        ownership.pendingMarks += 1;
      };
      const clearPending = (): void => {
        clearPendingLocalRun(conversationId);
        ownership.pendingMarks -= 1;
      };

      markPending();
      const postRun = async (): Promise<RunStartResponse> => {
        // A resubmit can start a new run whose frames land before its 201, so
        // it is pending as the tab's own exactly as the first send is.
        const resubmit = ownership.posted;
        ownership.posted = true;
        if (resubmit) markPending();
        const response = await parseRunStartResponse(await sendRunStart(turn, post));
        // A resubmit answered after the turn ended starts a run this turn never
        // shows, and its mark was already released, so nothing claims the run.
        if (response.kind === 'started' && !ownership.ended) {
          resolvePendingLocalRun(conversationId, response.runId);
          ownership.pendingMarks -= 1;
          localRunIds.add(response.runId);
        }
        announceRunStart(response, announced, options);
        return response;
      };

      try {
        return await runAuthenticated({
          conversationId,
          tiles,
          userMessageId: () => announced.userMessageId,
          primaryAssistantId: () => announced.models[0]?.assistantMessageId ?? null,
          postRun,
          options,
        });
      } finally {
        ownership.ended = true;
        while (ownership.pendingMarks > 0) clearPending();
        for (const runId of localRunIds) releaseLocalRun(conversationId, runId);
        options?.onAllStreamsSettled?.();
      }
    },
    [runAuthenticated]
  );

  const runTrial = useCallback(
    async (request: TrialStreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      // The turn's Idempotency-Key is minted from this object, never from the
      // request: a request resent as a new turn must not replay this one.
      const turn = {};
      const trialToken = getTrialToken();
      const lastMessage = request.messages.at(-1);
      if (lastMessage?.role !== 'user') {
        throw new ChatRequestError('VALIDATION');
      }
      const history = [
        ...stripReplayHistory(
          request.messages
            .slice(0, -1)
            .filter((m) => m.content.length > 0)
            .map((m) => ({ role: m.role, content: m.content }))
        ),
      ];
      const tiles = buildTiles([request.model]);
      let startFired = false;

      const postRun = async (): Promise<RunStartResponse> => {
        const send = (idempotencyKey: string): Promise<Response> =>
          client.chat.trial.$post(
            {
              json: {
                turnSources: toTurnSources([request.model]),
                prompt: lastMessage.content,
                ...(request.webSearchEnabled === undefined
                  ? {}
                  : { webSearchEnabled: request.webSearchEnabled }),
                ...(request.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: request.reasoningEffort }),
                ...(history.length > 0 ? { history } : {}),
              },
            },
            {
              headers: {
                'Idempotency-Key': idempotencyKey,
                'x-trial-token': trialToken,
              },
            }
          );
        const response = await parseTrialRunStartResponse(await sendRunStart(turn, send));
        if (response.kind === 'started') {
          storeTrialSessionId(response.trialSessionId);
        }
        if (response.kind !== 'replay' && !startFired) {
          startFired = true;
          options?.onStart?.({
            userMessageId: null,
            models: tiles.map((tile) => ({
              modelId: tile.modelId,
              assistantMessageId: tile.assistantMessageId,
            })),
          });
        }
        return response;
      };

      const socket = acquireTrialSocket(trialToken);
      // A trial run stores no row, so its tile keeps its local key throughout.
      const primaryAssistantId = (): string | null => tiles[0]?.assistantMessageId ?? null;
      const ttsFeeder = await startChatTtsStream({ messageId: primaryAssistantId });
      try {
        const result = await executeChatRun({
          socket: socket as RunTransportSocket,
          postRun,
          tiles,
          callbacks: wireCallbacks(options, primaryAssistantId, ttsFeeder),
          frames,
        });
        return toStreamResult(result, null);
      } finally {
        ttsFeeder?.end();
        releaseTrialSocket(trialToken);
        options?.onAllStreamsSettled?.();
      }
    },
    [frames]
  );

  const track = useCallback(
    async (work: () => Promise<StreamResult>): Promise<StreamResult> => {
      processingCountRef.current += 1;
      setIsStreaming(true);
      try {
        return await work();
      } finally {
        releaseProcessing();
      }
    },
    [releaseProcessing]
  );

  const startStream = useCallback(
    (request: StreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      if (mode === 'trial') {
        return track(() => runTrial(request as TrialStreamRequest, options));
      }
      const authenticated = request as AuthenticatedStreamRequest;
      return track(() =>
        runTurn(authenticated, options, (key) => {
          const body = buildTurnBody(authenticated);
          const headers = { 'Idempotency-Key': key };
          return getLinkGuestAuth()
            ? client.chat.guest.$post({ json: body }, { headers })
            : client.chat.$post({ json: body }, { headers });
        })
      );
    },
    [mode, track, runTurn, runTrial]
  );

  const startRegenerateStream = useCallback(
    (request: RegenerateStreamRequest, options?: StreamOptions): Promise<StreamResult> => {
      return track(() =>
        runTurn(request, options, (key) => {
          if (request.models.length === 0) throw new ChatRequestError('VALIDATION');
          return client.chat.regenerate.$post(
            {
              json: {
                conversationId: request.conversationId,
                turnSources: toTurnSources(request.models),
                modality: wireModality(request.modality),
                ...(request.imageConfig === undefined ? {} : { imageConfig: request.imageConfig }),
                ...(request.videoConfig === undefined ? {} : { videoConfig: request.videoConfig }),
                targetMessageId: request.targetMessageId,
                action: request.action,
                ...(request.replaceAssistantId === undefined
                  ? {}
                  : { replaceAssistantId: request.replaceAssistantId }),
                ...(request.forkId === undefined ? {} : { forkId: request.forkId }),
                ...(request.webSearchEnabled === undefined
                  ? {}
                  : { webSearchEnabled: request.webSearchEnabled }),
                ...(request.reasoningEffort === undefined
                  ? {}
                  : { reasoningEffort: request.reasoningEffort }),
                ...(request.customInstructions === undefined
                  ? {}
                  : { customInstructions: request.customInstructions }),
                userMessage: request.userMessage,
                history: toHistory(request.messagesForInference, request.userMessage.content),
              },
            },
            { headers: { 'Idempotency-Key': key } }
          );
        })
      );
    },
    [track, runTurn]
  );

  const stopRun = useCallback(async (conversationId: string): Promise<boolean> => {
    const response = await client.chat.stop.$post(
      { json: { conversationId } },
      { headers: { 'Idempotency-Key': crypto.randomUUID() } }
    );
    const data: unknown = await response.json().catch(() => ({}));
    if (!response.ok) {
      const { code, details } = extractErrorBody(data);
      throw new ChatRequestError(code, details, response.status);
    }
    return typeof data === 'object' && data !== null && 'stopped' in data
      ? Boolean((data as { stopped: unknown }).stopped)
      : false;
  }, []);

  return { isStreaming, startStream, startRegenerateStream, stopRun };
}
