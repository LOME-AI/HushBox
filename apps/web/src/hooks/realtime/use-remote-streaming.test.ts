import { createElement } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, act, render } from '@testing-library/react';
import { parseAssistantMessage, WEB_SEARCH_TOOL_NAME } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { useA11yStore } from '@hushbox/ui/accessibility/store';
import { useRemoteStreaming } from '@/hooks/realtime/use-remote-streaming.js';
import { messagesWithPhantoms } from '@/components/chat/page/authenticated-chat-page.js';
import { useSegmentViewState } from '@/components/chat/segments/segment-view-state.js';
import { chatKeys } from '@/hooks/chat/chat.js';
import { queryClient } from '@/providers/query-provider.js';
import { ConversationWebSocket } from '@/lib/api/ws-client.js';
import { executeChatRun } from '@/lib/chat/run.js';
import {
  markPendingLocalRun,
  resolvePendingLocalRun,
  resetRunOwnershipForTests,
} from '@/lib/chat/run-ownership.js';
import type { InferenceEvent, MessageResponse } from '@hushbox/shared';
import type { PhantomMessage } from '@/hooks/realtime/use-remote-streaming.js';
import type { RunFrame } from '@/lib/api/server-frames.js';
import type { RunStartResponse, RunTransportSocket } from '@/lib/chat/run.js';
import type { Message } from '@/lib/api/api.js';

vi.mock('@/lib/api/api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api/api.js')>()),
  getApiUrl: (): string => 'http://localhost:8787',
}));
vi.mock('@/lib/auth/link-guest-auth.js', () => ({ getLinkGuestAuth: (): null => null }));

/** The app's query client around every render, as the page provides it. */
function WithQueryClient({ children }: { children: React.ReactNode }): React.ReactElement {
  return createElement(QueryClientProvider, { client: queryClient }, children);
}

interface MockWs {
  conversationId: string;
  onRunFrame: (listener: (frame: RunFrame) => void) => () => void;
  onLiveRun: (listener: (runId: string | undefined) => void) => () => void;
  emit: (frame: RunFrame) => void;
  listenerCount: () => number;
}

function createMockWs(conversationId = 'conv-1'): MockWs {
  const listeners = new Set<(frame: RunFrame) => void>();
  const liveRunListeners = new Set<(runId: string | undefined) => void>();
  return {
    conversationId,
    onRunFrame(listener) {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    onLiveRun(listener) {
      liveRunListeners.add(listener);
      return (): void => {
        liveRunListeners.delete(listener);
      };
    },
    emit(frame) {
      for (const listener of listeners) listener(frame);
    },
    listenerCount: () => listeners.size + liveRunListeners.size,
  };
}

/** The browser socket under the real conversation client: the test plays the room. */
class RoomSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** Every socket the client opened, oldest first; emptied before each test. */
  static readonly opened: RoomSocket[] = [];
  readyState = RoomSocket.OPEN;
  readonly url: string;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(url: string) {
    this.url = url;
    RoomSocket.opened.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(listener);
    this.listeners.set(type, set);
  }

  dispatchEvent(type: string, event: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  send = vi.fn();
  close = vi.fn((): void => {
    this.readyState = RoomSocket.CLOSED;
    this.dispatchEvent('close', {});
  });

  /** One frame from the room. */
  deliver(frame: unknown): void {
    this.dispatchEvent('message', { data: JSON.stringify(frame) });
  }

  /** The connection drops without the client asking. */
  drop(): void {
    this.readyState = RoomSocket.CLOSED;
    this.dispatchEvent('close', {});
  }
}

function latestRoomSocket(): RoomSocket {
  const socket = RoomSocket.opened.at(-1);
  if (socket === undefined) throw new Error('the client opened no socket');
  return socket;
}

/** Drops the client's connection and lets its backoff open the next one. */
function reconnect(): RoomSocket {
  latestRoomSocket().drop();
  vi.advanceTimersByTime(10_000);
  const next = latestRoomSocket();
  next.dispatchEvent('open', {});
  return next;
}

const asWs = (mock: MockWs): ConversationWebSocket => mock as unknown as ConversationWebSocket;

function stream(streamId: string, cursor: number, event: unknown): RunFrame {
  return { type: 'stream', streamId, cursor, event } as RunFrame;
}

const finishEvent = (): InferenceEvent => ({
  kind: 'finish',
  metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
});

interface AnimationFrames {
  /** Runs every frame callback queued so far, as one rendered frame. */
  run(): void;
  /** How many frame callbacks are queued: zero once nothing asks for a frame. */
  pending(): number;
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
    pending: (): number => queue.size,
    restore(): void {
      define('requestAnimationFrame', original.request);
      define('cancelAnimationFrame', original.cancel);
    },
  };
}

