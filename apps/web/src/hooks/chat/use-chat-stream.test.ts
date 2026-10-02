import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
  historyCharacterCount,
  parseAssistantMessage,
  serializeSegments,
  SMART_MODEL_ID,
} from '@hushbox/shared';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import {
  useChatStream,
  ChatRequestError,
  ChatRunFailedError,
  type AuthenticatedStreamRequest,
  type RegenerateStreamRequest,
  type TrialStreamRequest,
  type StreamResult,
  type RekeyEventData,
} from '@/hooks/chat/use-chat-stream';
import { resetRunOwnershipForTests, isLocalRun } from '@/lib/chat/run-ownership';
import { useRemoteStreaming } from '@/hooks/realtime/use-remote-streaming';
import { queryClient } from '@/providers/query-provider';
import { chatKeys } from '@/hooks/chat/chat';
import type { RunFrame } from '@/lib/api/server-frames';
import type { ConversationWebSocket } from '@/lib/api/ws-client';
// Type-only: the mocked module supplies the runtime spies, while the wire-field
// maps below are typed against the REAL route bodies.
import type { client } from '@/lib/api-client';
import type { InferRequestType } from 'hono/client';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

interface FakeSocket {
  connect: () => void;
  waitForReady: (timeoutMs: number) => Promise<boolean>;
  readonly ready: boolean;
  onRunFrame: (listener: (frame: RunFrame) => void) => () => void;
  onStateChange: (listener: () => void) => () => void;
  emit: (frame: RunFrame) => void;
}

function createFakeSocket(): FakeSocket {
  const frameListeners = new Set<(frame: RunFrame) => void>();
  const stateListeners = new Set<() => void>();
  return {
    connect: vi.fn(),
    waitForReady: () => Promise.resolve(true),
    ready: true,
    onRunFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    emit(frame) {
      for (const listener of frameListeners) listener(frame);
    },
  };
}

interface ReconnectableSocket extends FakeSocket {
  readonly conversationId: string;
  onLiveRun: () => () => void;
  /** Drops the connection and brings it back, as a reconnect does. */
  reconnect: () => void;
}

/** A conversation socket that can reconnect, and that a watcher hook can also read. */
function createReconnectableSocket(): ReconnectableSocket {
  const frameListeners = new Set<(frame: RunFrame) => void>();
  const stateListeners = new Set<() => void>();
  let ready = true;
  const setReady = (value: boolean): void => {
    ready = value;
    for (const listener of stateListeners) listener();
  };
  return {
    conversationId: 'conv-1',
    connect: vi.fn(),
    waitForReady: () => Promise.resolve(ready),
    get ready(): boolean {
      return ready;
    },
    onRunFrame(listener) {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    onLiveRun: () => () => {},
    emit(frame) {
      for (const listener of frameListeners) listener(frame);
    },
    reconnect() {
      setReady(false);
      setReady(true);
    },
  };
}

const sockets = vi.hoisted(() => ({
  conversation: null as unknown,
  trial: null as unknown,
  acquireConversation: vi.fn(),
  releaseConversation: vi.fn(),
  acquireTrial: vi.fn(),
  releaseTrial: vi.fn(),
}));

vi.mock('@/lib/api/conversation-socket-registry', () => ({
  acquireConversationSocket: (id: string): unknown => {
    sockets.acquireConversation(id);
    return sockets.conversation;
  },
  releaseConversationSocket: (id: string): void => {
    sockets.releaseConversation(id);
  },
  acquireTrialSocket: (token: string): unknown => {
    sockets.acquireTrial(token);
    return sockets.trial;
  },
  releaseTrialSocket: (token: string): void => {
    sockets.releaseTrial(token);
  },
}));

const postSpies = vi.hoisted(() => ({
  chat: vi.fn(),
  guest: vi.fn(),
  regenerate: vi.fn(),
  trial: vi.fn(),
  stop: vi.fn(),
}));

vi.mock('@/lib/api-client', () => ({
  client: {
    chat: {
      $post: (...args: unknown[]): unknown => postSpies.chat(...args),
      guest: { $post: (...args: unknown[]): unknown => postSpies.guest(...args) },
      regenerate: { $post: (...args: unknown[]): unknown => postSpies.regenerate(...args) },
      trial: { $post: (...args: unknown[]): unknown => postSpies.trial(...args) },
      stop: { $post: (...args: unknown[]): unknown => postSpies.stop(...args) },
    },
  },
}));

const mockGetLinkGuestAuth = vi.hoisted(() => vi.fn<() => string | null>(() => null));
vi.mock('@/lib/auth/link-guest-auth', () => ({
  getLinkGuestAuth: (): string | null => mockGetLinkGuestAuth(),
}));

interface FakeTtsFeeder {
  feed: (token: string) => void;
  end: () => void;
}

const ttsMock = vi.hoisted(() => ({
  feeder: null as { feed: (token: string) => void; end: () => void } | null,
  probedMessageIds: [] as (string | null)[],
  /** The id getter the feeder reads each time it speaks, as the real one does. */
  messageId: null as (() => string | null) | null,
}));
vi.mock('@/lib/tts/chat-tts-stream', () => ({
  // Probe the messageId closure like the real feeder does when it binds the
  // primary tile; return the configured feeder (null = TTS off, the default).
  startChatTtsStream: (options: {
    messageId: () => string | null;
  }): Promise<FakeTtsFeeder | null> => {
    ttsMock.probedMessageIds.push(options.messageId());
    ttsMock.messageId = options.messageId;
    return Promise.resolve(ttsMock.feeder);
  },
}));

function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The user message id the server minted for the run the fake 201 starts. */
const SERVER_USER_MESSAGE_ID = 'server-user-msg-1';

/** A paid run start naming one answer id per selected model, one model by default. */
const startedResponse = (runId = 'run-1', assistantMessageIds = ['server-answer-1']): Response =>
  jsonResponse(
    {
      runId,
      deadlineAt: Date.now() + 300_000,
      userMessageId: SERVER_USER_MESSAGE_ID,
      assistantMessageIds,
    },
    201
  );

function baseRequest(
  overrides: Partial<AuthenticatedStreamRequest> = {}
): AuthenticatedStreamRequest {
  return {
    conversationId: 'conv-1',
    models: ['model-a'],
    userMessage: { content: 'hello' },
    messagesForInference: [{ role: 'user', content: 'hello' }],
    fundingSource: 'personal_balance',
    ...overrides,
  };
}

/**
 * A stored assistant turn holding a reasoning segment and its answer, with the
 * answer bytes that survive a replay trim named separately so a test can state
 * the expected count without re-deriving it from the stored text.
 */
const REPLAYED_ANSWER = 'earlier answer';
const REPLAYED_ASSISTANT = serializeSegments([
  { kind: 'reasoning', children: [{ kind: 'text', text: 'chain of thought' }] },
  { kind: 'text', text: REPLAYED_ANSWER },
]);

interface StreamStartCapture {
  tiles: { modelId: string; assistantMessageId: string }[];
}

/**
 * Detaches a promise so a rejection before the test's own await cannot
 * surface as an unhandled rejection (the test still awaits/asserts it).
 */
function armed(promise: Promise<unknown>): void {
  void (async (): Promise<void> => {
    try {
      await promise;
    } catch {
      // observed by the test's own await/assertion
    }
  })();
}

interface AnimationFrames {
  /** Runs every frame callback queued so far, as one rendered frame. */
  run(): void;
  restore(): void;
}

/** Replaces the browser's frame scheduler with a queue the test drains by hand. */
function mockAnimationFrames(): AnimationFrames {
  const original = {
    request: globalThis.requestAnimationFrame,
    cancel: globalThis.cancelAnimationFrame,
  };
  let queue = new Map<number, FrameRequestCallback>();
  let nextId = 1;
  const define = (name: 'requestAnimationFrame' | 'cancelAnimationFrame', value: unknown): void => {
    Object.defineProperty(globalThis, name, { writable: true, configurable: true, value });
  };
  define('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const id = nextId;
    nextId += 1;
    queue.set(id, callback);
    return id;
  });
  define('cancelAnimationFrame', (id: number): void => {
    queue.delete(id);
  });
  return {
    run(): void {
      const due = [...queue.values()];
      queue = new Map();
      for (const callback of due) callback(0);
    },
    restore(): void {
      define('requestAnimationFrame', original.request);
      define('cancelAnimationFrame', original.cancel);
    },
  };
}

function emitStream(
  socket: FakeSocket,
  cursor: number,
  event: Extract<RunFrame, { type: 'stream' }>['event']
): void {
  socket.emit({ type: 'stream', streamId: 'answer0#0', cursor, event });
}

