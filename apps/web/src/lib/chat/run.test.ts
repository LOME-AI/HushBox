import { describe, it, expect, vi } from 'vitest';
import {
  MAX_RUN_HARD_STOP_MS,
  parseAssistantMessage,
  SMART_MODEL_ID,
  WEB_SEARCH_TOOL_NAME,
  WireInferenceEvent,
} from '@hushbox/shared';
import { executeChatRun, keyTiles } from '@/lib/chat/run.js';
import { ChatRequestError } from '@/lib/chat/request-error.js';
import { parseServerFrame } from '@/lib/api/server-frames.js';
import type { InferenceEvent, Segment } from '@hushbox/shared';
import type { RunFrame } from '@/lib/api/server-frames.js';
import type {
  ChatRunCallbacks,
  FrameSource,
  RunStartResponse,
  RunTransportSocket,
} from '@/lib/chat/run.js';

interface ManualFrames extends FrameSource {
  /** One rendered frame: every subscribed listener runs once. */
  tick(): void;
  listenerCount(): number;
}

function createManualFrames(): ManualFrames {
  const listeners = new Set<() => void>();
  return {
    onFrame(listener: () => void): () => void {
      listeners.add(listener);
      return (): void => {
        listeners.delete(listener);
      };
    },
    tick(): void {
      for (const listener of listeners) listener();
    },
    listenerCount: (): number => listeners.size,
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

const NESTED_SEARCH_TREE: readonly Segment[] = [
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
];

interface FakeSocket extends RunTransportSocket {
  emit(frame: RunFrame): void;
  setReady(value: boolean): void;
}

function createFakeSocket(initialReady = true): FakeSocket {
  const frameListeners = new Set<(frame: RunFrame) => void>();
  const stateListeners = new Set<() => void>();
  let ready = initialReady;
  return {
    connect: vi.fn(),
    waitForReady: (): Promise<boolean> => Promise.resolve(ready),
    get ready(): boolean {
      return ready;
    },
    onRunFrame(listener: (frame: RunFrame) => void): () => void {
      frameListeners.add(listener);
      return (): void => {
        frameListeners.delete(listener);
      };
    },
    onStateChange(listener: () => void): () => void {
      stateListeners.add(listener);
      return (): void => {
        stateListeners.delete(listener);
      };
    },
    emit(frame: RunFrame): void {
      for (const listener of frameListeners) listener(frame);
    },
    setReady(value: boolean): void {
      ready = value;
      for (const listener of stateListeners) listener();
    },
  };
}

function stream(streamId: string, cursor: number, event: unknown): RunFrame {
  return { type: 'stream', streamId, cursor, event } as RunFrame;
}

const started = (runId = 'run-1', deadlineAt = Date.now() + 300_000): RunStartResponse => ({
  kind: 'started',
  runId,
  deadlineAt,
  assistantMessageIds: null,
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const finishEvent = (finishReason = 'stop', reasoningEffort?: string): unknown => ({
  kind: 'finish',
  metadata: {
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason,
  },
  ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
});

function runFinished(outcome: unknown, runId = 'run-1'): RunFrame {
  return { type: 'run-finished', runId, outcome } as RunFrame;
}

describe('keyTiles', () => {
  const tiles = [
    { modelId: 'model-a', assistantMessageId: 'local-a' },
    { modelId: 'model-b', assistantMessageId: 'local-b' },
  ];

  it('keys each tile, in order, by the answer id the response named for it', () => {
    expect(keyTiles(tiles, ['srv-a', 'srv-b'])).toEqual([
      { modelId: 'model-a', assistantMessageId: 'srv-a' },
      { modelId: 'model-b', assistantMessageId: 'srv-b' },
    ]);
  });

  it('leaves every tile on its key when the response named no ids', () => {
    expect(keyTiles(tiles, null)).toEqual(tiles);
  });

  it('leaves every tile on its key when the run stores no answers, as a trial names none', () => {
    expect(keyTiles(tiles, [])).toEqual(tiles);
  });

  it('rejects fewer answer ids than tiles', () => {
    expect(() => keyTiles(tiles, ['srv-a'])).toThrow(/1 answer ids for 2 tiles/);
  });

  it('rejects more answer ids than tiles', () => {
    expect(() => keyTiles(tiles, ['srv-a', 'srv-b', 'srv-c'])).toThrow(/3 answer ids for 2 tiles/);
  });
});

describe('executeChatRun answer ids', () => {
  const startedWith = (ids: string[], runId = 'run-1'): RunStartResponse => ({
    kind: 'started',
    runId,
    deadlineAt: Date.now() + 300_000,
    assistantMessageIds: ids,
  });

  it('streams each tile under the answer id the run-start response named', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(startedWith(['srv-a'])),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'local-a' }],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a', messageId: 'srv-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'hi' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(contents).toEqual([['hi', 'srv-a']]);
    expect(result).toEqual({
      outcome: 'succeeded',
      models: [{ modelId: 'model-a', assistantMessageId: 'srv-a' }],
    });
  });

  it('binds each stream to the tile its stream-start names, not to the tile of the model it labels', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(startedWith(['srv-smart', 'srv-b'])),
      tiles: [
        { modelId: SMART_MODEL_ID, assistantMessageId: 'local-smart' },
        { modelId: 'model-b', assistantMessageId: 'local-b' },
      ],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    // The Smart slot resolved to the very model pinned beside it.
    socket.emit(
      stream('s1', 1, { kind: 'stream-start', modelId: 'model-b', messageId: 'srv-smart' })
    );
    socket.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b', messageId: 'srv-b' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'smart' }));
    socket.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'pinned' }));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(contents).toEqual([
      ['smart', 'srv-smart'],
      ['pinned', 'srv-b'],
    ]);
  });

  it('streams each tile under the answer id an attach named', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve({ kind: 'attach', assistantMessageIds: ['srv-live'] }),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'local-a' }],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-live' });
    socket.emit(
      stream('s1', 1, { kind: 'stream-start', modelId: 'model-a', messageId: 'srv-live' })
    );
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'live' }));
    socket.emit(runFinished({ outcome: 'succeeded' }, 'run-live'));

    await promise;
    expect(contents).toEqual([['live', 'srv-live']]);
  });

  it('keeps the tiles on the ids the run start named when a resubmit attach names none', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(startedWith(['srv-1']))
      .mockResolvedValueOnce({ kind: 'attach', assistantMessageIds: null });
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'local-a' }],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a', messageId: 'srv-1' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'kept' }));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(contents).toEqual([['kept', 'srv-1']]);
  });

  it('moves the tiles onto the fresh ids a clean re-execution names', async () => {
    const socket = createFakeSocket();
    const onRestart = vi.fn();
    const contents: [string, string][] = [];
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(startedWith(['srv-1'], 'run-1'))
      .mockResolvedValueOnce(startedWith(['srv-2'], 'run-2'));
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'local-a' }],
      callbacks: { onRestart, onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    expect(onRestart).toHaveBeenCalledWith(['srv-2']);

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a', messageId: 'srv-2' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'again' }));
    socket.emit(runFinished({ outcome: 'succeeded' }, 'run-2'));

    const result = await promise;
    expect(contents).toEqual([['again', 'srv-2']]);
    expect(result).toMatchObject({ models: [{ assistantMessageId: 'srv-2' }] });
  });
});