/** A search made while reasoning, the reasoning continuing in the next step, then the answer. */
const NESTED_SEARCH_EVENTS: readonly InferenceEvent[] = [
  { kind: 'step-start', step: 0 },
  { kind: 'reasoning-delta', index: 0, content: 'think' },
  { kind: 'tool-call', id: 'c1', name: WEB_SEARCH_TOOL_NAME, args: { query: 'q' } },
  {
    kind: 'tool-result',
    id: 'c1',
    name: WEB_SEARCH_TOOL_NAME,
    result: {
      results: [
        { title: 'A', url: 'https://a.example', snippet: 'a' },
        { title: 'B', url: 'https://b.example', snippet: 'b' },
      ],
    },
  },
  { kind: 'step-finish', step: 0, generationId: 'g1' },
  { kind: 'step-start', step: 1 },
  { kind: 'reasoning-delta', index: 0, content: 'more' },
  { kind: 'text-delta', index: 0, content: 'Answer' },
];

interface ReconnectingRunSocket extends RunTransportSocket {
  emit(frame: RunFrame): void;
  /** Drops the connection and brings it back, as a reconnect does. */
  reconnect(): void;
}

function createReconnectingRunSocket(): ReconnectingRunSocket {
  const frameListeners = new Set<(frame: RunFrame) => void>();
  const stateListeners = new Set<() => void>();
  let ready = true;
  const setReady = (value: boolean): void => {
    ready = value;
    for (const listener of stateListeners) listener();
  };
  return {
    connect: vi.fn(),
    waitForReady: (): Promise<boolean> => Promise.resolve(ready),
    get ready(): boolean {
      return ready;
    },
    onRunFrame(listener) {
      frameListeners.add(listener);
      return (): void => {
        frameListeners.delete(listener);
      };
    },
    onStateChange(listener) {
      stateListeners.add(listener);
      return (): void => {
        stateListeners.delete(listener);
      };
    },
    emit(frame) {
      for (const listener of frameListeners) listener(frame);
    },
    reconnect() {
      setReady(false);
      setReady(true);
    },
  };
}

const settle = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