/** Drives a run to success by emitting the full frame sequence for each tile. */
function finishRun(socket: FakeSocket, capture: StreamStartCapture, content = 'Hi'): void {
  for (const [index, tile] of capture.tiles.entries()) {
    const streamId = `answer${String(index)}#${String(index)}`;
    socket.emit({
      type: 'stream',
      streamId,
      cursor: 1,
      event: { kind: 'stream-start', modelId: tile.modelId },
    } as RunFrame);
    socket.emit({
      type: 'stream',
      streamId,
      cursor: 2,
      event: { kind: 'text-delta', index: 0, content },
    } as RunFrame);
    socket.emit({
      type: 'stream',
      streamId,
      cursor: 3,
      event: {
        kind: 'finish',
        metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      },
    } as RunFrame);
  }
  socket.emit({
    type: 'run-finished',
    runId: 'run-1',
    outcome: { outcome: 'succeeded' },
  } as RunFrame);
}

describe('useChatStream (run transport)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRunOwnershipForTests();
    localStorage.clear();
    sockets.conversation = createFakeSocket();
    sockets.trial = createFakeSocket();
    mockGetLinkGuestAuth.mockReturnValue(null);
    ttsMock.feeder = null;
    ttsMock.probedMessageIds = [];
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('authenticated send', () => {
    it('POSTs the run body with an Idempotency-Key and streams to completion', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const contents: [string, string][] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          baseRequest({
            messagesForInference: [
              { role: 'user', content: 'earlier question' },
              { role: 'assistant', content: 'earlier answer' },
              { role: 'system', content: 'be nice' },
              { role: 'user', content: 'hello' },
            ],
            webSearchEnabled: true,
            forkId: 'fork-1',
          }),
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
            onContent: (content, id) => contents.push([content, id]),
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });

      const streamResult = await promise;
      expect(streamResult.outcome).toBe('succeeded');
      expect(streamResult.userMessageId).toBe(SERVER_USER_MESSAGE_ID);
      expect(streamResult.models).toEqual([
        { modelId: 'model-a', assistantMessageId: capture.tiles[0]?.assistantMessageId },
      ]);
      expect(contents).toEqual([['Hi', capture.tiles[0]?.assistantMessageId]]);

      const [args, init] = postSpies.chat.mock.calls[0] as [
        { json: Record<string, unknown> },
        { headers: Record<string, string> },
      ];
      expect(init.headers['Idempotency-Key']).toMatch(/[0-9a-f-]{36}/);
      // Exact equality, not a subset: the compiler forces the new field to be
      // ADDED but cannot force the old ones to be DELETED, and a body carrying
      // a stale field beside the new one moves the canonical body hash — which
      // no other gate in this repo would catch.
      expect(args.json).toEqual({
        conversationId: 'conv-1',
        turnSources: [{ kind: 'model', id: 'model-a' }],
        modality: 'text',
        webSearchEnabled: true,
        forkId: 'fork-1',
        userMessage: { content: 'hello' },
        history: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
        ],
      });
    });

    it('sends history with inline reasoning stripped, so the sent bytes are the counted bytes', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          baseRequest({
            messagesForInference: [
              { role: 'user', content: 'earlier question' },
              { role: 'assistant', content: REPLAYED_ASSISTANT },
              { role: 'user', content: 'hello' },
            ],
          }),
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      const history = args.json['history'] as { role: string; content: string }[];
      expect(history).toEqual([
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: REPLAYED_ANSWER },
      ]);
      expect(historyCharacterCount(history)).toBe(
        'earlier question'.length + REPLAYED_ANSWER.length
      );
    });

    it('sends reasoningEffort on the run body when the request carries one', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ reasoningEffort: 'high' }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['reasoningEffort']).toBe('high');
    });

    it('omits reasoningEffort from the run body when the request carries none', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json).not.toHaveProperty('reasoningEffort');
    });

    it('forwards the finish frame resolved reasoning level to onReasoningEffort', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const levels: [string, string][] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onReasoningEffort: (effort, id) => levels.push([effort, id]),
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      const tile = capture.tiles[0]!;
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 'answer0#0',
          cursor: 1,
          event: { kind: 'stream-start', modelId: tile.modelId },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 'answer0#0',
          cursor: 2,
          event: {
            kind: 'finish',
            metadata: {
              usage: { inputTokens: 1, outputTokens: 1 },
              finishReason: 'stop',
            },
            reasoningEffort: 'off',
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;

      expect(levels).toEqual([['off', tile.assistantMessageId]]);
    });

    it('forwards the finish frame reasoning token count to onReasoningTokens', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const counts: [number, string][] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onReasoningTokens: (count, id) => counts.push([count, id]),
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      const tile = capture.tiles[0]!;
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 'answer0#0',
          cursor: 1,
          event: { kind: 'stream-start', modelId: tile.modelId },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 'answer0#0',
          cursor: 2,
          event: {
            kind: 'finish',
            metadata: {
              usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 1204 },
              finishReason: 'stop',
            },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;

      expect(counts).toEqual([[1204, tile.assistantMessageId]]);
    });

    it('sends the models array for a multi-model turn and demuxes per tile', async () => {
      postSpies.chat.mockResolvedValue(
        startedResponse('run-1', ['server-answer-a', 'server-answer-b'])
      );
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ models: ['model-a', 'model-b'] }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(2);
      });
      expect(capture.tiles.map((t) => t.modelId)).toEqual(['model-a', 'model-b']);
      act(() => {
        finishRun(socket, capture);
      });

      const streamResult = await promise;
      expect(streamResult.models).toHaveLength(2);

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['turnSources']).toEqual([
        { kind: 'model', id: 'model-a' },
        { kind: 'model', id: 'model-b' },
      ]);
    });

    it('sends the Smart slot as its own source, naming no model', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const resolved: [string | undefined, string][] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ models: ['smart-model'] }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onModelResolved: (id, modelId) => resolved.push([id, modelId]),
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'anthropic/claude-sonnet' },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 2,
          event: {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });

      const streamResult = await promise;
      expect(resolved).toEqual([[capture.tiles[0]?.assistantMessageId, 'anthropic/claude-sonnet']]);
      expect(streamResult.models[0]?.modelId).toBe('anthropic/claude-sonnet');

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['turnSources']).toEqual([{ kind: 'smart' }]);
    });

    it('allocates one tile per source for a mixed Smart-plus-pinned selection', async () => {
      // One tile per source, one stream per source: a tile the run never opens
      // a stream for sits empty forever, which is the seam the Smart slot's
      // arrival beside pinned siblings runs straight through.
      postSpies.chat.mockResolvedValue(
        startedResponse('run-1', ['server-answer-a', 'server-answer-smart', 'server-answer-b'])
      );
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          baseRequest({ models: ['model-a', SMART_MODEL_ID, 'model-b'] }),
          { onStart: (data) => (capture.tiles = data.models) }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(3);
      });
      expect(capture.tiles.map((tile) => tile.modelId)).toEqual([
        'model-a',
        SMART_MODEL_ID,
        'model-b',
      ]);
      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['turnSources']).toEqual([
        { kind: 'model', id: 'model-a' },
        { kind: 'smart' },
        { kind: 'model', id: 'model-b' },
      ]);
    });

    it('routes a link-guest send through the guest route', async () => {
      mockGetLinkGuestAuth.mockReturnValue('link-key');
      postSpies.guest.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(postSpies.guest).toHaveBeenCalled();
      });
      expect(postSpies.chat).not.toHaveBeenCalled();
      act(() => {
        finishRun(socket, capture);
      });
      await promise;
    });

    it('throws ChatRequestError with the wire code on a refusal', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ code: 'CONCURRENT_RUN' }, 409));
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(act(() => result.current.startStream(baseRequest()))).rejects.toMatchObject({
        name: 'ChatRequestError',
        code: 'CONCURRENT_RUN',
        status: 409,
      });
    });

    /** Runs one send whose first POST answers `response`; the ids onStart was handed. */
    async function userMessageIdsHandedOnStart(response: Response): Promise<(string | null)[]> {
      postSpies.chat.mockResolvedValue(response);
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));
      const capture: StreamStartCapture = { tiles: [] };
      const handed: (string | null)[] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
            handed.push(data.userMessageId);
          },
        });
        armed(promise);
      });
      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;
      return handed;
    }

    /** The answer ids onStart hands out when the run-start POST answers `response`. */
    async function answerIdsHandedOnStart(
      response: Response,
      models: string[] = ['model-a', 'model-b']
    ): Promise<string[]> {
      postSpies.chat.mockResolvedValue(response);
      const { result } = renderHook(() => useChatStream('authenticated'));
      const handed: string[] = [];
      act(() => {
        armed(
          result.current.startStream(baseRequest({ models }), {
            onStart: (data) => handed.push(...data.models.map((m) => m.assistantMessageId)),
          })
        );
      });
      await waitFor(() => {
        expect(handed).toHaveLength(models.length);
      });
      return handed;
    }

    it('hands onStart the answer ids the run-start response returned, in the selected order', async () => {
      const response = jsonResponse(
        {
          runId: 'run-1',
          deadlineAt: Date.now() + 300_000,
          userMessageId: SERVER_USER_MESSAGE_ID,
          assistantMessageIds: ['srv-a', 'srv-b'],
        },
        201
      );
      expect(await answerIdsHandedOnStart(response)).toEqual(['srv-a', 'srv-b']);
    });

    it('rejects the turn when the run-start response names no answer ids, starting no tile', async () => {
      postSpies.chat.mockResolvedValue(
        jsonResponse(
          {
            runId: 'run-1',
            deadlineAt: Date.now() + 300_000,
            userMessageId: SERVER_USER_MESSAGE_ID,
          },
          201
        )
      );
      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(() => result.current.startStream(baseRequest(), { onStart }))
      ).rejects.toThrow();
      expect(onStart).not.toHaveBeenCalled();
    });

    it('rejects the turn when an attach response carries no answer id field, starting no tile', async () => {
      postSpies.chat.mockResolvedValue(
        jsonResponse({ outcome: 'attach', userMessageId: 'live-user-msg' }, 200)
      );
      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(() => result.current.startStream(baseRequest(), { onStart }))
      ).rejects.toThrow();
      expect(onStart).not.toHaveBeenCalled();
    });

    it("hands onStart the live run's answer ids when the first POST attaches", async () => {
      const attach = jsonResponse(
        { outcome: 'attach', userMessageId: 'live-user-msg', assistantMessageIds: ['live-a'] },
        200
      );
      expect(await answerIdsHandedOnStart(attach, ['model-a'])).toEqual(['live-a']);
    });

    it('reads read-aloud from the first answer, under its minted id, when a middle model fails', async () => {
      const feed = vi.fn();
      ttsMock.feeder = { feed, end: vi.fn() };
      postSpies.chat.mockResolvedValue(
        jsonResponse(
          {
            runId: 'run-1',
            deadlineAt: Date.now() + 300_000,
            userMessageId: SERVER_USER_MESSAGE_ID,
            assistantMessageIds: ['srv-a', 'srv-b', 'srv-c'],
          },
          201
        )
      );
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));
      let promise!: Promise<StreamResult>;
      const started = { fired: false };
      act(() => {
        promise = result.current.startStream(
          baseRequest({ models: ['model-a', 'model-b', 'model-c'] }),
          {
            onStart: () => {
              started.fired = true;
            },
          }
        );
        armed(promise);
      });
      await waitFor(() => {
        expect(started.fired).toBe(true);
      });
      type StreamEvent = Extract<RunFrame, { type: 'stream' }>['event'];
      const send = (streamId: string, cursor: number, event: StreamEvent): void => {
        socket.emit({ type: 'stream', streamId, cursor, event });
      };
      const finish = (finishReason: 'stop' | 'error'): StreamEvent => ({
        kind: 'finish',
        metadata: { usage: {}, finishReason },
      });
      act(() => {
        send('answer0#0', 1, { kind: 'stream-start', modelId: 'model-a', messageId: 'srv-a' });
        send('answer1#1', 1, { kind: 'stream-start', modelId: 'model-b', messageId: 'srv-b' });
        send('answer2#2', 1, { kind: 'stream-start', modelId: 'model-c', messageId: 'srv-c' });
        send('answer1#1', 2, finish('error'));
        send('answer0#0', 2, { kind: 'text-delta', index: 0, content: 'first' });
        send('answer2#2', 2, { kind: 'text-delta', index: 0, content: 'third' });
        send('answer0#0', 3, finish('stop'));
        send('answer2#2', 3, finish('stop'));
        socket.emit({ type: 'run-finished', runId: 'run-1', outcome: { outcome: 'succeeded' } });
      });
      const streamResult = await promise;

      expect(ttsMock.messageId?.()).toBe('srv-a');
      expect(feed.mock.calls).toEqual([['first']]);
      expect(streamResult.models.map((m) => [m.assistantMessageId, m.errorCode])).toEqual([
        ['srv-a', undefined],
        ['srv-b', 'STREAM_ERROR'],
        ['srv-c', undefined],
      ]);
    });

    it('hands onStart the user message id the run-start response returned', async () => {
      expect(await userMessageIdsHandedOnStart(startedResponse())).toEqual([
        SERVER_USER_MESSAGE_ID,
      ]);
    });

    it("hands onStart the live run's user message id when the first POST attaches", async () => {
      const attach = jsonResponse(
        { outcome: 'attach', userMessageId: 'live-user-msg', assistantMessageIds: null },
        200
      );
      expect(await userMessageIdsHandedOnStart(attach)).toEqual(['live-user-msg']);
    });

    it('hands onStart a null user message id when the attach names no live run', async () => {
      const attach = jsonResponse(
        { outcome: 'attach', userMessageId: null, assistantMessageIds: null },
        200
      );
      expect(await userMessageIdsHandedOnStart(attach)).toEqual([null]);
    });

    it('returns a replayed outcome for a settled-run replay without firing onStart', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ some: 'persisted-response' }, 200));
      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult!: StreamResult;
      await act(async () => {
        streamResult = await result.current.startStream(baseRequest(), { onStart });
      });

      expect(streamResult.outcome).toBe('replayed');
      expect(onStart).not.toHaveBeenCalled();
    });

    it('throws ChatRunFailedError when the run finishes failed', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      let promise!: Promise<StreamResult>;
      const onStart = vi.fn();
      act(() => {
        promise = result.current.startStream(baseRequest(), { onStart });
        armed(promise);
      });
      await waitFor(() => {
        expect(onStart).toHaveBeenCalled();
      });
      act(() => {
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'failed', code: 'INTERNAL' },
        } as RunFrame);
      });

      await expect(promise).rejects.toBeInstanceOf(ChatRunFailedError);
    });

    it('reuses the same Idempotency-Key when the POST transport drops', async () => {
      vi.useFakeTimers();
      try {
        postSpies.chat
          .mockRejectedValueOnce(new TypeError('Failed to fetch'))
          .mockResolvedValueOnce(startedResponse());
        const socket = sockets.conversation as FakeSocket;
        const { result } = renderHook(() => useChatStream('authenticated'));

        const capture: StreamStartCapture = { tiles: [] };
        let promise!: Promise<StreamResult>;
        act(() => {
          promise = result.current.startStream(baseRequest(), {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          });
          armed(promise);
        });

        // Longer than any delay the retry policy chooses after a first failure.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1000);
        });
        expect(postSpies.chat).toHaveBeenCalledTimes(2);
        const firstInit = postSpies.chat.mock.calls[0]?.[1] as {
          headers: Record<string, string>;
        };
        const secondInit = postSpies.chat.mock.calls[1]?.[1] as {
          headers: Record<string, string>;
        };
        expect(firstInit.headers['Idempotency-Key']).toBe(secondInit.headers['Idempotency-Key']);

        act(() => {
          finishRun(socket, capture);
        });
        await promise;
      } finally {
        vi.useRealTimers();
      }
    });

    it('marks the run as locally owned while it is in flight', async () => {
      postSpies.chat.mockResolvedValue(startedResponse('run-owned'));
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      expect(isLocalRun('conv-1', 'run-owned')).toBe(true);

      act(() => {
        for (const [index, tile] of capture.tiles.entries()) {
          const streamId = `answer${String(index)}#${String(index)}`;
          socket.emit({
            type: 'stream',
            streamId,
            cursor: 1,
            event: { kind: 'stream-start', modelId: tile.modelId },
          } as RunFrame);
          socket.emit({
            type: 'stream',
            streamId,
            cursor: 2,
            event: {
              kind: 'finish',
              metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
            },
          } as RunFrame);
        }
        socket.emit({
          type: 'run-finished',
          runId: 'run-owned',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;

      expect(isLocalRun('conv-1', 'run-owned')).toBe(false);
    });

    it("marks a resubmitted run as the tab's own, so this tab's watcher renders no phantom of it", async () => {
      const socket = createReconnectableSocket();
      const emit = (frame: RunFrame): void => {
        socket.emit(frame);
      };
      sockets.conversation = socket;
      let answerResubmit!: (response: Response) => void;
      postSpies.chat.mockResolvedValueOnce(startedResponse('run-1')).mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerResubmit = resolve;
          })
      );
      // The watcher reads the stored history; a fresh one keeps its read off the network.
      queryClient.setQueryData(chatKeys.messages('conv-1'), []);
      const { result } = renderHook(
        () => ({
          chat: useChatStream('authenticated'),
          // A class with private members admits no structural fake; this one has every member the watcher reads.
          phantoms: useRemoteStreaming(socket as unknown as ConversationWebSocket),
        }),
        {
          // The watcher reads the stored history through the app's query client.
          wrapper: ({ children }) =>
            createElement(QueryClientProvider, { client: queryClient }, children),
        }
      );
      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.chat.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });
      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });

      act(() => {
        socket.reconnect();
      });
      await waitFor(() => {
        expect(postSpies.chat).toHaveBeenCalledTimes(2);
      });
      act(() => {
        emit({ type: 'run-started', runId: 'run-2' });
        emit({
          type: 'stream',
          streamId: 'answer0#0',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'model-a' },
        });
      });

      expect(result.current.phantoms.size).toBe(0);
      answerResubmit(startedResponse('run-2'));
      await waitFor(() => {
        expect(isLocalRun('conv-1', 'run-2')).toBe(true);
      });
      act(() => {
        emit({
          type: 'run-finished',
          runId: 'run-2',
          outcome: { outcome: 'succeeded' },
        });
      });
      await promise;
    });

    it('leaves no run marked as its own after an attached turn whose resubmit started a new run', async () => {
      const socket = createReconnectableSocket();
      sockets.conversation = socket;
      let answerResubmit!: (response: Response) => void;
      postSpies.chat
        .mockResolvedValueOnce(
          jsonResponse({ outcome: 'attach', userMessageId: null, assistantMessageIds: null }, 200)
        )
        .mockImplementationOnce(
          () =>
            new Promise<Response>((resolve) => {
              answerResubmit = resolve;
            })
        );
      const { result } = renderHook(() => useChatStream('authenticated'));
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest());
        armed(promise);
      });
      await waitFor(() => {
        expect(postSpies.chat).toHaveBeenCalledTimes(1);
      });

      act(() => {
        socket.reconnect();
      });
      await waitFor(() => {
        expect(postSpies.chat).toHaveBeenCalledTimes(2);
      });
      answerResubmit(startedResponse('run-2'));
      await waitFor(() => {
        expect(isLocalRun('conv-1', 'run-2')).toBe(true);
      });
      act(() => {
        socket.emit({
          type: 'run-finished',
          runId: 'run-2',
          outcome: { outcome: 'succeeded' },
        });
      });
      await promise;

      expect(isLocalRun('conv-1', 'another-members-run')).toBe(false);
    });

    it('leaves a run its resubmit started after the turn settled not marked as its own', async () => {
      const socket = createReconnectableSocket();
      sockets.conversation = socket;
      let answerResubmit!: (response: Response) => void;
      postSpies.chat.mockResolvedValueOnce(startedResponse('run-1')).mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerResubmit = resolve;
          })
      );
      const { result } = renderHook(() => useChatStream('authenticated'));
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest());
        armed(promise);
      });
      await waitFor(() => {
        expect(isLocalRun('conv-1', 'run-1')).toBe(true);
      });
      act(() => {
        socket.reconnect();
      });
      await waitFor(() => {
        expect(postSpies.chat).toHaveBeenCalledTimes(2);
      });
      act(() => {
        socket.emit({ type: 'run-finished', runId: 'run-1', outcome: { outcome: 'succeeded' } });
      });
      await promise;

      const late = startedResponse('run-2');
      const readBody = vi.spyOn(late, 'json');
      answerResubmit(late);
      await vi.waitFor(() => {
        expect(readBody).toHaveBeenCalled();
      });
      await readBody.mock.results[0]?.value;
      await Promise.resolve();
      await Promise.resolve();

      expect(isLocalRun('conv-1', 'run-2')).toBe(false);
    });

    it('flips isStreaming for the run duration and releases the socket', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));
      expect(result.current.isStreaming).toBe(false);

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });
      expect(result.current.isStreaming).toBe(true);

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      await act(async () => {
        finishRun(socket, capture);
        await promise;
      });

      expect(result.current.isStreaming).toBe(false);
      expect(sockets.acquireConversation).toHaveBeenCalledWith('conv-1');
      expect(sockets.releaseConversation).toHaveBeenCalledWith('conv-1');
    });

    it('attaches to a live same-key run when the POST returns attach', async () => {
      postSpies.chat.mockResolvedValue(
        jsonResponse({ outcome: 'attach', userMessageId: null, assistantMessageIds: null }, 200)
      );
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });

      const streamResult = await promise;
      expect(streamResult.outcome).toBe('succeeded');
    });

    it('treats a 200 with an unknown outcome value as a settled-run replay', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ outcome: 'persisted' }, 200));
      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('authenticated'));

      let streamResult!: StreamResult;
      await act(async () => {
        streamResult = await result.current.startStream(baseRequest(), { onStart });
      });

      expect(streamResult.outcome).toBe('replayed');
      expect(onStart).not.toHaveBeenCalled();
    });

    it('carries wire details through a refusal', async () => {
      postSpies.chat.mockResolvedValue(
        jsonResponse({ code: 'RATE_LIMITED', details: { retryAfterSeconds: 9 } }, 429)
      );
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(act(() => result.current.startStream(baseRequest()))).rejects.toMatchObject({
        code: 'RATE_LIMITED',
        details: { retryAfterSeconds: 9 },
        status: 429,
      });
    });

    it('normalizes a null details field to undefined', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ code: 'FORBIDDEN', details: null }, 403));
      const { result } = renderHook(() => useChatStream('authenticated'));

      const error: unknown = await act(() =>
        result.current.startStream(baseRequest()).catch((error_: unknown) => error_)
      );

      expect(error).toBeInstanceOf(ChatRequestError);
      expect((error as ChatRequestError).code).toBe('FORBIDDEN');
      expect((error as ChatRequestError).details).toBeUndefined();
    });

    it('maps a refusal body with a non-string code to INTERNAL', async () => {
      postSpies.chat.mockResolvedValue(jsonResponse({ code: 42 }, 500));
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(act(() => result.current.startStream(baseRequest()))).rejects.toMatchObject({
        code: 'INTERNAL',
        status: 500,
      });
    });

    it('maps an unparseable refusal body to INTERNAL', async () => {
      postSpies.chat.mockResolvedValue(new Response('gateway exploded', { status: 502 }));
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(act(() => result.current.startStream(baseRequest()))).rejects.toMatchObject({
        code: 'INTERNAL',
        status: 502,
      });
    });

    it('rejects an authenticated send with no models before POSTing', async () => {
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(() => result.current.startStream(baseRequest({ models: [] })))
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(postSpies.chat).not.toHaveBeenCalled();
    });

    it('sends the media modality and generation configs on the wire body', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          baseRequest({
            modality: 'video',
            imageConfig: { aspectRatio: '1:1' },
            videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
          }),
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.chat.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['modality']).toBe('video');
      expect(args.json['imageConfig']).toEqual({ aspectRatio: '1:1' });
      expect(args.json['videoConfig']).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
      });
    });

    it('forwards media lifecycle events for media modalities and ignores non-media ones', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const onModelMediaStart = vi.fn();
      const onModelMediaDone = vi.fn();
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onModelMediaStart,
          onModelMediaDone,
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      const assistantMessageId = capture.tiles[0]?.assistantMessageId;
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'model-a' },
        } as RunFrame);
        for (const [cursor, modality] of (['image', 'audio', 'video', 'text'] as const).entries()) {
          socket.emit({
            type: 'stream',
            streamId: 's1',
            cursor: cursor + 2,
            event: { kind: 'media-start', index: 0, modality, mimeType: `${modality}/x` },
          } as RunFrame);
        }
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 6,
          event: {
            kind: 'media-done',
            index: 0,
            value: {
              ref: 'media/conv/msg/c1',
              mimeType: 'image/png',
              modality: 'image',
              byteLength: 1,
              metadata: {},
            },
          },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 7,
          event: {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;

      expect(
        onModelMediaStart.mock.calls.map(([data]) => (data as { mediaType: string }).mediaType)
      ).toEqual(['image', 'audio', 'video']);
      expect(onModelMediaStart).toHaveBeenCalledWith({
        assistantMessageId,
        mediaType: 'image',
        mimeType: 'image/x',
      });
      expect(onModelMediaDone).toHaveBeenCalledWith({ assistantMessageId });
    });

    it('forwards media-progress percents to onModelMediaProgress', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const onModelMediaProgress = vi.fn();
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ modality: 'video' }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onModelMediaProgress,
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      const assistantMessageId = capture.tiles[0]?.assistantMessageId;
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'model-a', outputModality: 'video' },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 2,
          event: { kind: 'media-progress', index: 0, percent: 40 },
        } as RunFrame);
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 3,
          event: {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;

      expect(onModelMediaProgress).toHaveBeenCalledWith({ assistantMessageId, percent: 40 });
    });

    it('swaps the tile to generating from a stream-start with outputModality', async () => {
      postSpies.chat.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      const onModelMediaStart = vi.fn();
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ modality: 'image' }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onModelMediaStart,
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      const assistantMessageId = capture.tiles[0]?.assistantMessageId;
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 1,
          event: { kind: 'stream-start', modelId: 'model-a', outputModality: 'image' },
        } as RunFrame);
      });
      expect(onModelMediaStart).toHaveBeenCalledWith({
        assistantMessageId,
        mediaType: 'image',
        mimeType: 'image/*',
      });
      act(() => {
        socket.emit({
          type: 'stream',
          streamId: 's1',
          cursor: 2,
          event: {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
          },
        } as RunFrame);
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        } as RunFrame);
      });
      await promise;
    });

    it('feeds only primary-tile tokens to an active TTS stream and ends it', async () => {
      const feed = vi.fn();
      const end = vi.fn();
      ttsMock.feeder = { feed, end };
      postSpies.chat.mockResolvedValue(
        startedResponse('run-1', ['server-answer-a', 'server-answer-b'])
      );
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest({ models: ['model-a', 'model-b'] }), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(2);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      // finishRun streams one 'Hi' token per tile; only the primary's reaches TTS.
      expect(feed).toHaveBeenCalledTimes(1);
      expect(feed).toHaveBeenCalledWith('Hi');
      expect(end).toHaveBeenCalledTimes(1);
      // The feeder reads the id each time it speaks: by then, the answer id the run start named.
      expect(ttsMock.messageId?.()).toBe(capture.tiles[0]?.assistantMessageId);
    });

    it('publishes a streaming tile its content on a rendered frame, before it finishes', async () => {
      const frames = mockAnimationFrames();
      try {
        postSpies.chat.mockResolvedValue(startedResponse());
        const socket = createFakeSocket();
        sockets.conversation = socket;
        const { result } = renderHook(() => useChatStream('authenticated'));
        const capture: StreamStartCapture = { tiles: [] };
        const onContent = vi.fn();
        let promise!: Promise<StreamResult>;
        act(() => {
          promise = result.current.startStream(baseRequest(), {
            onStart: (data) => {
              capture.tiles = data.models;
            },
            onContent,
          });
          armed(promise);
        });
        await waitFor(() => {
          expect(capture.tiles).toHaveLength(1);
        });

        act(() => {
          emitStream(socket, 1, { kind: 'stream-start', modelId: 'model-a' });
          emitStream(socket, 2, { kind: 'text-delta', index: 0, content: 'Hel' });
          emitStream(socket, 3, { kind: 'text-delta', index: 0, content: 'lo' });
        });
        expect(onContent).not.toHaveBeenCalled();
        act(() => {
          frames.run();
        });

        expect(onContent.mock.calls).toEqual([['Hello', capture.tiles[0]?.assistantMessageId]]);
        act(() => {
          finishRun(socket, capture, '');
        });
        await promise;
      } finally {
        frames.restore();
      }
    });

    it('keeps publishing streaming content on rendered frames under reduced motion', async () => {
      const frames = mockAnimationFrames();
      useA11yStore.getState().setForcedReducedMotion(true);
      try {
        postSpies.chat.mockResolvedValue(startedResponse());
        const socket = createFakeSocket();
        sockets.conversation = socket;
        const { result } = renderHook(() => useChatStream('authenticated'));
        const capture: StreamStartCapture = { tiles: [] };
        const onContent = vi.fn();
        let promise!: Promise<StreamResult>;
        act(() => {
          promise = result.current.startStream(baseRequest(), {
            onStart: (data) => {
              capture.tiles = data.models;
            },
            onContent,
          });
          armed(promise);
        });
        await waitFor(() => {
          expect(capture.tiles).toHaveLength(1);
        });

        act(() => {
          emitStream(socket, 1, { kind: 'stream-start', modelId: 'model-a' });
          emitStream(socket, 2, { kind: 'text-delta', index: 0, content: 'still' });
        });
        act(() => {
          frames.run();
        });

        expect(onContent.mock.calls).toEqual([['still', capture.tiles[0]?.assistantMessageId]]);
        act(() => {
          finishRun(socket, capture, '');
        });
        await promise;
      } finally {
        useA11yStore.getState().setForcedReducedMotion(false);
        frames.restore();
      }
    });

    it('rejects with a not-billed failure when the client-side deadline elapses', async () => {
      vi.useFakeTimers();
      try {
        postSpies.chat.mockResolvedValue(
          jsonResponse(
            {
              runId: 'run-1',
              deadlineAt: Date.now() + 60_000,
              userMessageId: SERVER_USER_MESSAGE_ID,
              assistantMessageIds: ['server-answer-1'],
            },
            201
          )
        );
        const { result } = renderHook(() => useChatStream('authenticated'));

        let promise!: Promise<StreamResult>;
        act(() => {
          promise = result.current.startStream(baseRequest());
          armed(promise);
        });

        await act(async () => {
          await vi.advanceTimersByTimeAsync(70_000);
        });

        await expect(promise).rejects.toMatchObject({
          name: 'ChatRunFailedError',
          code: 'CHAT_STREAM_FAILED',
          notBilled: true,
        });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('regenerate', () => {
    it('POSTs the regenerate body through the typed route', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        replaceAssistantId: 'b1c0ce60-0000-4000-8000-000000000002',
        models: ['model-a'],
        userMessage: { content: 'again' },
        messagesForInference: [{ role: 'user', content: 'again' }],
        fundingSource: 'personal_balance',
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args, init] = postSpies.regenerate.mock.calls[0] as [
        { json: Record<string, unknown> },
        { headers: Record<string, string> },
      ];
      expect(init.headers['Idempotency-Key']).toBeDefined();
      expect(args.json).toEqual({
        conversationId: 'conv-1',
        turnSources: [{ kind: 'model', id: 'model-a' }],
        modality: 'text',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        replaceAssistantId: 'b1c0ce60-0000-4000-8000-000000000002',
        userMessage: { content: 'again' },
        history: [],
      });
    });

    it('sends regenerate history with inline reasoning stripped', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        models: ['model-a'],
        userMessage: { content: 'again' },
        messagesForInference: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: REPLAYED_ASSISTANT },
          { role: 'user', content: 'again' },
        ],
        fundingSource: 'personal_balance',
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      const history = args.json['history'] as { role: string; content: string }[];
      expect(history).toEqual([
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: REPLAYED_ANSWER },
      ]);
      expect(historyCharacterCount(history)).toBe(
        'earlier question'.length + REPLAYED_ANSWER.length
      );
    });

    it('sends reasoningEffort on the regenerate body when the request carries one', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        models: ['model-a'],
        reasoningEffort: 'high',
        userMessage: { content: 'again' },
        messagesForInference: [{ role: 'user', content: 'again' }],
        fundingSource: 'personal_balance',
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['reasoningEffort']).toBe('high');
    });

    it('omits reasoningEffort from the regenerate body when the request carries none', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        models: ['model-a'],
        userMessage: { content: 'again' },
        messagesForInference: [{ role: 'user', content: 'again' }],
        fundingSource: 'personal_balance',
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json).not.toHaveProperty('reasoningEffort');
    });

    it('sends the Smart slot on regenerate as a smart turn source, never a model id', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        replaceAssistantId: 'b1c0ce60-0000-4000-8000-000000000002',
        models: [SMART_MODEL_ID],
        userMessage: { content: 'again' },
        messagesForInference: [{ role: 'user', content: 'again' }],
        fundingSource: 'personal_balance',
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['turnSources']).toEqual([{ kind: 'smart' }]);
    });

    it('sends the media modality and generation configs on the regenerate wire body', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const request: RegenerateStreamRequest = {
        conversationId: 'conv-1',
        targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
        action: 'retry',
        modality: 'video',
        models: ['video-model'],
        userMessage: { content: 'again' },
        messagesForInference: [{ role: 'user', content: 'again' }],
        fundingSource: 'personal_balance',
        imageConfig: { aspectRatio: '1:1' },
        videoConfig: { aspectRatio: '16:9', durationSeconds: 5, resolution: '720p' },
      };

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(request, {
          onStart: (data) => {
            capture.tiles = data.models;
          },
        });
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['modality']).toBe('video');
      expect(args.json['imageConfig']).toEqual({ aspectRatio: '1:1' });
      expect(args.json['videoConfig']).toEqual({
        aspectRatio: '16:9',
        durationSeconds: 5,
        resolution: '720p',
      });
    });

    it('surfaces regenerate refusal codes', async () => {
      postSpies.regenerate.mockResolvedValue(jsonResponse({ code: 'FORK_ID_REQUIRED' }, 409));
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(() =>
          result.current.startRegenerateStream({
            conversationId: 'conv-1',
            targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
            action: 'retry',
            models: ['model-a'],
            userMessage: { content: 'again' },
            messagesForInference: [],
            fundingSource: 'personal_balance',
          })
        )
      ).rejects.toMatchObject({ code: 'FORK_ID_REQUIRED' });
    });

    it('rejects a regenerate with no models before POSTing', async () => {
      const { result } = renderHook(() => useChatStream('authenticated'));

      await expect(
        act(() =>
          result.current.startRegenerateStream({
            conversationId: 'conv-1',
            targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
            action: 'retry',
            models: [],
            userMessage: { content: 'again' },
            messagesForInference: [],
            fundingSource: 'personal_balance',
          })
        )
      ).rejects.toMatchObject({ code: 'VALIDATION' });
      expect(postSpies.regenerate).not.toHaveBeenCalled();
      // No tiles exist, so the TTS binding probes an absent primary tile.
      expect(ttsMock.probedMessageIds).toEqual([null]);
    });

    it('sends models[] and forkId on a multi-model regenerate', async () => {
      postSpies.regenerate.mockResolvedValue(
        startedResponse('run-1', ['server-answer-a', 'server-answer-b'])
      );
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(
          {
            conversationId: 'conv-1',
            targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
            action: 'retry',
            models: ['model-a', 'model-b'],
            forkId: 'fork-9',
            userMessage: { content: 'again' },
            messagesForInference: [],
            fundingSource: 'personal_balance',
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(2);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['turnSources']).toEqual([
        { kind: 'model', id: 'model-a' },
        { kind: 'model', id: 'model-b' },
      ]);
      expect(args.json['forkId']).toBe('fork-9');
      expect(args.json['replaceAssistantId']).toBeUndefined();
    });

    it('forwards webSearchEnabled on a regenerate when web search is on', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(
          {
            conversationId: 'conv-1',
            targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
            action: 'retry',
            models: ['model-a'],
            webSearchEnabled: true,
            userMessage: { content: 'again' },
            messagesForInference: [],
            fundingSource: 'personal_balance',
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['webSearchEnabled']).toBe(true);
    });

    it('omits webSearchEnabled on a regenerate when web search is off', async () => {
      postSpies.regenerate.mockResolvedValue(startedResponse());
      const socket = sockets.conversation as FakeSocket;
      const { result } = renderHook(() => useChatStream('authenticated'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startRegenerateStream(
          {
            conversationId: 'conv-1',
            targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
            action: 'retry',
            models: ['model-a'],
            userMessage: { content: 'again' },
            messagesForInference: [],
            fundingSource: 'personal_balance',
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.regenerate.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json).not.toHaveProperty('webSearchEnabled');
    });
  });

  describe('trial', () => {
    it('sends prompt + history with the trial token and persists the returned session id', async () => {
      postSpies.trial.mockResolvedValue(
        jsonResponse(
          {
            runId: 'run-1',
            deadlineAt: Date.now() + 300_000,
            trialSessionId: 'session-from-server',
          },
          201
        )
      );
      const socket = sockets.trial as FakeSocket;
      const { result } = renderHook(() => useChatStream('trial'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          {
            model: 'model-t',
            messages: [
              { role: 'user', content: 'first' },
              { role: 'assistant', content: 'reply' },
              { role: 'user', content: 'second' },
            ],
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args, init] = postSpies.trial.mock.calls[0] as [
        { json: Record<string, unknown> },
        { headers: Record<string, string> },
      ];
      expect(init.headers['x-trial-token']).toMatch(/[0-9a-f-]{36}/);
      expect(init.headers['Idempotency-Key']).toBeDefined();
      expect(args.json).toEqual({
        turnSources: [{ kind: 'model', id: 'model-t' }],
        prompt: 'second',
        history: [
          { role: 'user', content: 'first' },
          { role: 'assistant', content: 'reply' },
        ],
      });
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'hushbox-trial-token',
        'session-from-server'
      );
      expect(sockets.acquireTrial).toHaveBeenCalled();
      expect(sockets.releaseTrial).toHaveBeenCalled();
    });

    it('builds the trial tile content through the same builder as the owner tile', async () => {
      postSpies.trial.mockResolvedValue(startedResponse());
      const socket = createFakeSocket();
      sockets.trial = socket;
      const { result } = renderHook(() => useChatStream('trial'));
      const capture: StreamStartCapture = { tiles: [] };
      const onContent = vi.fn<(content: string, assistantMessageId: string) => void>();
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          { model: 'model-t', messages: [{ role: 'user', content: 'hi' }] },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
            onContent,
          }
        );
        armed(promise);
      });
      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });

      act(() => {
        emitStream(socket, 1, { kind: 'stream-start', modelId: 'model-t' });
        emitStream(socket, 2, { kind: 'reasoning-delta', index: 0, content: 'a thought' });
        emitStream(socket, 3, { kind: 'text-delta', index: 0, content: 'Echo: hi' });
        emitStream(socket, 4, {
          kind: 'finish',
          metadata: { usage: {}, finishReason: 'stop' },
        });
        socket.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        });
      });
      await promise;

      const [content, id] = onContent.mock.lastCall ?? ['', ''];
      expect(id).toBe(capture.tiles[0]?.assistantMessageId);
      expect(parseAssistantMessage(content)).toEqual([
        { kind: 'reasoning', children: [{ kind: 'text', text: 'a thought' }] },
        { kind: 'text', text: 'Echo: hi' },
      ]);
    });

    it('sends trial history with inline reasoning stripped', async () => {
      postSpies.trial.mockResolvedValue(
        jsonResponse(
          { runId: 'run-1', deadlineAt: Date.now() + 300_000, trialSessionId: 's-1' },
          201
        )
      );
      const socket = sockets.trial as FakeSocket;
      const { result } = renderHook(() => useChatStream('trial'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          {
            model: 'model-t',
            messages: [
              { role: 'user', content: 'earlier question' },
              { role: 'assistant', content: REPLAYED_ASSISTANT },
              { role: 'user', content: 'second' },
            ],
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.trial.mock.calls[0] as [{ json: Record<string, unknown> }];
      const history = args.json['history'] as { role: string; content: string }[];
      expect(history).toEqual([
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: REPLAYED_ANSWER },
      ]);
      expect(historyCharacterCount(history)).toBe(
        'earlier question'.length + REPLAYED_ANSWER.length
      );
    });

    it('sends reasoningEffort on the trial body when the request carries one', async () => {
      postSpies.trial.mockResolvedValue(
        jsonResponse(
          { runId: 'run-1', deadlineAt: Date.now() + 300_000, trialSessionId: 's-1' },
          201
        )
      );
      const socket = sockets.trial as FakeSocket;
      const { result } = renderHook(() => useChatStream('trial'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          {
            model: 'model-t',
            messages: [{ role: 'user', content: 'hi' }],
            reasoningEffort: 'low',
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args] = postSpies.trial.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json['reasoningEffort']).toBe('low');
    });

    it('throws refusal codes so trial-refusals can map them', async () => {
      postSpies.trial.mockResolvedValue(jsonResponse({ code: 'TRIAL_CAPACITY_REACHED' }, 429));
      const { result } = renderHook(() => useChatStream('trial'));

      await expect(
        act(() =>
          result.current.startStream({
            model: 'model-t',
            messages: [{ role: 'user', content: 'hi' }],
          })
        )
      ).rejects.toMatchObject({ code: 'TRIAL_CAPACITY_REACHED' });
    });

    it('rejects a trial send whose last message is not from the user', async () => {
      const { result } = renderHook(() => useChatStream('trial'));
      await expect(
        act(() =>
          result.current.startStream({
            model: 'model-t',
            messages: [{ role: 'assistant', content: 'hi' }],
          })
        )
      ).rejects.toBeInstanceOf(ChatRequestError);
      expect(postSpies.trial).not.toHaveBeenCalled();
    });

    it('keeps the minted token and sends webSearchEnabled when the 201 carries no session id', async () => {
      postSpies.trial.mockResolvedValue(
        jsonResponse({ runId: 'run-1', deadlineAt: Date.now() + 300_000 }, 201)
      );
      const socket = sockets.trial as FakeSocket;
      const { result } = renderHook(() => useChatStream('trial'));

      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          {
            model: 'model-t',
            messages: [{ role: 'user', content: 'hi' }],
            webSearchEnabled: true,
          },
          {
            onStart: (data) => {
              capture.tiles = data.models;
            },
          }
        );
        armed(promise);
      });

      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;

      const [args, init] = postSpies.trial.mock.calls[0] as [
        { json: Record<string, unknown> },
        { headers: Record<string, string> },
      ];
      expect(args.json['webSearchEnabled']).toBe(true);
      // The only token write is the client-side mint that fed the request
      // header — a 201 without a session id persists nothing new.
      expect(localStorage.setItem).toHaveBeenCalledTimes(1);
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'hushbox-trial-token',
        init.headers['x-trial-token']
      );
    });

    it('returns replayed for a settled trial replay without firing onStart', async () => {
      postSpies.trial.mockResolvedValue(jsonResponse({ some: 'persisted-response' }, 200));
      const onStart = vi.fn();
      const { result } = renderHook(() => useChatStream('trial'));

      let streamResult!: StreamResult;
      await act(async () => {
        streamResult = await result.current.startStream(
          { model: 'model-t', messages: [{ role: 'user', content: 'hi' }] },
          { onStart }
        );
      });

      expect(streamResult.outcome).toBe('replayed');
      expect(onStart).not.toHaveBeenCalled();
    });

    /** Runs one trial send to success; the ids onStart was handed, and the result. */
    async function trialUserMessageIds(): Promise<{
      handed: (string | null)[];
      streamResult: StreamResult;
    }> {
      postSpies.trial.mockResolvedValue(
        jsonResponse({ runId: 'run-1', deadlineAt: Date.now() + 300_000 }, 201)
      );
      const socket = sockets.trial as FakeSocket;
      const { result } = renderHook(() => useChatStream('trial'));
      const capture: StreamStartCapture = { tiles: [] };
      const handed: (string | null)[] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(
          { model: 'model-t', messages: [{ role: 'user', content: 'hi' }] },
          {
            onStart: (data) => {
              capture.tiles = data.models;
              handed.push(data.userMessageId);
            },
          }
        );
        armed(promise);
      });
      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      return { handed, streamResult: await promise };
    }

    it('hands onStart a null user message id, since a trial run stores no user message', async () => {
      const { handed } = await trialUserMessageIds();
      expect(handed).toEqual([null]);
    });

    it('returns a null user message id for a trial run', async () => {
      const { streamResult } = await trialUserMessageIds();
      expect(streamResult.userMessageId).toBeNull();
    });
  });

  describe('a same-key re-execution after a reconnect', () => {
    /** The user message id the server minted for the re-execution's fresh run. */
    const REMINTED_USER_MESSAGE_ID = 'server-user-msg-2';

    // The answer ids match the first run's, so only the user message id decides a re-key.
    const reexecutedResponse = (userMessageId: string): Response =>
      jsonResponse(
        {
          runId: 'run-2',
          deadlineAt: Date.now() + 300_000,
          userMessageId,
          assistantMessageIds: ['server-answer-1'],
        },
        201
      );

    /**
     * Starts a send on run-1, reconnects so the turn resubmits its key, and
     * answers the resubmit with `resubmitResponse`. The streaming run's first
     * frame arrives before that answer, as the room sends it; the run finishes
     * only once the answer has released that frame. Records each re-key, each
     * first frame and each content publish in call order.
     */
    async function resubmitAfterReconnect(
      resubmitResponse: Response,
      finishedRunId: 'run-1' | 'run-2',
      firstResponse: Response = startedResponse('run-1')
    ): Promise<{ events: string[]; rekeys: RekeyEventData[]; streamResult: StreamResult }> {
      const rekeys: RekeyEventData[] = [];
      const socket = createReconnectableSocket();
      sockets.conversation = socket;
      let answerResubmit!: (response: Response) => void;
      postSpies.chat.mockResolvedValueOnce(firstResponse).mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            answerResubmit = resolve;
          })
      );
      const { result } = renderHook(() => useChatStream('authenticated'));
      const capture: StreamStartCapture = { tiles: [] };
      const events: string[] = [];
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = result.current.startStream(baseRequest(), {
          onStart: (data) => {
            capture.tiles = data.models;
          },
          onRekey: (data) => {
            events.push(`rekey:${String(data.userMessageId)}`);
            rekeys.push(data);
          },
          onModelResolved: () => {
            events.push('first-frame');
          },
          onContent: () => {
            events.push('content');
          },
        });
        armed(promise);
      });
      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });

      act(() => {
        socket.reconnect();
      });
      await waitFor(() => {
        expect(postSpies.chat).toHaveBeenCalledTimes(2);
      });
      const modelId = capture.tiles[0]?.modelId ?? 'model-a';
      act(() => {
        emitStream(socket, 1, { kind: 'stream-start', modelId });
      });
      answerResubmit(resubmitResponse);
      await waitFor(() => {
        expect(events).toContain('first-frame');
      });
      act(() => {
        emitStream(socket, 2, { kind: 'text-delta', index: 0, content: 'Hi' });
        emitStream(socket, 3, {
          kind: 'finish',
          metadata: { usage: {}, finishReason: 'stop' },
        });
        socket.emit({
          type: 'run-finished',
          runId: finishedRunId,
          outcome: { outcome: 'succeeded' },
        });
      });
      return { events, rekeys, streamResult: await promise };
    }

    it("re-keys the turn to a fresh run's new user message id before that run's first frame", async () => {
      const { events } = await resubmitAfterReconnect(
        reexecutedResponse(REMINTED_USER_MESSAGE_ID),
        'run-2'
      );

      expect(events[0]).toBe(`rekey:${REMINTED_USER_MESSAGE_ID}`);
      expect(events.filter((event) => event.startsWith('rekey:'))).toHaveLength(1);
    });

    it("returns the fresh run's new user message id on the stream result", async () => {
      const { streamResult } = await resubmitAfterReconnect(
        reexecutedResponse(REMINTED_USER_MESSAGE_ID),
        'run-2'
      );

      expect(streamResult.userMessageId).toBe(REMINTED_USER_MESSAGE_ID);
    });

    it("re-keys nothing when the fresh run keeps the turn's id, as a retry's anchor does", async () => {
      const { events, streamResult } = await resubmitAfterReconnect(
        reexecutedResponse(SERVER_USER_MESSAGE_ID),
        'run-2'
      );

      expect(events.filter((event) => event.startsWith('rekey:'))).toEqual([]);
      expect(streamResult.userMessageId).toBe(SERVER_USER_MESSAGE_ID);
    });

    it("re-keys the turn's tiles to a fresh run's new answer ids, naming the tiles they replace", async () => {
      const withAnswer = (runId: string, answerId: string): Response =>
        jsonResponse(
          {
            runId,
            deadlineAt: Date.now() + 300_000,
            userMessageId: SERVER_USER_MESSAGE_ID,
            assistantMessageIds: [answerId],
          },
          201
        );
      const { rekeys, streamResult } = await resubmitAfterReconnect(
        withAnswer('run-2', 'srv-2'),
        'run-2',
        withAnswer('run-1', 'srv-1')
      );

      expect(rekeys.map((data) => [data.previousModels, data.models])).toEqual([
        [
          [{ modelId: 'model-a', assistantMessageId: 'srv-1' }],
          [{ modelId: 'model-a', assistantMessageId: 'srv-2' }],
        ],
      ]);
      expect(streamResult.models.map((m) => m.assistantMessageId)).toEqual(['srv-2']);
    });

    it('re-keys nothing when the resubmit attaches to the run still streaming', async () => {
      const attach = jsonResponse(
        { outcome: 'attach', userMessageId: null, assistantMessageIds: null },
        200
      );
      const { events, streamResult } = await resubmitAfterReconnect(attach, 'run-1');

      expect(events.filter((event) => event.startsWith('rekey:'))).toEqual([]);
      expect(streamResult.userMessageId).toBe(SERVER_USER_MESSAGE_ID);
    });
  });

  describe('stopRun', () => {
    it('POSTs the conversation id and returns the stopped flag', async () => {
      postSpies.stop.mockResolvedValue(jsonResponse({ stopped: true }, 200));
      const { result } = renderHook(() => useChatStream('authenticated'));

      const stopped = await act(() => result.current.stopRun('conv-1'));
      expect(stopped).toBe(true);
      const [args] = postSpies.stop.mock.calls[0] as [{ json: Record<string, unknown> }];
      expect(args.json).toEqual({ conversationId: 'conv-1' });
    });

    it('returns false when the run already ended', async () => {
      postSpies.stop.mockResolvedValue(jsonResponse({ stopped: false }, 200));
      const { result } = renderHook(() => useChatStream('authenticated'));
      await expect(act(() => result.current.stopRun('conv-1'))).resolves.toBe(false);
    });

    it('returns false when the stop response body is unparseable', async () => {
      postSpies.stop.mockResolvedValue(new Response('', { status: 200 }));
      const { result } = renderHook(() => useChatStream('authenticated'));
      await expect(act(() => result.current.stopRun('conv-1'))).resolves.toBe(false);
    });

    it('throws ChatRequestError on a stop refusal', async () => {
      postSpies.stop.mockResolvedValue(jsonResponse({ code: 'FORBIDDEN' }, 403));
      const { result } = renderHook(() => useChatStream('authenticated'));
      await expect(act(() => result.current.stopRun('conv-1'))).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    });
  });

  describe('wire fields', () => {
    /**
     * The maps below classify every field a turn route accepts, typed against
     * the ROUTE'S OWN body: a field added to the server schema stops compiling
     * here until it is classified. The key-set assertions cover the direction no
     * type can see — a field dropped from a body builder still type-checks,
     * because every optional wire field may be omitted. That blind spot is what
     * let `customInstructions` be accepted, priced and hashed server-side while
     * no client emitted it.
     *
     * A `neverSent` entry states why the client cannot supply the field; an
     * entry without a reason is a hole with a comment on it.
     */
    type WireFieldSource = 'sent' | { readonly neverSent: string };

    type StartWireBody = InferRequestType<typeof client.chat.$post>['json'];
    type RegenerateWireBody = InferRequestType<typeof client.chat.regenerate.$post>['json'];
    type TrialWireBody = InferRequestType<typeof client.chat.trial.$post>['json'];

    const START_WIRE_FIELDS = {
      conversationId: 'sent',
      turnSources: 'sent',
      modality: 'sent',
      forkId: 'sent',
      webSearchEnabled: 'sent',
      reasoningEffort: 'sent',
      imageConfig: 'sent',
      videoConfig: 'sent',
      userMessage: 'sent',
      history: 'sent',
      customInstructions: 'sent',
    } satisfies Record<keyof StartWireBody, WireFieldSource>;

    const REGENERATE_WIRE_FIELDS = {
      conversationId: 'sent',
      turnSources: 'sent',
      modality: 'sent',
      targetMessageId: 'sent',
      action: 'sent',
      replaceAssistantId: 'sent',
      forkId: 'sent',
      webSearchEnabled: 'sent',
      reasoningEffort: 'sent',
      imageConfig: 'sent',
      videoConfig: 'sent',
      userMessage: 'sent',
      history: 'sent',
      customInstructions: 'sent',
    } satisfies Record<keyof RegenerateWireBody, WireFieldSource>;

    const TRIAL_WIRE_FIELDS = {
      turnSources: 'sent',
      prompt: 'sent',
      webSearchEnabled: 'sent',
      reasoningEffort: 'sent',
      history: 'sent',
    } satisfies Record<keyof TrialWireBody, WireFieldSource>;

    const alphabetically = (a: string, b: string): number => a.localeCompare(b);

    function sentKeysOf(fields: Readonly<Record<string, WireFieldSource>>): string[] {
      return Object.entries(fields)
        .filter(([, source]) => source === 'sent')
        .map(([field]) => field)
        .toSorted(alphabetically);
    }

    const keysOf = (body: Record<string, unknown>): string[] =>
      Object.keys(body).toSorted(alphabetically);

    const INSTRUCTIONS = 'answer in French';

    /** A send whose every optional field is populated, so the body is maximal. */
    const maximalSend = (): AuthenticatedStreamRequest =>
      baseRequest({
        forkId: 'fork-1',
        webSearchEnabled: true,
        reasoningEffort: 'high',
        // Both media configs ride the probe: the builder spreads each on its own
        // presence rather than on the modality, so a body carrying one and not
        // the other cannot tell the two spreads apart.
        imageConfig: { aspectRatio: '4:3' },
        videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
        customInstructions: INSTRUCTIONS,
      });

    const maximalRegenerate = (): RegenerateStreamRequest => ({
      conversationId: 'conv-1',
      targetMessageId: 'b1c0ce60-0000-4000-8000-000000000001',
      action: 'retry',
      replaceAssistantId: 'b1c0ce60-0000-4000-8000-000000000002',
      models: ['model-a'],
      userMessage: { content: 'again' },
      messagesForInference: [
        { role: 'user', content: 'earlier' },
        { role: 'assistant', content: 'earlier answer' },
        { role: 'user', content: 'again' },
      ],
      fundingSource: 'personal_balance',
      forkId: 'fork-1',
      webSearchEnabled: true,
      reasoningEffort: 'high',
      imageConfig: { aspectRatio: '4:3' },
      videoConfig: { aspectRatio: '16:9', durationSeconds: 6, resolution: '720p' },
      customInstructions: INSTRUCTIONS,
    });

    const maximalTrial = (): TrialStreamRequest => ({
      model: 'model-t',
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
      webSearchEnabled: true,
      reasoningEffort: 'high',
    });

    /** Drives one turn to completion and returns the body it posted. */
    async function postedBody(
      mode: 'authenticated' | 'trial',
      spy: (typeof postSpies)['chat'],
      start: (
        hook: ReturnType<typeof useChatStream>,
        onStart: (data: { models: { modelId: string; assistantMessageId: string }[] }) => void
      ) => Promise<StreamResult>
    ): Promise<Record<string, unknown>> {
      spy.mockResolvedValue(startedResponse());
      const socket = (mode === 'trial' ? sockets.trial : sockets.conversation) as FakeSocket;
      const { result } = renderHook(() => useChatStream(mode));
      const capture: StreamStartCapture = { tiles: [] };
      let promise!: Promise<StreamResult>;
      act(() => {
        promise = start(result.current, (data) => {
          capture.tiles = data.models;
        });
        armed(promise);
      });
      await waitFor(() => {
        expect(capture.tiles).toHaveLength(1);
      });
      act(() => {
        finishRun(socket, capture);
      });
      await promise;
      const [args] = spy.mock.calls[0] as [{ json: Record<string, unknown> }];
      return args.json;
    }

    const postedSend = (request: AuthenticatedStreamRequest): Promise<Record<string, unknown>> =>
      postedBody('authenticated', postSpies.chat, (hook, onStart) =>
        hook.startStream(request, { onStart })
      );

    const postedRegenerate = (request: RegenerateStreamRequest): Promise<Record<string, unknown>> =>
      postedBody('authenticated', postSpies.regenerate, (hook, onStart) =>
        hook.startRegenerateStream(request, { onStart })
      );

    const postedTrial = (request: TrialStreamRequest): Promise<Record<string, unknown>> =>
      postedBody('trial', postSpies.trial, (hook, onStart) =>
        hook.startStream(request, { onStart })
      );

    it('emits every field POST /chat accepts', async () => {
      expect(keysOf(await postedSend(maximalSend()))).toEqual(sentKeysOf(START_WIRE_FIELDS));
    });

    it('emits every field POST /chat/regenerate accepts', async () => {
      expect(keysOf(await postedRegenerate(maximalRegenerate()))).toEqual(
        sentKeysOf(REGENERATE_WIRE_FIELDS)
      );
    });

    it('emits every field POST /chat/trial accepts', async () => {
      expect(keysOf(await postedTrial(maximalTrial()))).toEqual(sentKeysOf(TRIAL_WIRE_FIELDS));
    });

    it('carries the instruction text on a send', async () => {
      const body = await postedSend(baseRequest({ customInstructions: INSTRUCTIONS }));
      expect(body['customInstructions']).toBe(INSTRUCTIONS);
    });

    it('carries the instruction text on a regenerate', async () => {
      const body = await postedRegenerate({
        ...maximalRegenerate(),
        customInstructions: 'be terse',
      });
      expect(body['customInstructions']).toBe('be terse');
    });
  });
});