describe('executeChatRun', () => {
  it('builds tile content with the search nested in the reasoning it happened in', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
      frames: createManualFrames(),
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    for (const [index, event] of NESTED_SEARCH_EVENTS.entries()) {
      socket.emit(stream('s1', index + 2, event));
    }
    socket.emit(stream('s1', 20, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    await promise;

    const [lastContent, id] = contents.at(-1) ?? ['', ''];
    expect(id).toBe('tile-1');
    expect(parseAssistantMessage(lastContent)).toEqual(NESTED_SEARCH_TREE);
  });

  it('publishes a finished tile its settled content at once, before any frame', async () => {
    const socket = createFakeSocket();
    const onContent = vi.fn<(content: string, assistantMessageId: string) => void>();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: { onContent },
      frames: createManualFrames(),
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'Hi' }));
    socket.emit(
      stream('s1', 3, {
        kind: 'tool-call',
        id: 'c1',
        name: WEB_SEARCH_TOOL_NAME,
        args: { query: 'q' },
      })
    );
    expect(onContent).not.toHaveBeenCalled();

    socket.emit(stream('s1', 4, finishEvent()));

    expect(onContent).toHaveBeenCalledTimes(1);
    const [content] = onContent.mock.lastCall ?? [''];
    expect(parseAssistantMessage(content)).toEqual([
      { kind: 'text', text: 'Hi' },
      {
        kind: 'webSearch',
        row: {
          v: 1,
          searches: [{ query: 'q', status: 'interrupted' }],
          notRun: { limit: 0, invalidQuery: 0 },
        },
      },
    ]);
    socket.emit(runFinished({ outcome: 'succeeded' }));
    await promise;
  });

  it('publishes a streaming tile its content once per rendered frame', async () => {
    const socket = createFakeSocket();
    const frames = createManualFrames();
    const onContent = vi.fn();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: { onContent },
      frames,
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    for (let cursor = 2; cursor < 52; cursor += 1) {
      socket.emit(stream('s1', cursor, { kind: 'text-delta', index: 0, content: 'x' }));
    }
    expect(onContent).not.toHaveBeenCalled();

    frames.tick();
    frames.tick();

    expect(onContent.mock.calls).toEqual([['x'.repeat(50), 'tile-1']]);
    socket.emit(stream('s1', 52, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    await promise;
  });

  it('stops listening for frames when the run ends', async () => {
    const socket = createFakeSocket();
    const frames = createManualFrames();
    const promise = executeChatRun({
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: {},
      frames,
    });
    await flush();
    expect(frames.listenerCount()).toBe(1);

    socket.emit(runFinished({ outcome: 'succeeded' }));
    await promise;

    expect(frames.listenerCount()).toBe(0);
  });

  it('streams a single-model turn to completion', async () => {
    const socket = createFakeSocket();
    const textDeltas: [string, string][] = [];
    const callbacks: ChatRunCallbacks = {
      onRunStarted: vi.fn(),
      onModelResolved: vi.fn(),
      onTextDelta: (text, id) => textDeltas.push([text, id]),
      onModelDone: vi.fn(),
      onAllModelsComplete: vi.fn(),
    };
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks,
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-1' });
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'Hel' }));
    socket.emit(stream('s1', 3, { kind: 'text-delta', index: 0, content: 'lo' }));
    socket.emit(stream('s1', 4, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(result).toEqual({
      outcome: 'succeeded',
      models: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
    });
    expect(callbacks.onRunStarted).toHaveBeenCalledWith('run-1');
    expect(callbacks.onModelResolved).toHaveBeenCalledWith('tile-1', 'model-a');
    expect(textDeltas.map(([text]) => text).join('')).toBe('Hello');
    expect(textDeltas.every(([, id]) => id === 'tile-1')).toBe(true);
    expect(callbacks.onModelDone).toHaveBeenCalledWith({
      assistantMessageId: 'tile-1',
      modelId: 'model-a',
    });
    expect(callbacks.onAllModelsComplete).toHaveBeenCalledTimes(1);
  });

  describe('read-aloud text', () => {
    async function spokenFor(events: InferenceEvent[]): Promise<string> {
      const socket = createFakeSocket();
      const spoken: string[] = [];
      const frames = createManualFrames();
      const promise = executeChatRun({
        frames,
        socket,
        postRun: () => Promise.resolve(started()),
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
        callbacks: { onTextDelta: (text) => spoken.push(text) },
      });
      await flush();
      socket.emit({ type: 'run-started', runId: 'run-1' });
      socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
      for (const [index, event] of events.entries()) {
        socket.emit(stream('s1', index + 2, event));
        frames.tick();
      }
      socket.emit(stream('s1', events.length + 2, finishEvent()));
      socket.emit(runFinished({ outcome: 'succeeded' }));
      await promise;
      return spoken.join('');
    }

    it('speaks the answer either side of a search row as two paragraphs', async () => {
      const spoken = await spokenFor([
        { kind: 'step-start', step: 0 },
        { kind: 'text-delta', index: 0, content: 'Let me look.' },
        {
          kind: 'tool-call',
          id: 'c1',
          name: WEB_SEARCH_TOOL_NAME,
          args: { query: 'q' },
        },
        { kind: 'tool-result', id: 'c1', name: WEB_SEARCH_TOOL_NAME, result: { results: [] } },
        { kind: 'step-start', step: 1 },
        { kind: 'text-delta', index: 0, content: 'Found it.' },
      ]);
      expect(spoken).toBe('Let me look.\n\nFound it.');
    });

    it('never speaks reasoning', async () => {
      const spoken = await spokenFor([
        { kind: 'reasoning-delta', index: 0, content: 'thinking' },
        { kind: 'text-delta', index: 0, content: 'Answer.' },
      ]);
      expect(spoken).toBe('Answer.');
    });
  });

  it('demuxes interleaved multi-model streams by stream-start model id', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [
        { modelId: 'model-a', assistantMessageId: 'tile-a' },
        { modelId: 'model-b', assistantMessageId: 'tile-b' },
      ],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    // model-b's stream starts first — binding is by model id, not arrival order
    socket.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b' }));
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'B' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'A' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(stream('s2', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(contents).toEqual([
      ['A', 'tile-a'],
      ['B', 'tile-b'],
    ]);
    expect(result.outcome).toBe('succeeded');
  });

  it('binds an unmatched stream to the first unbound tile (Smart Model resolution)', async () => {
    const socket = createFakeSocket();
    const onModelResolved = vi.fn();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'smart-model', assistantMessageId: 'tile-1' }],
      callbacks: { onModelResolved },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'openai/gpt-4o' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(onModelResolved).toHaveBeenCalledWith('tile-1', 'openai/gpt-4o');
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models).toEqual([{ modelId: 'openai/gpt-4o', assistantMessageId: 'tile-1' }]);
  });

  it('binds a resolved Smart stream to the Smart tile, not to the pinned tile that arrives later', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const onModelResolved = vi.fn();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      // Slot LAST: with the slot at position 0 the first-unbound fallback is
      // accidentally right, so this is the arrangement that shows the binding.
      tiles: [
        { modelId: 'model-a', assistantMessageId: 'tile-a' },
        { modelId: SMART_MODEL_ID, assistantMessageId: 'tile-smart' },
      ],
      callbacks: {
        onContent: (content, id) => contents.push([content, id]),
        onModelResolved,
      },
    });
    await flush();

    // The slot's stream arrives first, naming a model no tile carries. Only the
    // Smart tile can receive an id it was not allocated for; taking the first
    // unbound tile instead leaves each answer under the other one's label.
    socket.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'openai/gpt-4o' }));
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'S' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'A' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(stream('s2', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(contents).toEqual([
      ['A', 'tile-a'],
      ['S', 'tile-smart'],
    ]);
    expect(onModelResolved).toHaveBeenCalledWith('tile-smart', 'openai/gpt-4o');
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models).toEqual([
      { modelId: 'model-a', assistantMessageId: 'tile-a' },
      { modelId: 'openai/gpt-4o', assistantMessageId: 'tile-smart' },
    ]);
  });

  it('builds reasoning into the tile content and leaves out tools other than web search', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'reasoning-delta', index: 0, content: 'thinking' }));
    socket.emit(stream('s1', 3, { kind: 'tool-call', id: 't1', name: 'search', args: {} }));
    socket.emit(stream('s1', 4, { kind: 'tool-result', id: 't1', name: 'search', result: {} }));
    socket.emit(stream('s1', 5, { kind: 'step-start', step: 0 }));
    socket.emit(stream('s1', 6, { kind: 'step-finish', step: 0, generationId: 'g1' }));
    socket.emit(stream('s1', 7, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    const [content, id] = contents.at(-1) ?? ['', ''];
    expect(id).toBe('tile-1');
    expect(parseAssistantMessage(content)).toEqual([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'thinking' }] },
    ]);
  });

  it('surfaces media-start and media-done for a media stream', async () => {
    const socket = createFakeSocket();
    const onMediaStart = vi.fn();
    const onMediaDone = vi.fn();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'image-model', assistantMessageId: 'tile-1' }],
      callbacks: { onMediaStart, onMediaDone },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'image-model' }));
    socket.emit(
      stream('s1', 2, { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' })
    );
    socket.emit(
      stream('s1', 3, {
        kind: 'media-done',
        index: 0,
        value: { ref: 'r', mimeType: 'image/png', modality: 'image', byteLength: 5, metadata: {} },
      })
    );
    socket.emit(stream('s1', 4, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(onMediaStart).toHaveBeenCalledWith({
      assistantMessageId: 'tile-1',
      mediaType: 'image',
      mimeType: 'image/png',
    });
    expect(onMediaDone).toHaveBeenCalledWith({ assistantMessageId: 'tile-1' });
  });

  it('signals early media generation from a stream-start carrying outputModality', async () => {
    const socket = createFakeSocket();
    const onMediaStart = vi.fn();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'video-model', assistantMessageId: 'tile-1' }],
      callbacks: { onMediaStart },
    });
    await flush();

    socket.emit(
      stream('s1', 1, { kind: 'stream-start', modelId: 'video-model', outputModality: 'video' })
    );
    expect(onMediaStart).toHaveBeenCalledWith({
      assistantMessageId: 'tile-1',
      mediaType: 'video',
      mimeType: 'video/*',
    });

    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    await promise;
  });

  it('does not signal media generation for a text stream-start', async () => {
    const socket = createFakeSocket();
    const onMediaStart = vi.fn();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: { onMediaStart },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    await promise;
    expect(onMediaStart).not.toHaveBeenCalled();
  });

  it('forwards media-progress percents to onMediaProgress', async () => {
    const socket = createFakeSocket();
    const onMediaProgress = vi.fn();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'video-model', assistantMessageId: 'tile-1' }],
      callbacks: { onMediaProgress },
    });
    await flush();

    socket.emit(
      stream('s1', 1, { kind: 'stream-start', modelId: 'video-model', outputModality: 'video' })
    );
    socket.emit(stream('s1', 2, { kind: 'media-progress', index: 0, percent: 10 }));
    socket.emit(stream('s1', 3, { kind: 'media-progress', index: 0, percent: 95 }));
    socket.emit(stream('s1', 4, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(onMediaProgress.mock.calls).toEqual([
      [{ assistantMessageId: 'tile-1', percent: 10 }],
      [{ assistantMessageId: 'tile-1', percent: 95 }],
    ]);
  });

  it('surfaces the finish usage reasoning token count for the tile', async () => {
    const socket = createFakeSocket();
    const counts: [number, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: {
        onReasoningTokens: (count, id) => counts.push([count, id]),
      },
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-1' });
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(
      stream('s1', 2, {
        kind: 'finish',
        metadata: {
          usage: { inputTokens: 1, outputTokens: 1, reasoningTokens: 1204 },
          finishReason: 'stop',
        },
      })
    );
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(counts).toEqual([[1204, 'tile-1']]);
  });

  it('surfaces the reasoning token count from a finish frame as the room delivers it', async () => {
    const socket = createFakeSocket();
    const counts: [number, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: {
        onReasoningTokens: (count, id) => counts.push([count, id]),
      },
    });
    await flush();
    const delivered = parseServerFrame(
      JSON.stringify({
        type: 'stream',
        streamId: 's1',
        cursor: 2,
        event: WireInferenceEvent.parse({
          kind: 'finish',
          metadata: {
            usage: { inputTokens: 5, outputTokens: 7, reasoningTokens: 640 },
            finishReason: 'stop',
            providerCostUsd: 0.01,
          },
        }),
      })
    );
    if (delivered?.type !== 'stream') throw new Error('expected the finish frame to parse');

    socket.emit({ type: 'run-started', runId: 'run-1' });
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(delivered);
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(counts).toEqual([[640, 'tile-1']]);
  });

  it('emits no reasoning token count when the finish usage carries none', async () => {
    const socket = createFakeSocket();
    const counts: [number, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: {
        onReasoningTokens: (count, id) => counts.push([count, id]),
      },
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-1' });
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(counts).toEqual([]);
  });

  it('surfaces the finish frame resolved reasoning level for the tile', async () => {
    const socket = createFakeSocket();
    const levels: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: {
        onReasoningEffort: (effort, id) => levels.push([effort, id]),
      },
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-1' });
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent('stop', 'high')));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(levels).toEqual([['high', 'tile-1']]);
  });

  it('surfaces a recorded off level rather than treating it as no level', async () => {
    const socket = createFakeSocket();
    const levels: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: {
        onReasoningEffort: (effort, id) => levels.push([effort, id]),
      },
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-1' });
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent('stop', 'off')));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(levels).toEqual([['off', 'tile-1']]);
  });

  it('surfaces no level when the finish frame records none', async () => {
    const socket = createFakeSocket();
    const levels: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-1' }],
      callbacks: {
        onReasoningEffort: (effort, id) => levels.push([effort, id]),
      },
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-1' });
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(levels).toEqual([]);
  });

  it('marks a stream finishing with reason error as a model error', async () => {
    const socket = createFakeSocket();
    const onModelError = vi.fn();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [
        { modelId: 'model-a', assistantMessageId: 'tile-a' },
        { modelId: 'model-b', assistantMessageId: 'tile-b' },
      ],
      callbacks: { onModelError },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(stream('s2', 2, finishEvent('error')));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(onModelError).toHaveBeenCalledWith({
      assistantMessageId: 'tile-b',
      modelId: 'model-b',
      code: 'STREAM_ERROR',
    });
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models[1]).toEqual({
      modelId: 'model-b',
      assistantMessageId: 'tile-b',
      errorCode: 'STREAM_ERROR',
    });
  });

  it('marks a tile that never streamed as errored when the run succeeds', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [
        { modelId: 'model-a', assistantMessageId: 'tile-a' },
        { modelId: 'model-b', assistantMessageId: 'tile-b' },
      ],
      callbacks: {},
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models[1]?.errorCode).toBe('STREAM_ERROR');
  });

  it('does not mark unfinished tiles as errored when the run is stopped', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'partial' }));
    socket.emit(runFinished({ outcome: 'stopped' }));

    const result = await promise;
    if (result.outcome !== 'stopped') throw new Error('expected stopped');
    expect(result.models[0]?.errorCode).toBeUndefined();
  });

  it('returns replayed for a settled-run replay response without waiting for frames', async () => {
    const socket = createFakeSocket();
    const result = await executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve({ kind: 'replay' }),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    expect(result).toEqual({ outcome: 'replayed' });
  });

  it('returns failed with the code when the run fails', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(runFinished({ outcome: 'failed', code: 'INTERNAL' }));

    const result = await promise;
    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('expected failed');
    expect(result.code).toBe('INTERNAL');
  });

  it('ignores a run-finished frame for a different run', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started('run-1')),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(runFinished({ outcome: 'failed', code: 'INTERNAL' }, 'other-run'));
    socket.emit(runFinished({ outcome: 'succeeded' }, 'run-1'));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
  });

  it('rethrows a refusal from the run-start POST', async () => {
    const socket = createFakeSocket();
    await expect(
      executeChatRun({
        frames: createManualFrames(),
        socket,
        postRun: () => Promise.reject(new ChatRequestError('CONCURRENT_RUN')),
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: {},
      })
    ).rejects.toMatchObject({ code: 'CONCURRENT_RUN' });
  });

  it('fails without posting when the socket never becomes ready', async () => {
    const socket = createFakeSocket(false);
    socket.waitForReady = (): Promise<boolean> => Promise.resolve(false);
    const postRun = vi.fn();
    const result = await executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: postRun as unknown as () => Promise<RunStartResponse>,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    expect(postRun).not.toHaveBeenCalled();
    expect(result.outcome).toBe('failed');
  });

  it('retries the connect and the ready wait when the room is slow to register', async () => {
    const socket = createFakeSocket(false);
    const waitForReady = vi
      .fn<(timeoutMs: number) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    socket.waitForReady = waitForReady;
    const postRun = vi.fn<() => Promise<RunStartResponse>>().mockResolvedValue(started());
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    expect(waitForReady).toHaveBeenCalledTimes(2);
    expect(socket.connect).toHaveBeenCalledTimes(2);
    expect(postRun).toHaveBeenCalledTimes(1);

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    const result = await promise;
    expect(result.outcome).toBe('succeeded');
  });

  it('bounds the ready retries, failing the turn once the budget is spent', async () => {
    const socket = createFakeSocket(false);
    const waitForReady = vi.fn<(timeoutMs: number) => Promise<boolean>>().mockResolvedValue(false);
    socket.waitForReady = waitForReady;
    const postRun = vi.fn<() => Promise<RunStartResponse>>();
    const result = await executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });

    expect(waitForReady).toHaveBeenCalledTimes(3);
    expect(postRun).not.toHaveBeenCalled();
    expect(result).toEqual({ outcome: 'failed', code: 'CHAT_STREAM_FAILED', models: [] });
  });

  it('buffers frames that land before the POST resolves', async () => {
    const socket = createFakeSocket();
    const frames = createManualFrames();
    const contents: string[] = [];
    let resolvePost!: (r: RunStartResponse) => void;
    const promise = executeChatRun({
      frames,
      socket,
      postRun: () =>
        new Promise<RunStartResponse>((resolve) => {
          resolvePost = resolve;
        }),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onContent: (content) => contents.push(content) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'early' }));
    frames.tick();
    expect(contents).toEqual([]);

    resolvePost(started());
    await flush();
    frames.tick();
    expect(contents).toEqual(['early']);

    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    await promise;
  });

  it('fails as deadline when the client-side deadline elapses with no terminal frame', async () => {
    vi.useFakeTimers();
    try {
      const socket = createFakeSocket();
      const promise = executeChatRun({
        frames: createManualFrames(),
        socket,
        postRun: () => Promise.resolve(started('run-1', Date.now() + 60_000)),
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: {},
        deadlineGraceMs: 1000,
      });
      await flush();

      vi.advanceTimersByTime(61_001);

      const result = await promise;
      expect(result.outcome).toBe('deadline');
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles an unfinished tile and publishes it at once when the run is stopped', async () => {
    const socket = createFakeSocket();
    const onContent = vi.fn<(content: string, assistantMessageId: string) => void>();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onContent },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(
      stream('s1', 2, {
        kind: 'tool-call',
        id: 'c1',
        name: WEB_SEARCH_TOOL_NAME,
        args: { query: 'q' },
      })
    );
    socket.emit(runFinished({ outcome: 'stopped' }));
    await promise;

    expect(onContent).toHaveBeenCalledTimes(1);
    const [content, id] = onContent.mock.lastCall ?? ['', ''];
    expect(id).toBe('tile-a');
    expect(parseAssistantMessage(content)).toEqual([
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

  it('publishes an unfinished tile its streamed content when the client deadline elapses', async () => {
    vi.useFakeTimers();
    try {
      const socket = createFakeSocket();
      const onContent = vi.fn();
      const promise = executeChatRun({
        frames: createManualFrames(),
        socket,
        postRun: () => Promise.resolve(started('run-1', Date.now() + 60_000)),
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: { onContent },
        deadlineGraceMs: 1000,
      });
      await flush();
      socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
      socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'partial' }));

      vi.advanceTimersByTime(61_001);
      await promise;

      expect(onContent.mock.calls).toEqual([['partial', 'tile-a']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-resubmits once on reconnect and attaches to the live run', async () => {
    const socket = createFakeSocket();
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce({ kind: 'attach', assistantMessageIds: null });
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    expect(postRun).toHaveBeenCalledTimes(2);

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));
    const result = await promise;
    expect(result.outcome).toBe('succeeded');
  });

  it('applies the live run frames that land while an attaching resubmit is pending', async () => {
    const socket = createFakeSocket();
    let answerResubmit!: (response: RunStartResponse) => void;
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockImplementationOnce(
        () =>
          new Promise<RunStartResponse>((resolve) => {
            answerResubmit = resolve;
          })
      );
    const contents: string[] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onContent: (content) => contents.push(content) },
    });
    await flush();
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'kept ' }));

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    socket.emit(stream('s1', 3, { kind: 'text-delta', index: 0, content: 'going' }));
    socket.emit(stream('s1', 4, finishEvent()));
    answerResubmit({ kind: 'attach', assistantMessageIds: null });
    await flush();
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(result).toEqual({
      outcome: 'succeeded',
      models: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
    });
    expect(contents).toEqual(['kept going']);
  });

  it('settles with the frames held before its run-finished when the run ends during a resubmit', async () => {
    const socket = createFakeSocket();
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockImplementationOnce(() => new Promise<RunStartResponse>(() => {}));
    const contents: string[] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onContent: (content) => contents.push(content) },
    });
    await flush();
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'all ' }));

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    socket.emit(stream('s1', 3, { kind: 'text-delta', index: 0, content: 'of it' }));
    socket.emit(stream('s1', 4, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    expect(contents).toEqual(['all of it']);
  });

  it('treats a replay on resubmit as the settled outcome', async () => {
    const socket = createFakeSocket();
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce({ kind: 'replay' });
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();

    const result = await promise;
    expect(result.outcome).toBe('replayed');
  });

  it('resets tiles and rebinds when a resubmit starts a clean re-execution', async () => {
    const socket = createFakeSocket();
    const onRestart = vi.fn();
    const frames = createManualFrames();
    const contents: string[] = [];
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started('run-1'))
      .mockResolvedValueOnce(started('run-2'));
    const promise = executeChatRun({
      frames,
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onRestart, onContent: (content) => contents.push(content) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'first' }));
    frames.tick();

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    expect(onRestart).toHaveBeenCalledWith(['tile-a']);

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'second' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }, 'run-2'));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    expect(contents).toEqual(['first', 'second']);
  });

  it('surfaces an error after the resubmit budget is exhausted', async () => {
    const socket = createFakeSocket();
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce({ kind: 'attach', assistantMessageIds: null });
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();
    socket.setReady(false);
    socket.setReady(true);
    await flush();

    const result = await promise;
    expect(result.outcome).toBe('failed');
    expect(postRun).toHaveBeenCalledTimes(2);
  });

  it('settles with the first terminal outcome when run-finished arrives twice', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(runFinished({ outcome: 'stopped' }));
    socket.emit(runFinished({ outcome: 'failed', code: 'INTERNAL' }));

    const result = await promise;
    expect(result.outcome).toBe('stopped');
  });

  it('ignores streams beyond the tile allocation', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s2', 1, { kind: 'stream-start', modelId: 'model-b' }));
    socket.emit(stream('s2', 2, { kind: 'text-delta', index: 0, content: 'orphan' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'kept' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(contents).toEqual([['kept', 'tile-a']]);
    if (result.outcome !== 'succeeded') throw new Error('expected success');
    expect(result.models).toEqual([{ modelId: 'model-a', assistantMessageId: 'tile-a' }]);
  });

  it('reports a tile done once even when its finish event is replayed', async () => {
    const socket = createFakeSocket();
    const onModelDone = vi.fn();
    const onAllModelsComplete = vi.fn();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onModelDone, onAllModelsComplete },
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, finishEvent()));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }));

    await promise;
    expect(onModelDone).toHaveBeenCalledTimes(1);
    expect(onAllModelsComplete).toHaveBeenCalledTimes(1);
  });

  it('keeps an attached run alive until the latest hard stop of any deadline class', async () => {
    vi.useFakeTimers();
    try {
      const promise = executeChatRun({
        frames: createManualFrames(),
        socket: createFakeSocket(),
        postRun: () => Promise.resolve({ kind: 'attach', assistantMessageIds: null }),
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: {},
        deadlineGraceMs: 1000,
      });
      await flush();

      await vi.advanceTimersByTimeAsync(MAX_RUN_HARD_STOP_MS + 999);
      const pending = Symbol('pending');
      await expect(Promise.race([promise, Promise.resolve(pending)])).resolves.toBe(pending);
    } finally {
      vi.useRealTimers();
    }
  });

  it('declares an attached run dead one grace after the latest hard stop', async () => {
    vi.useFakeTimers();
    try {
      const promise = executeChatRun({
        frames: createManualFrames(),
        socket: createFakeSocket(),
        postRun: () => Promise.resolve({ kind: 'attach', assistantMessageIds: null }),
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: {},
        deadlineGraceMs: 1000,
      });
      await flush();

      await vi.advanceTimersByTimeAsync(MAX_RUN_HARD_STOP_MS + 1000);
      const result = await promise;
      expect(result.outcome).toBe('deadline');
    } finally {
      vi.useRealTimers();
    }
  });

  it('attaches to a live run when the initial POST returns attach', async () => {
    const socket = createFakeSocket();
    const contents: [string, string][] = [];
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve({ kind: 'attach', assistantMessageIds: null }),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onContent: (content, id) => contents.push([content, id]) },
    });
    await flush();

    socket.emit({ type: 'run-started', runId: 'run-live' } as RunFrame);
    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit(stream('s1', 2, { kind: 'text-delta', index: 0, content: 'live' }));
    socket.emit(stream('s1', 3, finishEvent()));
    socket.emit(runFinished({ outcome: 'succeeded' }, 'run-live'));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    expect(contents).toEqual([['live', 'tile-a']]);
  });

  it.each([
    ['a coded refusal', new ChatRequestError('CONCURRENT_RUN'), 'CONCURRENT_RUN'],
    ['a plain Error', new Error('boom'), 'CHAT_STREAM_FAILED'],
    ['a non-string code', { code: 42 }, 'CHAT_STREAM_FAILED'],
    ['a primitive', 'boom', 'CHAT_STREAM_FAILED'],
    ['null', null, 'CHAT_STREAM_FAILED'],
  ])(
    'fails the run with the extracted code when the reconnect resubmit rejects with %s',
    async (_label, rejection, expectedCode) => {
      const socket = createFakeSocket();
      const postRun = vi
        .fn<() => Promise<RunStartResponse>>()
        .mockResolvedValueOnce(started())
        .mockRejectedValueOnce(rejection);
      const promise = executeChatRun({
        frames: createManualFrames(),
        socket,
        postRun,
        tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
        callbacks: {},
      });
      await flush();

      socket.setReady(false);
      socket.setReady(true);
      await flush();

      const result = await promise;
      expect(result.outcome).toBe('failed');
      if (result.outcome !== 'failed') throw new Error('expected failed');
      expect(result.code).toBe(expectedCode);
    }
  );

  it('discards a resubmit response that lands after the run already settled', async () => {
    const socket = createFakeSocket();
    const onRestart = vi.fn();
    let resolveSecond!: (response: RunStartResponse) => void;
    const postRun = vi
      .fn<() => Promise<RunStartResponse>>()
      .mockResolvedValueOnce(started())
      .mockImplementationOnce(
        () =>
          new Promise<RunStartResponse>((resolve) => {
            resolveSecond = resolve;
          })
      );
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun,
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: { onRestart },
    });
    await flush();

    socket.setReady(false);
    socket.setReady(true);
    await flush();

    socket.emit(runFinished({ outcome: 'succeeded' }));
    resolveSecond(started('run-2'));
    await flush();

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
    expect(onRestart).not.toHaveBeenCalled();
  });

  it('tolerates stream-gone without corrupting the run', async () => {
    const socket = createFakeSocket();
    const promise = executeChatRun({
      frames: createManualFrames(),
      socket,
      postRun: () => Promise.resolve(started()),
      tiles: [{ modelId: 'model-a', assistantMessageId: 'tile-a' }],
      callbacks: {},
    });
    await flush();

    socket.emit(stream('s1', 1, { kind: 'stream-start', modelId: 'model-a' }));
    socket.emit({ type: 'stream-gone', streamId: 's1' });
    socket.emit(runFinished({ outcome: 'succeeded' }));

    const result = await promise;
    expect(result.outcome).toBe('succeeded');
  });
});