/** The content the sending member's own tile builds from the given stream frames. */
async function ownerTileContent(frames: readonly RunFrame[]): Promise<string> {
  const listeners = new Set<(frame: RunFrame) => void>();
  const socket: RunTransportSocket = {
    connect: vi.fn(),
    waitForReady: (): Promise<boolean> => Promise.resolve(true),
    ready: true,
    onRunFrame(listener) {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    onStateChange: () => (): void => {},
  };
  const contents: string[] = [];
  const run = executeChatRun({
    socket,
    postRun: () =>
      Promise.resolve({
        kind: 'started',
        runId: 'run-1',
        deadlineAt: Date.now(),
        assistantMessageIds: null,
      }),
    tiles: [{ modelId: 'model-x', assistantMessageId: 'tile-1' }],
    callbacks: { onContent: (content) => contents.push(content) },
    frames: { onFrame: () => (): void => {} },
  });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  for (const frame of frames) for (const listener of listeners) listener(frame);
  for (const listener of listeners) {
    listener({
      type: 'run-finished',
      runId: 'run-1',
      outcome: { outcome: 'succeeded' },
    });
  }
  await run;
  return contents.at(-1) ?? '';
}

describe('useRemoteStreaming', () => {
  let frames: AnimationFrames;

  beforeEach(() => {
    vi.clearAllMocks();
    resetRunOwnershipForTests();
    frames = mockAnimationFrames();
    // A stored history the watcher's messages read finds fresh, so no test reaches the network.
    queryClient.setQueryData(chatKeys.messages('conv-1'), []);
  });

  afterEach(() => {
    frames.restore();
  });

  it("a watcher's phantom content equals the owner tile's content for the same frames", async () => {
    const streamFrames = [
      stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }),
      ...NESTED_SEARCH_EVENTS.map((event, index) => stream('s1', index + 2, event)),
      stream('s1', 20, finishEvent()),
    ];
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      for (const frame of streamFrames) ws.emit(frame);
    });

    const ownerContent = await ownerTileContent(streamFrames);
    expect(result.current.get('s1')?.content).toBe(ownerContent);
    expect(parseAssistantMessage(ownerContent)).toEqual([
      {
        kind: 'reasoning',
        children: [
          { kind: 'text', text: 'think' },
          {
            kind: 'webSearch',
            row: {
              v: 1,
              searches: [
                {
                  query: 'q',
                  status: 'done',
                  sources: [
                    { title: 'A', url: 'https://a.example' },
                    { title: 'B', url: 'https://b.example' },
                  ],
                },
              ],
              notRun: { limit: 0, invalidQuery: 0 },
            },
          },
          { kind: 'text', text: 'more' },
        ],
      },
      { kind: 'text', text: 'Answer' },
    ]);
  });

  it("the owner's tile equals the watcher's when a resubmitted run's frames beat its 201", async () => {
    const deadRun: RunFrame[] = [
      { type: 'run-started', runId: 'run-1' },
      stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }),
      stream('s1', 2, { kind: 'text-delta', index: 0, content: 'dead partial' }),
    ];
    const newRun: RunFrame[] = [
      { type: 'run-started', runId: 'run-2' },
      stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }),
      stream('s1', 2, { kind: 'text-delta', index: 0, content: 'fresh' }),
      stream('s1', 3, finishEvent()),
    ];
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });
    act(() => {
      for (const frame of [...deadRun, ...newRun]) ws.emit(frame);
    });

    const socket = createReconnectingRunSocket();
    let answerResubmit!: (response: RunStartResponse) => void;
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce({
        kind: 'started',
        runId: 'run-1',
        deadlineAt: Date.now(),
        assistantMessageIds: null,
      })
      .mockImplementationOnce(
        () =>
          new Promise<RunStartResponse>((resolve) => {
            answerResubmit = resolve;
          })
      );
    const tile: { content: string; errorCode?: string } = { content: '' };
    const run = executeChatRun({
      socket,
      postRun,
      tiles: [{ modelId: 'model-x', assistantMessageId: 'tile-1' }],
      callbacks: {
        onContent: (content) => {
          tile.content = content;
        },
        onRestart: () => {
          tile.content = '';
        },
        onModelError: (data) => {
          tile.errorCode = data.code;
        },
      },
      frames: { onFrame: () => (): void => {} },
    });
    await settle();
    for (const frame of deadRun) socket.emit(frame);
    socket.reconnect();
    await settle();
    for (const frame of newRun) socket.emit(frame);
    answerResubmit({
      kind: 'started',
      runId: 'run-2',
      deadlineAt: Date.now(),
      assistantMessageIds: null,
    });
    await settle();

    expect(tile.content).toBe(result.current.get('s1')?.content);
    expect(tile.content).toBe('fresh');
    socket.emit({ type: 'run-finished', runId: 'run-2', outcome: { outcome: 'succeeded' } });
    await run;
    expect(tile.errorCode).toBeUndefined();
  });

  describe('through the conversation socket client', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      RoomSocket.opened.length = 0;
      vi.stubGlobal('WebSocket', RoomSocket);
    });

    afterEach(() => {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    });

    function watchStreamingRun(): {
      client: ConversationWebSocket;
      phantoms: { current: Map<string, PhantomMessage> };
    } {
      const client = new ConversationWebSocket({ conversationId: 'conv-1' });
      client.connect();
      latestRoomSocket().dispatchEvent('open', {});
      latestRoomSocket().deliver({ type: 'ready' });
      const { result } = renderHook(() => useRemoteStreaming(client), { wrapper: WithQueryClient });
      act(() => {
        const room = latestRoomSocket();
        room.deliver({ type: 'run-started', runId: 'run-1' });
        room.deliver(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
        room.deliver(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'before drop' }));
      });
      act(() => {
        frames.run();
      });
      return { client, phantoms: result };
    }

    it('keeps a live run phantom when the socket reconnects into the same run', () => {
      const { client, phantoms } = watchStreamingRun();

      act(() => {
        const room = reconnect();
        room.deliver({ type: 'ready', runId: 'run-1' });
        room.deliver(stream('s1', 3, { kind: 'text-delta', index: 0, content: ' after' }));
      });
      act(() => {
        frames.run();
      });

      expect([...phantoms.current.keys()]).toEqual(['s1']);
      expect(phantoms.current.get('s1')?.content).toBe('before drop after');
      client.disconnect();
    });

    it('drops the previous run when the socket reconnects into a room live in no run', () => {
      const { client, phantoms } = watchStreamingRun();

      act(() => {
        reconnect().deliver({ type: 'ready' });
      });

      expect(phantoms.current.size).toBe(0);
      client.disconnect();
    });

    it('drops the previous run when the socket reconnects into a new run', () => {
      const { client, phantoms } = watchStreamingRun();

      act(() => {
        const room = reconnect();
        room.deliver({ type: 'ready', runId: 'run-2' });
        room.deliver(stream('s1', 5, { kind: 'text-delta', index: 0, content: 'fresh' }));
      });
      act(() => {
        frames.run();
      });

      expect(phantoms.current.size).toBe(0);
      client.disconnect();
    });
  });

  describe('the stored id', () => {
    /** Streams one finished answer of a remote run under `messageId`, then ends the run. */
    function finishedRemoteAnswer(ws: MockWs, messageId: string, runId = 'remote-run'): void {
      ws.emit({ type: 'run-started', runId });
      ws.emit(stream('answer#0', 1, { kind: 'stream-start', modelId: 'model-x', messageId }));
      ws.emit(stream('answer#0', 2, { kind: 'text-delta', index: 0, content: 'the answer' }));
      ws.emit(stream('answer#0', 3, finishEvent()));
      ws.emit({ type: 'run-finished', runId, outcome: { outcome: 'succeeded' } });
    }

    /** An answer the conversation's stored history holds, on whichever fork. */
    function storedAnswer(id: string): MessageResponse {
      return {
        id,
        parentMessageId: null,
        sequenceNumber: 1,
        epochNumber: 1,
        senderType: 'assistant',
        senderId: null,
        wrappedContentKey: '',
        batchId: 'batch-1',
        deleted: false,
        createdAt: isoAt(TEST_DAY_START),
        contentItems: [],
      };
    }

    /**
     * The conversation's history refetch settling: the same flush that hands the page its
     * rows. A success stores `storedIds`, the whole history across every fork.
     */
    async function refetchSettles(
      outcome: 'success' | 'error',
      storedIds: readonly string[] = []
    ): Promise<void> {
      await act(async () => {
        const key = chatKeys.messages('conv-1');
        if (outcome === 'success')
          queryClient.setQueryData(
            key,
            storedIds.map((id) => storedAnswer(id))
          );
        else {
          await queryClient
            .fetchQuery({
              queryKey: key,
              queryFn: () => Promise.reject(new Error('down')),
              retry: false,
              staleTime: 0,
            })
            .catch(() => undefined);
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    afterEach(() => {
      queryClient.clear();
      useSegmentViewState.setState({ open: new Set() });
    });

    /** The page's rows for a watcher: the stored messages, then each tile no stored row replaces. */
    function watcherRows(ws: MockWs, stored: { messages: Message[] }): () => React.ReactElement {
      return function WatcherRows(): React.ReactElement {
        const phantoms = useRemoteStreaming(asWs(ws));
        return createElement(
          'div',
          null,
          messagesWithPhantoms(stored.messages, phantoms, 'conv-1').map((m) =>
            createElement('div', { key: m.id, 'data-message-id': m.id })
          )
        );
      };
    }

    it("keys a remote run's live tile by the id its stream-start names", () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        ws.emit({ type: 'run-started', runId: 'remote-run' });
        ws.emit(
          stream('answer#0', 1, { kind: 'stream-start', modelId: 'model-x', messageId: 'srv-1' })
        );
        ws.emit(stream('answer#0', 2, { kind: 'text-delta', index: 0, content: 'hi' }));
      });
      act(() => {
        frames.run();
      });

      expect([...result.current.keys()]).toEqual(['srv-1']);
      expect(result.current.get('srv-1')?.content).toBe('hi');
    });

    it('keeps a finished tile after the run ends, awaiting its stored row', () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        finishedRemoteAnswer(ws, 'srv-1');
      });

      expect(result.current.get('srv-1')).toMatchObject({
        content: 'the answer',
        awaitingStoredRow: true,
      });
    });

    it('keeps a finished tile through a history refetch that fails', async () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        finishedRemoteAnswer(ws, 'srv-1');
      });
      await refetchSettles('error');

      expect(result.current.get('srv-1')?.awaitingStoredRow).toBe(true);
    });

    it('keeps a finished tile through a history refetch that succeeds without its row', async () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        finishedRemoteAnswer(ws, 'srv-1');
      });
      await refetchSettles('success');

      expect(result.current.get('srv-1')?.awaitingStoredRow).toBe(true);
    });

    it("stops its frame loop once the run's tiles only await their stored rows", () => {
      const ws = createMockWs();
      renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

      act(() => {
        finishedRemoteAnswer(ws, 'srv-1');
      });
      act(() => {
        frames.run();
      });

      expect(frames.pending()).toBe(0);
    });

    it('drops every tile at once when the run fails, since no stored row follows', () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        ws.emit({ type: 'run-started', runId: 'remote-run' });
        ws.emit(stream('answer#0', 1, { kind: 'stream-start', modelId: 'm', messageId: 'srv-1' }));
        ws.emit(stream('answer#0', 2, finishEvent()));
        ws.emit({
          type: 'run-finished',
          runId: 'remote-run',
          outcome: { outcome: 'failed', code: 'INTERNAL' },
        });
      });

      expect(result.current.size).toBe(0);
    });

    it("drops a failed sibling's tile at once when the run succeeds, since it stores no row", () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        ws.emit({ type: 'run-started', runId: 'remote-run' });
        ws.emit(stream('a#0', 1, { kind: 'stream-start', modelId: 'm', messageId: 'srv-ok' }));
        ws.emit(stream('b#1', 1, { kind: 'stream-start', modelId: 'm', messageId: 'srv-failed' }));
        ws.emit(stream('a#0', 2, finishEvent()));
        ws.emit(
          stream('b#1', 2, {
            kind: 'finish',
            metadata: { usage: { inputTokens: 1, outputTokens: 0 }, finishReason: 'error' },
          })
        );
        ws.emit({
          type: 'run-finished',
          runId: 'remote-run',
          outcome: { outcome: 'succeeded' },
        });
      });

      expect([...result.current.keys()]).toEqual(['srv-ok']);
    });

    it("does not show a watcher's open row open on the next run's tile", async () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        ws.emit({ type: 'run-started', runId: 'run-1' });
        ws.emit(
          stream('answer#0', 1, { kind: 'stream-start', modelId: 'model-x', messageId: 'srv-1' })
        );
      });
      const [firstRunId] = [...result.current.keys()];
      act(() => {
        useSegmentViewState.getState().toggle(firstRunId ?? '', 'reasoning');
        ws.emit(stream('answer#0', 2, finishEvent()));
        ws.emit({
          type: 'run-finished',
          runId: 'run-1',
          outcome: { outcome: 'succeeded' },
        });
      });
      await refetchSettles('success', ['srv-1']);
      act(() => {
        ws.emit({ type: 'run-started', runId: 'run-2' });
        ws.emit(
          stream('answer#0', 1, { kind: 'stream-start', modelId: 'model-x', messageId: 'srv-2' })
        );
      });

      const [nextRunId] = [...result.current.keys()];
      expect(nextRunId).not.toBe(firstRunId);
      expect(useSegmentViewState.getState().open.has(`${nextRunId ?? ''} reasoning`)).toBe(false);
    });

    it("keeps the watcher's row element when the stored row arrives", async () => {
      const ws = createMockWs();
      const stored: { messages: Message[] } = { messages: [] };
      const WatcherRows = watcherRows(ws, stored);
      const view = render(createElement(WatcherRows), { wrapper: WithQueryClient });
      act(() => {
        finishedRemoteAnswer(ws, 'srv-1');
      });
      const live = view.container.querySelector('[data-message-id="srv-1"]');
      expect(live).not.toBeNull();

      stored.messages = [
        {
          id: 'srv-1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'the answer',
          createdAt: '',
        },
      ];
      await refetchSettles('success');
      view.rerender(createElement(WatcherRows));

      expect(view.container.querySelector('[data-message-id="srv-1"]')).toBe(live);
    });

    it('drops a finished tile whose stream named no stored id when the run succeeds, since no stored row can replace it', () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        ws.emit({ type: 'run-started', runId: 'remote-run' });
        ws.emit(stream('answer#0', 1, { kind: 'stream-start', modelId: 'model-x' }));
        ws.emit(stream('answer#0', 2, finishEvent()));
        ws.emit({ type: 'run-finished', runId: 'remote-run', outcome: { outcome: 'succeeded' } });
      });

      expect(result.current.size).toBe(0);
    });

    it('keeps a waiting tile when the next run starts', async () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        finishedRemoteAnswer(ws, 'srv-1', 'run-1');
      });
      await refetchSettles('error');
      act(() => {
        ws.emit({ type: 'run-started', runId: 'run-2' });
      });

      expect(result.current.get('srv-1')?.awaitingStoredRow).toBe(true);
    });

    it("keeps an earlier run's waiting tile when the next run finishes", async () => {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        finishedRemoteAnswer(ws, 'srv-1', 'run-1');
      });
      await refetchSettles('error');
      act(() => {
        finishedRemoteAnswer(ws, 'srv-2', 'run-2');
      });

      expect([...result.current.keys()]).toEqual(['srv-1', 'srv-2']);
    });

    it('keeps the finished tile row element through the start of the next run after a failed refetch, until the stored row replaces it in place', async () => {
      const ws = createMockWs();
      const stored: { messages: Message[] } = { messages: [] };
      const WatcherRows = watcherRows(ws, stored);
      const view = render(createElement(WatcherRows), { wrapper: WithQueryClient });
      act(() => {
        finishedRemoteAnswer(ws, 'srv-1', 'run-1');
      });
      const live = view.container.querySelector('[data-message-id="srv-1"]');
      expect(live).not.toBeNull();
      await refetchSettles('error');
      act(() => {
        ws.emit({ type: 'run-started', runId: 'run-2' });
        ws.emit(
          stream('answer#0', 1, { kind: 'stream-start', modelId: 'model-x', messageId: 'srv-2' })
        );
      });
      expect(view.container.querySelector('[data-message-id="srv-1"]')).toBe(live);

      stored.messages = [
        {
          id: 'srv-1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'the answer',
          createdAt: '',
        },
      ];
      await refetchSettles('success', ['srv-1']);
      view.rerender(createElement(WatcherRows));

      expect(view.container.querySelector('[data-message-id="srv-1"]')).toBe(live);
    });

    it('stops showing an answer stored on another fork once it is stored, with no next run', async () => {
      const ws = createMockWs();
      // The viewed fork's list never holds the answer: it was stored on another fork.
      const viewedFork: { messages: Message[] } = { messages: [] };
      const WatcherRows = watcherRows(ws, viewedFork);
      const view = render(createElement(WatcherRows), { wrapper: WithQueryClient });
      act(() => {
        finishedRemoteAnswer(ws, 'srv-other-fork');
      });
      expect(view.container.querySelector('[data-message-id="srv-other-fork"]')).not.toBeNull();

      await refetchSettles('success', ['srv-other-fork']);
      view.rerender(createElement(WatcherRows));

      expect(view.container.querySelector('[data-message-id="srv-other-fork"]')).toBeNull();
    });

    it('logs no render-phase update when a sibling creates a query observer while the history lands', () => {
      const ws = createMockWs();
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      // As `MessageList` does through `useModels`: a component that first renders, and so
      // creates its query observer, in the render the stored history brings.
      function ListLike(): null {
        useQuery({ queryKey: ['models-like'], queryFn: () => Promise.resolve([]) });
        return null;
      }
      function PageLike(): React.ReactElement | null {
        useRemoteStreaming(asWs(ws));
        const { data = [] } = useQuery<MessageResponse[]>({
          queryKey: chatKeys.messages('conv-1'),
          queryFn: () => Promise.resolve([]),
          enabled: false,
        });
        return data.length === 0 ? null : createElement(ListLike);
      }
      render(createElement(PageLike), { wrapper: WithQueryClient });

      act(() => {
        queryClient.setQueryData(chatKeys.messages('conv-1'), [storedAnswer('srv-1')]);
      });

      const renderPhaseUpdates = errors.mock.calls.filter((call) =>
        String(call[0]).includes('while rendering a different component')
      );
      errors.mockRestore();
      expect(renderPhaseUpdates).toEqual([]);
    });

    it("keeps the watcher's row element through a failed refetch until the stored row arrives", async () => {
      const ws = createMockWs();
      const stored: { messages: Message[] } = { messages: [] };
      const WatcherRows = watcherRows(ws, stored);
      const view = render(createElement(WatcherRows), { wrapper: WithQueryClient });
      act(() => {
        finishedRemoteAnswer(ws, 'srv-1');
      });
      const live = view.container.querySelector('[data-message-id="srv-1"]');
      await refetchSettles('error');
      view.rerender(createElement(WatcherRows));
      expect(view.container.querySelector('[data-message-id="srv-1"]')).toBe(live);

      stored.messages = [
        {
          id: 'srv-1',
          conversationId: 'conv-1',
          role: 'assistant',
          content: 'the answer',
          createdAt: '',
        },
      ];
      await refetchSettles('success');
      view.rerender(createElement(WatcherRows));

      expect(view.container.querySelector('[data-message-id="srv-1"]')).toBe(live);
    });
  });

  it('returns an empty map with null ws', () => {
    const { result } = renderHook(() => useRemoteStreaming(null), { wrapper: WithQueryClient });
    expect(result.current).toBeInstanceOf(Map);
    expect(result.current.size).toBe(0);
  });

  it('renders a remote run as phantom tiles labeled by stream-start', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'Hel' }));
      ws.emit(stream('s1', 3, { kind: 'text-delta', index: 0, content: 'lo' }));
    });
    act(() => {
      frames.run();
    });

    expect(result.current.get('s1')).toEqual({
      content: 'Hello',
      senderType: 'assistant',
      modelName: 'model-x',
    });
  });

  it('renders multiple remote streams independently', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
      ws.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b' }));
      ws.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'B' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'A' }));
    });
    act(() => {
      frames.run();
    });

    expect(result.current.get('s1')?.content).toBe('A');
    expect(result.current.get('s2')?.content).toBe('B');
  });

  it('ignores frames of a locally-owned run', () => {
    markPendingLocalRun('conv-1');
    resolvePendingLocalRun('conv-1', 'local-run');
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'local-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'mine' }));
    });

    expect(result.current.size).toBe(0);
  });

  it('treats frames as local while a local POST is pending (pre-201 window)', () => {
    markPendingLocalRun('conv-1');
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'not-yet-resolved' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
    });

    expect(result.current.size).toBe(0);
  });

  it('drops stream frames arriving without a run-started verdict', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'orphan' }));
    });

    expect(result.current.size).toBe(0);
  });

  it('clears phantoms when the run finishes (refetch renders persisted rows)', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'hi' }));
    });
    expect(result.current.size).toBe(1);

    act(() => {
      ws.emit({
        type: 'run-finished',
        runId: 'remote-run',
        outcome: { outcome: 'succeeded' },
      } as RunFrame);
    });
    expect(result.current.size).toBe(0);
  });

  it('starts a reused stream id afresh when a new run starts after the last one finished', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });
    act(() => {
      ws.emit({ type: 'run-started', runId: 'run-1' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'dead partial' }));
      ws.emit({
        type: 'run-finished',
        runId: 'run-1',
        outcome: { outcome: 'stopped' },
      });
    });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'run-2' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'fresh' }));
    });
    act(() => {
      frames.run();
    });

    expect(result.current.get('s1')?.content).toBe('fresh');
  });

  it('starts a reused stream id afresh when a new run starts with no run-finished for the last', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });
    act(() => {
      ws.emit({ type: 'run-started', runId: 'run-1' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'dead partial' }));
    });
    act(() => {
      frames.run();
    });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'run-2' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'fresh' }));
    });
    act(() => {
      frames.run();
    });

    expect(result.current.get('s1')?.content).toBe('fresh');
  });

  it("shows only the new run's tile after a two-stream run died with no run-finished", async () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });
    act(() => {
      ws.emit({ type: 'run-started', runId: 'run-1' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-y' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'dead one' }));
      ws.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'dead two' }));
    });
    act(() => {
      frames.run();
    });

    const newRunFrames = [
      stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }),
      stream('s1', 2, { kind: 'text-delta', index: 0, content: 'fresh' }),
      stream('s1', 3, finishEvent()),
    ];
    act(() => {
      ws.emit({ type: 'run-started', runId: 'run-2' });
      for (const frame of newRunFrames) ws.emit(frame);
    });

    expect([...result.current.keys()]).toEqual(['s1']);
    expect(result.current.get('s1')?.content).toBe(await ownerTileContent(newRunFrames));
  });

  it('keeps a finished run cleared when a frame lands before the clear renders', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });
    act(() => {
      ws.emit({ type: 'run-started', runId: 'run-1' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
    });

    act(() => {
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'unpublished' }));
      ws.emit({
        type: 'run-finished',
        runId: 'run-1',
        outcome: { outcome: 'stopped' },
      });
      frames.run();
    });

    expect(result.current.size).toBe(0);
  });

  it('builds reasoning into the phantom content and leaves out tools other than web search', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'reasoning-delta', index: 0, content: 'hmm' }));
      ws.emit(stream('s1', 3, { kind: 'tool-call', id: 't', name: 'search', args: {} }));
      ws.emit(stream('s1', 4, finishEvent()));
    });

    expect(parseAssistantMessage(result.current.get('s1')?.content ?? '')).toEqual([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'hmm' }] },
    ]);
  });

  it('updates phantom content once per rendered frame', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'Hel' }));
      ws.emit(stream('s1', 3, { kind: 'text-delta', index: 0, content: 'lo' }));
    });
    expect(result.current.get('s1')?.content).toBe('');

    act(() => {
      frames.run();
    });

    expect(result.current.get('s1')?.content).toBe('Hello');
  });

  it('leaves the phantoms as they were on a frame with no new content', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });
    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'Hi' }));
    });
    act(() => {
      frames.run();
    });
    const settled = result.current;

    act(() => {
      frames.run();
    });

    expect(result.current).toBe(settled);
  });

  it('keeps updating phantom content on rendered frames under reduced motion', () => {
    useA11yStore.getState().setForcedReducedMotion(true);
    try {
      const ws = createMockWs();
      const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), {
        wrapper: WithQueryClient,
      });

      act(() => {
        ws.emit({ type: 'run-started', runId: 'remote-run' });
        ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
        ws.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'still' }));
      });
      act(() => {
        frames.run();
      });

      expect(result.current.get('s1')?.content).toBe('still');
    } finally {
      useA11yStore.getState().setForcedReducedMotion(false);
    }
  });

  it('publishes a finished stream its settled content at once, before any frame', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(
        stream('s1', 2, {
          kind: 'tool-call',
          id: 'c1',
          name: WEB_SEARCH_TOOL_NAME,
          args: { query: 'q' },
        })
      );
      ws.emit(stream('s1', 3, finishEvent()));
    });

    expect(parseAssistantMessage(result.current.get('s1')?.content ?? '')).toEqual([
      {
        kind: 'webSearch',
        row: {
          v: 1,
          searches: [{ query: 'q', status: 'interrupted' }],
          notRun: { limit: 0, invalidQuery: 0 },
        },
      },
    ]);
  });

  it("carries the finish frame's reasoning token count and effort on the phantom", () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, { kind: 'reasoning-delta', index: 0, content: 'hmm' }));
      ws.emit(
        stream('s1', 3, {
          kind: 'finish',
          metadata: {
            usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 64 },
            finishReason: 'stop',
          },
          reasoningEffort: 'high',
        })
      );
    });

    expect(result.current.get('s1')).toMatchObject({
      reasoningTokens: 64,
      reasoningEffort: 'high',
    });
  });

  it('leaves the phantom without a reasoning count or effort when the finish frame has none', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      ws.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-x' }));
      ws.emit(stream('s1', 2, finishEvent()));
    });

    expect(result.current.get('s1')).not.toHaveProperty('reasoningTokens');
    expect(result.current.get('s1')).not.toHaveProperty('reasoningEffort');
  });

  it('creates an unlabeled phantom for a text-delta with no preceding stream-start', () => {
    const ws = createMockWs();
    const { result } = renderHook(() => useRemoteStreaming(asWs(ws)), { wrapper: WithQueryClient });

    act(() => {
      ws.emit({ type: 'run-started', runId: 'remote-run' });
      // text-delta for a stream that never announced its model: the fallback
      // else-branch creates the phantom with no modelName.
      ws.emit(stream('s9', 1, { kind: 'text-delta', index: 0, content: 'raw' }));
    });
    act(() => {
      frames.run();
    });

    expect(result.current.get('s9')).toEqual({
      content: 'raw',
      senderType: 'assistant',
    });
    expect(result.current.get('s9')).not.toHaveProperty('modelName');
  });

  it('unsubscribes on unmount', () => {
    const ws = createMockWs();
    const { unmount } = renderHook(() => useRemoteStreaming(asWs(ws)), {
      wrapper: WithQueryClient,
    });
    expect(ws.listenerCount()).toBe(2);
    unmount();
    expect(ws.listenerCount()).toBe(0);
  });
});
