import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DefaultGeneratedFile } from 'ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { expectExposes } from '@hushbox/shared/test-assertions';
import {
  TEST_DAY_END,
  TEST_DAY_START,
  freezeClock,
  secondsAt,
  setClock,
} from '@hushbox/shared/test-time';
import {
  buildTurnSystemPrompt,
  historyCharacterCount,
  promptCharacterCount,
  serializeSegments,
  utcDayKey,
} from '@hushbox/shared';
import { tokenPricingFixture } from '@hushbox/shared/pricing-fixture';
import {
  buildToolset,
  createLanguageAdapter,
  extractStepCost,
  mapPart,
} from './language-adapter.js';
import { createModelProvider } from './dispatch.js';
import { createCassetteStore, type CassetteStore } from './cassette/cassette-store.js';
import { createCassetteFetch } from './cassette/recording-fetch.js';
import { createFixtureFetch, FAILURE_FIXTURES } from './cassette/failure-fixtures.js';
import { descriptorHash, requestToDescriptor } from './cassette/canonical-request.js';
import { recordedStreamCostUsd } from './cassette/recorded-cost.js';
import type { LanguageModelUsage, TextStreamPart, ToolSet, TypedToolCall } from 'ai';
import type {
  FilePart,
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  MediaValue,
  ModelDescriptor,
} from '@hushbox/shared';
import type { ToolDefinition, ToolSelection } from '../ports/model-provider.js';

/** An inert fixture stamp: nothing in this file reads it against a clock. */
const FIXTURE_STAMP_SECONDS = secondsAt(TEST_DAY_START);

/** The day every request in this file carries, so the assembled bytes are fixed. */
const FIXTURE_UTC_DAY = utcDayKey(new Date(TEST_DAY_START));

let rootDir: string;
let store: CassetteStore;

beforeEach(() => {
  rootDir = mkdtempSync(path.join(tmpdir(), 'language-adapter-'));
  store = createCassetteStore({ rootDir });
});

afterEach(() => {
  vi.useRealTimers();
  rmSync(rootDir, { recursive: true, force: true });
});

function testDescriptor(overrides: Partial<ModelDescriptor> = {}): ModelDescriptor {
  return {
    id: 'openai/gpt-4o',
    provider: 'openai',
    version: '1',
    inputs: ['text'],
    outputs: ['text'],
    parameters: {},
    behaviors: ['streaming'],
    limits: {},
    pricing: tokenPricingFixture({ input: 1n, output: 1n }),
    zdrReachable: true,
    releasedAt: FIXTURE_STAMP_SECONDS,
    fetchedAt: 0,
    ...overrides,
  };
}

function textRequest(text: string): InferenceRequest {
  return {
    model: 'openai/gpt-4o',
    inputs: [{ modality: 'text', text }],
    parameters: {},
    outputs: ['text'],
    utcDay: FIXTURE_UTC_DAY,
  };
}

/**
 * SYNTHETIC wire stream: OpenRouter's OpenAI-compatible chat SSE chunks
 * authored from the provider schema, not recorded from the live provider (no
 * credentials here). The provider's `doStream` normalizes these into the SDK's
 * stream parts.
 */
function sseBody(chunks: unknown[]): string {
  return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

function sseResponse(chunks: unknown[]): Response {
  return new Response(sseBody(chunks), {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

interface FinishOptions {
  finishReason?: string;
  usage?: Record<string, number> | undefined;
}

function textDelta(id: string, content: string, first = false): unknown {
  return {
    id,
    ...(first ? { provider: 'openai' } : {}),
    choices: [{ index: 0, delta: { ...(first ? { role: 'assistant' } : {}), content } }],
  };
}

function finishChunk(id: string, options: FinishOptions = {}): unknown {
  const usage =
    'usage' in options
      ? options.usage
      : { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.12 };
  return {
    id,
    choices: [{ index: 0, delta: {}, finish_reason: options.finishReason ?? 'stop' }],
    ...(usage === undefined ? {} : { usage }),
  };
}

/** Serves each scripted response once, in order; throws when exhausted. */
function scriptedFetch(responses: (() => Response)[]): typeof globalThis.fetch {
  let next = 0;
  return function scripted(): Promise<Response> {
    const make = responses[next];
    next += 1;
    if (make === undefined) throw new Error(`scriptedFetch exhausted after ${String(next - 1)}`);
    return Promise.resolve(make());
  };
}

function simpleTextChunks(): unknown[] {
  return [
    textDelta('gen_single', 'Hello', true),
    textDelta('gen_single', ' world'),
    finishChunk('gen_single'),
  ];
}

async function collect(stream: AsyncIterable<InferenceEvent>): Promise<InferenceEvent[]> {
  const events: InferenceEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

/** Step 1: the model calls the `search` tool; step 2: it answers with text. */
function toolCallChunk(id: string): unknown {
  return {
    id,
    choices: [
      {
        index: 0,
        delta: {
          role: 'assistant',
          tool_calls: [
            {
              index: 0,
              id: 'call-1',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"hushbox"}' },
            },
          ],
        },
      },
    ],
  };
}

function toolLoopResponses(): (() => Response)[] {
  return [
    () =>
      sseResponse([
        toolCallChunk('gen_step1'),
        finishChunk('gen_step1', {
          finishReason: 'tool_calls',
          usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.001 },
        }),
      ]),
    () =>
      sseResponse([
        textDelta('gen_step2', 'Found it', true),
        finishChunk('gen_step2', {
          usage: { prompt_tokens: 20, completion_tokens: 7, total_tokens: 27, cost: 0.002 },
        }),
      ]),
  ];
}

function searchToolRegistry(execute: (input: unknown) => Promise<unknown>): ToolSelection {
  return {
    search: {
      description: 'Search the web',
      inputSchema: z.object({ query: z.string() }),
      execute,
    },
  };
}

describe('buildToolset', () => {
  type ExecuteOptions = Parameters<NonNullable<ToolSet[string]['execute']>>[1];

  function sdkOptions(overrides: Partial<ExecuteOptions> = {}): ExecuteOptions {
    return { toolCallId: 'call-1', messages: [], context: undefined, ...overrides };
  }

  function builtExecute(
    toolset: ToolSet,
    name: string
  ): (input: unknown, options: ExecuteOptions) => Promise<unknown> {
    const execute = toolset[name]?.execute;
    if (execute === undefined) throw new Error(`the built ${name} tool has no execute`);
    return async (input, options) => (await execute(input, options)) as unknown;
  }

  it('builds every definition as a client tool whose execute reaches the definition', async () => {
    const execute = vi.fn((input: unknown) => Promise.resolve(input));
    const toolset = buildToolset(
      { search: { description: 'Search', inputSchema: z.object({ q: z.string() }), execute } },
      () => true
    );

    expect(toolset['search']?.type).toBeUndefined();
    await builtExecute(toolset, 'search')({ q: 'x' }, sdkOptions());
    expect(execute).toHaveBeenCalledWith({ q: 'x' }, expect.anything());
  });

  it('forwards the SDK abort signal to the definition execute', async () => {
    const seen: AbortSignal[] = [];
    const toolset = buildToolset(
      {
        search: {
          description: 'Search',
          inputSchema: z.object({ q: z.string() }),
          execute: (_input, { signal }) => {
            seen.push(signal);
            return Promise.resolve();
          },
        },
      },
      () => true
    );
    const controller = new AbortController();

    await builtExecute(toolset, 'search')(
      { q: 'x' },
      sdkOptions({ abortSignal: controller.signal })
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe(controller.signal);
  });

  it('refuses a call the budget does not admit without invoking the definition execute', async () => {
    const execute = vi.fn(() => Promise.resolve('ran'));
    const toolset = buildToolset(
      { search: { description: 'Search', inputSchema: z.object({}), execute } },
      (toolCallId) => toolCallId !== 'call-9'
    );

    await expect(
      builtExecute(toolset, 'search')({}, sdkOptions({ toolCallId: 'call-9' }))
    ).rejects.toMatchObject({ name: 'ToolCallLimitError' });
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('mapPart on the stream-part kinds that carry no InferenceEvent', () => {
  type MapPartState = Parameters<typeof mapPart>[1];

  function freshState(): MapPartState {
    return {
      sawText: false,
      sawMedia: false,
      toolErrorReason: undefined,
      invalidCallErrors: new Map(),
      finishPart: undefined,
      stepGenerationIds: [],
      totalCostUsd: 0,
      sawCost: false,
      step: -1,
      textIds: new Map(),
      reasoningIds: new Map(),
      fileIndex: 0,
    };
  }

  const usage: LanguageModelUsage = {
    inputTokens: 12,
    inputTokenDetails: {
      noCacheTokens: 12,
      cacheReadTokens: undefined,
      cacheWriteTokens: undefined,
    },
    outputTokens: 5,
    outputTokenDetails: { textTokens: 5, reasoningTokens: undefined },
    totalTokens: 17,
  };

  /** A turn's worth of parts the adapter does map, with a gap for the part under test. */
  function streamAround(...inserted: TextStreamPart<ToolSet>[]): TextStreamPart<ToolSet>[] {
    return [
      { type: 'start-step', request: {}, warnings: [] },
      { type: 'text-delta', id: 'text-0', text: 'Hello' },
      ...inserted,
      { type: 'reasoning-delta', id: 'reasoning-0', text: 'thinking' },
      { type: 'text-delta', id: 'text-1', text: ' world' },
      { type: 'finish', finishReason: 'stop', rawFinishReason: 'stop', totalUsage: usage },
    ];
  }

  /** No stream assembled here carries a `file` part, so reaching this is the test's own bug. */
  const refuseFileParts: FilePartMapper = () => {
    throw new Error('a stream in this suite carried a file part');
  };

  /** Both halves of the observable result: what was yielded, and what the run accumulated. */
  function run(parts: TextStreamPart<ToolSet>[]): {
    events: InferenceEvent[];
    state: MapPartState;
  } {
    const state = freshState();
    const events = parts.flatMap((part) => mapPart(part, state, refuseFileParts));
    return { events, state };
  }

  const reasoningFile = new DefaultGeneratedFile({
    data: new Uint8Array([0x68, 0x69]),
    mediaType: 'text/plain',
  });

  const toolCall: TypedToolCall<ToolSet> = {
    type: 'tool-call',
    toolCallId: 'call-1',
    toolName: 'search',
    input: { query: 'hushbox' },
    dynamic: true,
  };

  it('maps a tool-error that arrives after the run aborted to nothing, holding no reason', () => {
    const controller = new AbortController();
    controller.abort(new Error('run stopped'));
    const state = freshState();
    const events = mapPart(
      { type: 'tool-error', toolCallId: 'call-1', toolName: 'search', input: {}, error: 'x' },
      state,
      refuseFileParts,
      controller.signal
    );

    expect(events).toEqual([]);
    expect(state.toolErrorReason).toBeUndefined();
  });

  it('leaves the run unchanged when the stream carries a custom part', () => {
    expect(run(streamAround({ type: 'custom', kind: 'openrouter.note' }))).toEqual(
      run(streamAround())
    );
  });

  it('leaves the run unchanged when the stream carries a reasoning-file part', () => {
    expect(run(streamAround({ type: 'reasoning-file', file: reasoningFile }))).toEqual(
      run(streamAround())
    );
  });

  it('leaves the run unchanged when the stream carries a tool-approval-response part', () => {
    expect(
      run(
        streamAround({
          type: 'tool-approval-response',
          approvalId: 'approval-1',
          toolCall,
          approved: true,
        })
      )
    ).toEqual(run(streamAround()));
  });
});

describe('extractStepCost', () => {
  it('reads the inline openrouter.usage.cost', () => {
    expect(extractStepCost({ openrouter: { usage: { cost: 0.005 } } })).toBe(0.005);
  });

  it('returns undefined for undefined metadata', () => {
    expect(extractStepCost()).toBeUndefined();
  });

  it('returns undefined for null metadata', () => {
    expect(extractStepCost(null)).toBeUndefined();
  });

  it('returns undefined for non-object (unparseable) metadata', () => {
    expect(extractStepCost('nope')).toBeUndefined();
  });

  it('returns undefined when usage carries no cost', () => {
    expect(extractStepCost({ openrouter: { usage: { promptTokens: 1 } } })).toBeUndefined();
  });

  it('returns undefined when the openrouter namespace is absent', () => {
    expect(extractStepCost({ other: {} })).toBeUndefined();
  });
});

describe('createLanguageAdapter reasoning', () => {
  it('maps reasoning deltas to their own indexed event stream', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            {
              id: 'gen_r',
              provider: 'openai',
              choices: [{ index: 0, delta: { reasoning: 'thinking…' } }],
            },
            textDelta('gen_r', 'Answer'),
            finishChunk('gen_r'),
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('Think'), testDescriptor()));

    expect(events).toContainEqual({ kind: 'reasoning-delta', index: 0, content: 'thinking…' });
    expect(events).toContainEqual({ kind: 'text-delta', index: 0, content: 'Answer' });
  });
});

describe('createLanguageAdapter ZDR', () => {
  it('sends the ZDR routing block in the request body on every recorded request', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch(toolLoopResponses()),
      }),
    });

    await collect(
      adapter.infer(loopRequest('Find hushbox'), loopDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.resolve({ hits: 2 })),
          maxSteps: 2,
        },
      })
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(2);
    });

    for (const hash of store.list()) {
      const request = store.read(hash)?.request;
      expect(request?.pathAndQuery).toBe('/api/v1/chat/completions');
      const body = z
        .looseObject({
          provider: z.looseObject({
            zdr: z.boolean(),
            data_collection: z.string(),
            allow_fallbacks: z.boolean(),
          }),
          usage: z.looseObject({ include: z.boolean() }),
          transforms: z.array(z.unknown()),
        })
        .parse(JSON.parse(request?.body ?? '{}'));
      expect(body.provider.zdr).toBe(true);
      expect(body.provider.data_collection).toBe('deny');
      expect(body.provider.allow_fallbacks).toBe(false);
      expect(body.usage.include).toBe(true);
      expect(body.transforms).toEqual([]);
    }
  });
});

describe('createLanguageAdapter parameters', () => {
  it('wires maxOutputTokens onto the request body as max_tokens', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { maxOutputTokens: 64 } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ max_tokens: 64 });
  });

  it('wires temperature and topP onto the request body', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { temperature: 0.2, topP: 0.9 } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ temperature: 0.2, top_p: 0.9 });
  });

  it('wires an effort reasoning config onto the request body via providerOptions', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { reasoning: { effort: 'low' } } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ reasoning: { effort: 'low' } });
  });

  it('wires a token-budget reasoning config onto the request body via providerOptions', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { reasoning: { max_tokens: 2048 } } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ reasoning: { max_tokens: 2048 } });
  });

  it('sets provider.require_parameters iff the request carries reasoning', async () => {
    const bodyOf = async (parameters: Record<string, unknown>): Promise<unknown> => {
      const localRoot = mkdtempSync(path.join(tmpdir(), 'rp-'));
      try {
        const localStore = createCassetteStore({ rootDir: localRoot });
        const adapter = createLanguageAdapter({
          apiKey: 'test-key',
          fetch: createCassetteFetch({
            store: localStore,
            mode: 'record',
            realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
          }),
        });
        await collect(adapter.infer({ ...textRequest('Say hi'), parameters }, testDescriptor()));
        await vi.waitFor(() => {
          expect(localStore.list()).toHaveLength(1);
        });
        const hash = localStore.list()[0];
        return JSON.parse(localStore.read(hash ?? '')?.request?.body ?? '{}');
      } finally {
        rmSync(localRoot, { recursive: true, force: true });
      }
    };

    const withReasoning = z
      .looseObject({ provider: z.looseObject({ require_parameters: z.boolean().optional() }) })
      .parse(await bodyOf({ reasoning: { effort: 'high' } }));
    expect(withReasoning.provider.require_parameters).toBe(true);

    const withoutReasoning = z
      .looseObject({ provider: z.looseObject({ require_parameters: z.boolean().optional() }) })
      .parse(await bodyOf({}));
    expect(withoutReasoning.provider.require_parameters).toBeUndefined();

    // The hard-off shape IS a reasoning-carrying body — the routing
    // guard must fire for it too, so an endpoint that would silently ignore
    // `{ enabled: false }` (and reason anyway) is excluded.
    const withHardOff = z
      .looseObject({ provider: z.looseObject({ require_parameters: z.boolean().optional() }) })
      .parse(await bodyOf({ reasoning: { enabled: false } }));
    expect(withHardOff.provider.require_parameters).toBe(true);
  });

  it('rejects a reasoning config carrying both effort and max_tokens', async () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(
          { ...textRequest('Say hi'), parameters: { reasoning: { effort: 'low', max_tokens: 8 } } },
          testDescriptor()
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('passes a native effort word outside the canonical labels through to the body', async () => {
    // The positional ladder wires the model's NATIVE vocabulary (`xhigh`,
    // `minimal`, …) — the adapter must carry those words verbatim.
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { reasoning: { effort: 'xhigh' } } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ reasoning: { effort: 'xhigh' } });
  });

  it('wires the hard-off reasoning config onto the request body via providerOptions', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    await collect(
      adapter.infer(
        { ...textRequest('Say hi'), parameters: { reasoning: { enabled: false } } },
        testDescriptor()
      )
    );
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const hash = store.list()[0];
    const body: unknown = JSON.parse(store.read(hash ?? '')?.request?.body ?? '{}');
    expect(body).toMatchObject({ reasoning: { enabled: false } });
  });

  it('rejects an enabled-true reasoning config (only the off literal is a wire)', async () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(
          { ...textRequest('Say hi'), parameters: { reasoning: { enabled: true } } },
          testDescriptor()
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('rejects a parameter key the adapter cannot wire', async () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(
          { ...textRequest('Say hi'), parameters: { frobnicate: true } },
          testDescriptor()
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });
});

describe('createLanguageAdapter input validation', () => {
  it('rejects a media input part until the resolver seam exists', async () => {
    const request: InferenceRequest = {
      ...textRequest('Describe'),
      inputs: [
        { modality: 'image', ref: { ref: 'inputs/x/y', mimeType: 'image/png', byteLength: 3 } },
      ],
    };
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(collect(adapter.infer(request, testDescriptor()))).rejects.toMatchObject({
      name: 'InferenceError',
      code: 'invalid_request',
    });
  });

  it('rejects a request whose model differs from the descriptor', () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() =>
      adapter.infer({ ...textRequest('hi'), model: 'openai/other' }, testDescriptor())
    ).toThrow(expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' }));
  });

  it('refuses a ZDR-unreachable descriptor without calling the provider', () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    expect(() => adapter.infer(textRequest('hi'), testDescriptor({ zdrReachable: false }))).toThrow(
      expect.objectContaining({ name: 'InferenceError', code: 'invalid_request' })
    );
  });
});

describe('createLanguageAdapter construction', () => {
  it('constructs a production adapter without a custom fetch', () => {
    expectExposes(createLanguageAdapter({ apiKey: 'test-key' }), 'infer');
  });
});

describe('createLanguageAdapter stream edge cases', () => {
  it('skips empty text and reasoning deltas', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { id: 'gen_s', provider: 'openai', choices: [{ index: 0, delta: { reasoning: '' } }] },
            { id: 'gen_s', choices: [{ index: 0, delta: { content: '' } }] },
            textDelta('gen_s', 'real'),
            finishChunk('gen_s'),
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    const deltas = events.filter(
      (event) => event.kind === 'text-delta' || event.kind === 'reasoning-delta'
    );
    expect(deltas).toEqual([{ kind: 'text-delta', index: 0, content: 'real' }]);
  });

  it('defaults missing usage totals to zero', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([textDelta('gen_u', 'hi', true), finishChunk('gen_u', { usage: undefined })]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen_u',
        usage: { inputTokens: 0, outputTokens: 0 },
        finishReason: 'stop',
      },
    });
  });

  it('carries the authoritative inline cost on a single-step finish', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    const finish = events.at(-1);
    expect(finish?.kind).toBe('finish');
    expect(finish).toMatchObject({ metadata: { providerCostUsd: 0.12 } });
  });

  it('omits the cost when the provider returns none', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            textDelta('gen_nc', 'hi', true),
            finishChunk('gen_nc', {
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }),
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    const finish = events.at(-1);
    expect(finish?.kind).toBe('finish');
    expect(finish && 'metadata' in finish && 'providerCostUsd' in finish.metadata).toBe(false);
  });
});

describe('createLanguageAdapter tool loop', () => {
  it('runs the agentic loop with per-step generation ids and per-step costs', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch(toolLoopResponses()),
    });

    const events = await collect(
      adapter.infer(loopRequest('Find hushbox'), loopDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.resolve({ hits: 2 })),
          maxSteps: 2,
        },
      })
    );

    expect(events).toEqual([
      { kind: 'step-start', step: 0 },
      { kind: 'tool-call', id: 'call-1', name: 'search', args: { query: 'hushbox' } },
      { kind: 'tool-result', id: 'call-1', name: 'search', result: { hits: 2 } },
      {
        kind: 'step-finish',
        step: 0,
        generationId: 'gen_step1',
        providerCostUsd: 0.001,
        usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
      },
      { kind: 'step-start', step: 1 },
      { kind: 'text-delta', index: 0, content: 'Found it' },
      {
        kind: 'step-finish',
        step: 1,
        generationId: 'gen_step2',
        providerCostUsd: 0.002,
        usage: { inputTokens: 20, outputTokens: 7, reasoningTokens: 0, cachedInputTokens: 0 },
        servedBy: 'openai',
      },
      {
        kind: 'finish',
        metadata: {
          providerCostUsd: 0.003,
          usage: { inputTokens: 32, outputTokens: 12, reasoningTokens: 0, cachedInputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });

  it('recovers from a failed tool call when a later step produces text', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch(toolLoopResponses()),
    });

    const events = await collect(
      adapter.infer(loopRequest('Find hushbox'), loopDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.reject(new Error('search exploded'))),
          maxSteps: 2,
        },
      })
    );

    expect(events).toContainEqual({ kind: 'text-delta', index: 0, content: 'Found it' });
    expect(events.filter((event) => event.kind === 'tool-result')).toEqual([]);
  });

  it('names only the reason when a failed tool call leaves the turn empty', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_fail', [['call-0', 'search', '{"query":"marker-query"}']]),
        () => sseResponse([finishChunk('gen_empty')]),
      ]),
    });

    const consumed = collect(
      adapter.infer(loopRequest('Find hushbox'), loopDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.reject(new Error('marker-error-text'))),
          maxSteps: 2,
        },
      })
    );

    await expect(consumed).rejects.toMatchObject({
      name: 'InferenceError',
      code: 'upstream_error',
      message: expect.stringContaining('reason: failed') as string,
    });
    await expect(consumed).rejects.toSatisfy(
      (error: unknown) => error instanceof Error && !error.message.includes('marker')
    );
  });

  it('names only the reason when an invalid tool call leaves the turn empty', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_invalid', [['call-0', 'search', '{"marker-arguments":1}']]),
        () => sseResponse([finishChunk('gen_empty')]),
      ]),
    });

    const consumed = collect(
      adapter.infer(loopRequest('Find hushbox'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 2 },
      })
    );

    await expect(consumed).rejects.toMatchObject({
      name: 'InferenceError',
      code: 'upstream_error',
      message: expect.stringContaining('reason: invalid-input') as string,
    });
    await expect(consumed).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof Error &&
        !error.message.includes('marker') &&
        !error.message.includes('AI_')
    );
  });
});

/** What each tool-calling step below reports: its input tokens are the guard's starting point. */
const LOOP_STEP_PROMPT_TOKENS = 100;
const LOOP_STEP_USAGE = {
  prompt_tokens: LOOP_STEP_PROMPT_TOKENS,
  completion_tokens: 10,
  total_tokens: 110,
  cost: 0.001,
};

const LOOP_STEP_FINISH: FinishOptions = { finishReason: 'tool_calls', usage: LOOP_STEP_USAGE };

/** One model step that emits the given tool calls in parallel: `[id, toolName, argumentsJson]`. */
function parallelCallsResponse(
  generationId: string,
  calls: readonly (readonly [string, string, string])[],
  finish: FinishOptions = LOOP_STEP_FINISH
): () => Response {
  return () =>
    sseResponse([
      {
        id: generationId,
        provider: 'openai',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: calls.map(([id, name, args], index) => ({
                index,
                id,
                type: 'function',
                function: { name, arguments: args },
              })),
            },
          },
        ],
      },
      finishChunk(generationId, finish),
    ]);
}

function answerResponse(generationId: string, text: string): () => Response {
  return () =>
    sseResponse([
      textDelta(generationId, text, true),
      finishChunk(generationId, {
        usage: { prompt_tokens: 120, completion_tokens: 5, total_tokens: 125, cost: 0.001 },
      }),
    ]);
}

/** The ceiling and window every tool-loop request below runs under, far from binding. */
const LOOP_CEILING_TOKENS = 2000;
const LOOP_CONTEXT_TOKENS = 1_000_000;

function loopRequest(text: string): InferenceRequest {
  return { ...textRequest(text), parameters: { maxOutputTokens: LOOP_CEILING_TOKENS } };
}

function loopDescriptor(): ModelDescriptor {
  return testDescriptor({ limits: { contextLength: LOOP_CONTEXT_TOKENS } });
}

describe('createLanguageAdapter call budget', () => {
  it('maps a cap-refused tool call to a tool-error event with reason limit', async () => {
    const execute = vi.fn((input: unknown) => Promise.resolve({ echoed: input }));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_budget', [
          ['call-1', 'search', '{"query":"first"}'],
          ['call-2', 'search', '{"query":"second"}'],
        ]),
        answerResponse('gen_answer', 'Done'),
      ]),
    });

    const events = await collect(
      adapter.infer(loopRequest('Find twice'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(execute), maxSteps: 2 },
      })
    );

    expect(events).toContainEqual({
      kind: 'tool-error',
      id: 'call-2',
      name: 'search',
      reason: 'limit',
    });
  });
});

/** A scripted fetch that also keeps each request body it was sent, parsed. */
function capturingFetch(responses: (() => Response)[]): {
  readonly fetch: typeof globalThis.fetch;
  readonly bodies: WireBody[];
} {
  const bodies: WireBody[] = [];
  const scripted = scriptedFetch(responses);
  return {
    bodies,
    fetch: async (input, init) => {
      bodies.push(wireBodySchema.parse(JSON.parse(await new Request(input, init).text())));
      return scripted(input, init);
    },
  };
}

const wireBodySchema = z.looseObject({
  tools: z.array(z.looseObject({ function: z.looseObject({ name: z.string() }) })).optional(),
  max_tokens: z.number().optional(),
  messages: z.array(
    z.looseObject({
      role: z.string(),
      content: z.unknown(),
      tool_call_id: z.string().optional(),
      tool_calls: z.array(z.looseObject({ id: z.string() })).optional(),
    })
  ),
});

type WireBody = z.infer<typeof wireBodySchema>;

/** The ids of the tool calls a request re-sends, and of the tool results it carries. */
function resentToolCalls(body: WireBody | undefined): { calls: string[]; results: string[] } {
  const messages = body?.messages ?? [];
  return {
    calls: messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id)),
    results: messages.flatMap((message) =>
      message.role === 'tool' && message.tool_call_id !== undefined ? [message.tool_call_id] : []
    ),
  };
}

function toolResultTexts(body: WireBody | undefined): unknown[] {
  return (body?.messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content);
}

function namedTool(execute: (input: unknown) => Promise<unknown>): ToolDefinition {
  return { description: 'A tool', inputSchema: z.object({ query: z.string() }), execute };
}

describe('createLanguageAdapter call budget across tools', () => {
  it.each([
    { order: ['alpha', 'beta', 'beta'], refusedTool: 'beta' },
    { order: ['beta', 'alpha', 'alpha'], refusedTool: 'alpha' },
  ])(
    'refuses the call past the budget whichever tool it names ($order)',
    async ({ order, refusedTool }) => {
      const alpha = vi.fn(() => Promise.resolve('alpha ran'));
      const beta = vi.fn(() => Promise.resolve('beta ran'));
      const adapter = createLanguageAdapter({
        apiKey: 'test-key',
        fetch: scriptedFetch([
          parallelCallsResponse(
            'gen_mix',
            order.map((name, index) => [`call-${String(index)}`, name, '{"query":"q"}'] as const)
          ),
          answerResponse('gen_answer', 'Done'),
        ]),
      });

      const events = await collect(
        adapter.infer(loopRequest('Mix'), loopDescriptor(), {
          tools: { registry: { alpha: namedTool(alpha), beta: namedTool(beta) }, maxSteps: 3 },
        })
      );

      expect(events.filter((event) => event.kind === 'tool-error')).toEqual([
        { kind: 'tool-error', id: 'call-2', name: refusedTool, reason: 'limit' },
      ]);
      expect(alpha).toHaveBeenCalledTimes(1);
      expect(beta).toHaveBeenCalledTimes(1);
    }
  );

  it('counts an invalid call against the budget', async () => {
    const execute = vi.fn(() => Promise.resolve('ran'));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_invalid', [
          ['call-0', 'search', '{"nope":1}'],
          ['call-1', 'search', '{"query":"a"}'],
          ['call-2', 'search', '{"query":"b"}'],
        ]),
        answerResponse('gen_answer', 'Done'),
      ]),
    });

    const events = await collect(
      adapter.infer(loopRequest('Count'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(execute), maxSteps: 3 },
      })
    );

    expect(events).toContainEqual({
      kind: 'tool-error',
      id: 'call-2',
      name: 'search',
      reason: 'limit',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('counts a failed call against the budget of a later step', async () => {
    const execute = vi.fn((input: unknown) =>
      z.object({ query: z.string() }).parse(input).query === 'boom'
        ? Promise.reject(new Error('backend down'))
        : Promise.resolve('ran')
    );
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_fail', [['call-0', 'search', '{"query":"boom"}']]),
        parallelCallsResponse('gen_next', [
          ['call-1', 'search', '{"query":"a"}'],
          ['call-2', 'search', '{"query":"b"}'],
        ]),
        answerResponse('gen_answer', 'Done'),
      ]),
    });

    const events = await collect(
      adapter.infer(loopRequest('Retry'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(execute), maxSteps: 3 },
      })
    );

    expect(events).toContainEqual({
      kind: 'tool-error',
      id: 'call-2',
      name: 'search',
      reason: 'limit',
    });
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('createLanguageAdapter tool-free steps', () => {
  it('offers no tools on the final step the stop condition allows', async () => {
    const wire = capturingFetch([
      parallelCallsResponse('gen_call', [['call-0', 'search', '{"query":"a"}']]),
      answerResponse('gen_answer', 'Done'),
    ]);
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: wire.fetch });

    await collect(
      adapter.infer(loopRequest('Once'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 2 },
      })
    );

    expect(wire.bodies[0]?.tools?.map((entry) => entry.function.name)).toEqual(['search']);
    expect(wire.bodies[1]?.tools).toBeUndefined();
  });

  it('sends tools on every step of a three-step loop but the final one', async () => {
    const wire = capturingFetch([
      parallelCallsResponse('gen_first', [['call-0', 'search', '{"query":"a"}']]),
      parallelCallsResponse('gen_second', [['call-1', 'search', '{"query":"b"}']]),
      answerResponse('gen_answer', 'Done'),
    ]);
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: wire.fetch });

    await collect(
      adapter.infer(loopRequest('Twice'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 3 },
      })
    );

    expect(wire.bodies).toHaveLength(3);
    expect(wire.bodies[0]?.tools?.map((entry) => entry.function.name)).toEqual(['search']);
    expect(wire.bodies[1]?.tools?.map((entry) => entry.function.name)).toEqual(['search']);
    expect(wire.bodies[2]?.tools).toBeUndefined();
  });

  it('offers no tools on a first step that is the only step allowed', async () => {
    const wire = capturingFetch([answerResponse('gen_answer', 'Done')]);
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: wire.fetch });

    await collect(
      adapter.infer(loopRequest('Only'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 1 },
      })
    );

    expect(wire.bodies).toHaveLength(1);
    expect(wire.bodies[0]?.tools).toBeUndefined();
  });

  it('offers no tools on every step after the budget is spent', async () => {
    const wire = capturingFetch([
      parallelCallsResponse('gen_spend', [
        ['call-0', 'search', '{"query":"a"}'],
        ['call-1', 'search', '{"query":"b"}'],
        ['call-2', 'search', '{"query":"c"}'],
      ]),
      parallelCallsResponse('gen_stray', [['call-3', 'search', '{"query":"d"}']]),
      answerResponse('gen_answer', 'Done'),
    ]);
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: wire.fetch });

    await collect(
      adapter.infer(loopRequest('Spend'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 4 },
      })
    );

    expect(wire.bodies).toHaveLength(3);
    expect(wire.bodies[0]?.tools).toHaveLength(1);
    expect(wire.bodies[1]?.tools).toBeUndefined();
    expect(wire.bodies[2]?.tools).toBeUndefined();
  });
});

describe('createLanguageAdapter history rewrite', () => {
  it('drops the calls past the budget, and their results, from the next step', async () => {
    const wire = capturingFetch([
      parallelCallsResponse('gen_over', [
        ['call-0', 'search', '{"query":"a"}'],
        ['call-1', 'search', '{"query":"b"}'],
        ['call-2', 'search', '{"query":"c"}'],
      ]),
      answerResponse('gen_answer', 'Done'),
    ]);
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: wire.fetch });

    await collect(
      adapter.infer(loopRequest('Over'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 3 },
      })
    );

    expect(resentToolCalls(wire.bodies[1])).toEqual({
      calls: ['call-0', 'call-1'],
      results: ['call-0', 'call-1'],
    });
  });

  it('drops a step whose every call is past the budget', async () => {
    const wire = capturingFetch([
      parallelCallsResponse('gen_spend', [
        ['call-0', 'search', '{"query":"a"}'],
        ['call-1', 'search', '{"query":"b"}'],
      ]),
      parallelCallsResponse('gen_stray', [['call-2', 'search', '{"query":"c"}']]),
      answerResponse('gen_answer', 'Done'),
    ]);
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: wire.fetch });

    await collect(
      adapter.infer(loopRequest('Stray'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 3 },
      })
    );

    expect(wire.bodies).toHaveLength(3);
    expect(resentToolCalls(wire.bodies[2])).toEqual({
      calls: ['call-0', 'call-1'],
      results: ['call-0', 'call-1'],
    });
  });

  it('sends each error result as its reason code and no error text', async () => {
    const wire = capturingFetch([
      parallelCallsResponse('gen_errors', [
        ['call-0', 'search', '{"query":"marker-query-boom"}'],
        ['call-1', 'search', '{"marker-arguments":1}'],
        ['call-2', 'ghost', '{"query":"marker-query-ghost"}'],
      ]),
      answerResponse('gen_answer', 'Done'),
    ]);
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: wire.fetch });

    await collect(
      adapter.infer(loopRequest('Errors'), loopDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.reject(new Error('marker-error-text'))),
          maxSteps: 5,
        },
      })
    );

    expect(toolResultTexts(wire.bodies[1])).toEqual(['failed', 'invalid-input', 'invalid-input']);
    const resent = JSON.stringify(toolResultTexts(wire.bodies[1]));
    expect(resent).not.toContain('marker');
    expect(resent).not.toContain('AI_');
  });
});

describe('createLanguageAdapter tool-error events', () => {
  it('maps a call whose execute threw to a tool-error event with reason failed', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_fail', [['call-0', 'search', '{"query":"a"}']]),
        answerResponse('gen_answer', 'Done'),
      ]),
    });

    const events = await collect(
      adapter.infer(loopRequest('Fail'), loopDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.reject(new Error('backend down'))),
          maxSteps: 3,
        },
      })
    );

    expect(events).toContainEqual({
      kind: 'tool-error',
      id: 'call-0',
      name: 'search',
      reason: 'failed',
    });
  });

  it('emits no tool-result for a call whose execute threw', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_fail', [['call-0', 'search', '{"query":"a"}']]),
        answerResponse('gen_answer', 'Done'),
      ]),
    });

    const events = await collect(
      adapter.infer(loopRequest('Fail'), loopDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.reject(new Error('backend down'))),
          maxSteps: 3,
        },
      })
    );

    expect(events.filter((event) => event.kind === 'tool-result')).toEqual([]);
  });

  it.each([
    { label: 'arguments the schema rejects', name: 'search', args: '{"nope":1}' },
    { label: 'a tool the step does not offer', name: 'ghost', args: '{"query":"a"}' },
  ])('maps a call with $label to a tool-error event with reason invalid-input', async (call) => {
    const execute = vi.fn(() => Promise.resolve('ran'));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_invalid', [['call-0', call.name, call.args]]),
        answerResponse('gen_answer', 'Done'),
      ]),
    });

    const events = await collect(
      adapter.infer(loopRequest('Invalid'), loopDescriptor(), {
        tools: { registry: searchToolRegistry(execute), maxSteps: 3 },
      })
    );

    expect(events).toContainEqual({
      kind: 'tool-error',
      id: 'call-0',
      name: call.name,
      reason: 'invalid-input',
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it('emits no tool-error when the run aborts while a tool runs', async () => {
    const controller = new AbortController();
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        parallelCallsResponse('gen_abort', [['call-0', 'search', '{"query":"a"}']]),
      ]),
    });
    const events: InferenceEvent[] = [];
    const hanging = searchToolRegistry(
      () =>
        new Promise((_resolve, reject) => {
          controller.signal.addEventListener('abort', () => {
            reject(controller.signal.reason as Error);
          });
          controller.abort(new Error('run stopped'));
        })
    );

    const consumed = (async (): Promise<void> => {
      for await (const event of adapter.infer(loopRequest('Abort'), loopDescriptor(), {
        signal: controller.signal,
        tools: { registry: hanging, maxSteps: 3 },
      })) {
        events.push(event);
      }
    })();

    await expect(consumed).rejects.toMatchObject({ name: 'InferenceError', code: 'aborted' });
    expect(events.filter((event) => event.kind === 'tool-error')).toEqual([]);
  });
});

describe('createLanguageAdapter tool loop bounds', () => {
  it('refuses a tool loop whose model declares no context window, before any provider call', async () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(loopRequest('Unbounded'), testDescriptor(), {
          tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 3 },
        })
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });

  it('refuses a tool loop with no per-step output ceiling, before any provider call', async () => {
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: scriptedFetch([]) });

    await expect(
      collect(
        adapter.infer(textRequest('Unbounded'), loopDescriptor(), {
          tools: { registry: searchToolRegistry(() => Promise.resolve('ran')), maxSteps: 3 },
        })
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'invalid_request' });
  });
});

describe('createLanguageAdapter context-window guard', () => {
  /** A result with two-byte characters, so its UTF-8 length and its character count differ. */
  const GUARD_RESULT = { marker: 'résultat-ü' };

  function guardedRun(
    contextLength: number,
    steps: readonly (() => Response)[],
    maxSteps = 4
  ): { readonly consumed: Promise<InferenceEvent[]>; readonly bodies: WireBody[] } {
    const wire = capturingFetch([...steps]);
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: wire.fetch });
    const consumed = collect(
      adapter.infer(loopRequest('Guard'), testDescriptor({ limits: { contextLength } }), {
        tools: { registry: searchToolRegistry(() => Promise.resolve(GUARD_RESULT)), maxSteps },
      })
    );
    return { consumed, bodies: wire.bodies };
  }

  const oneCall = parallelCallsResponse('gen_call', [['call-0', 'search', '{"query":"a"}']]);
  const answer = answerResponse('gen_answer', 'Done');

  /**
   * What the step with `oneCall` appends to the next step's input, built here as
   * the SDK re-sends it: the assistant's tool call and the tool's result.
   */
  function appendedByOneCall(): unknown[] {
    const providerOptions = { openrouter: { reasoning_details: [] } };
    return [
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'call-0',
            toolName: 'search',
            input: { query: 'a' },
            providerOptions,
          },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'call-0',
            toolName: 'search',
            output: { type: 'json', value: GUARD_RESULT },
            providerOptions,
          },
        ],
      },
    ];
  }

  const appendedBytes = new TextEncoder().encode(JSON.stringify(appendedByOneCall())).byteLength;

  it('runs a step whose input would overrun the window tool-free, its ceiling lowered to the room left', async () => {
    const window = LOOP_STEP_PROMPT_TOKENS + LOOP_CEILING_TOKENS;
    const run = guardedRun(window, [oneCall, answer]);
    await run.consumed;

    expect(run.bodies[1]?.tools).toBeUndefined();
    expect(run.bodies[1]?.max_tokens).toBe(window - LOOP_STEP_PROMPT_TOKENS - appendedBytes);
  });

  it('keeps the full ceiling and the tools while the window has room', async () => {
    const run = guardedRun(LOOP_CONTEXT_TOKENS, [oneCall, answer]);
    await run.consumed;

    expect(run.bodies[1]?.max_tokens).toBe(LOOP_CEILING_TOKENS);
    expect(run.bodies[1]?.tools).toHaveLength(1);
  });

  it('fails with context_length when no room is left', async () => {
    const run = guardedRun(LOOP_STEP_PROMPT_TOKENS + appendedBytes, [oneCall, answer]);

    await expect(run.consumed).rejects.toMatchObject({
      name: 'InferenceError',
      code: 'context_length',
      message: 'The tool loop left too little of the context window for an answer',
    });
    expect(run.bodies).toHaveLength(1);
  });

  it('runs the smallest positive room tool-free at exactly that ceiling', async () => {
    const run = guardedRun(LOOP_STEP_PROMPT_TOKENS + appendedBytes + 1, [oneCall, answer]);
    await run.consumed;

    expect(run.bodies[1]?.tools).toBeUndefined();
    expect(run.bodies[1]?.max_tokens).toBe(1);
  });

  it('ends the loop after the step the guard made final', async () => {
    const stray = parallelCallsResponse('gen_stray', [['call-1', 'search', '{"query":"b"}']]);
    const run = guardedRun(
      LOOP_STEP_PROMPT_TOKENS + LOOP_CEILING_TOKENS,
      [oneCall, stray, answer],
      5
    );

    await expect(run.consumed).rejects.toMatchObject({ code: 'upstream_error' });
    expect(run.bodies).toHaveLength(2);
  });

  it('bounds the input by the whole request when the previous step reported no input tokens', async () => {
    const systemBytes = new TextEncoder().encode(
      buildTurnSystemPrompt({ utcDay: FIXTURE_UTC_DAY })
    ).byteLength;
    const unreported = parallelCallsResponse('gen_call', [['call-0', 'search', '{"query":"a"}']], {
      finishReason: 'tool_calls',
      usage: undefined,
    });
    const run = guardedRun(LOOP_CEILING_TOKENS + systemBytes, [unreported, answer]);
    await run.consumed;

    expect(run.bodies[1]?.tools).toBeUndefined();
    expect(run.bodies[1]?.max_tokens).toBeLessThan(LOOP_CEILING_TOKENS);
  });
});

describe('createLanguageAdapter failure shapes', () => {
  it('classifies the no_providers_available fixture as the typed ZDR fail-closed error', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.noProvidersAvailable),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'no_providers_available' }
    );
  });

  it('types the no-endpoints refusal distinctly when the request carries reasoning', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.noProvidersAvailable),
    });

    await expect(
      collect(
        adapter.infer(
          { ...textRequest('hi'), parameters: { reasoning: { effort: 'low' } } },
          testDescriptor()
        )
      )
    ).rejects.toMatchObject({ name: 'InferenceError', code: 'no_reasoning_endpoints' });
  });

  it('classifies the 429 fixture as rate_limited', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.rateLimited),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'rate_limited' }
    );
  });

  it('classifies the mid-stream error fixture as a typed upstream error', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.midStreamError),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'upstream_error' }
    );
  });
});

describe('createLanguageAdapter keep-alive comments', () => {
  it('skips OpenRouter keep-alive comment lines and emits the surrounding real events', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createFixtureFetch(FAILURE_FIXTURES.keepAliveComments),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    expect(events).toEqual([
      { kind: 'step-start', step: 0 },
      { kind: 'text-delta', index: 0, content: 'Hello' },
      { kind: 'text-delta', index: 0, content: ' world' },
      {
        kind: 'step-finish',
        step: 0,
        generationId: 'gen_ka',
        providerCostUsd: 0.12,
        usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
        servedBy: 'openai',
      },
      {
        kind: 'finish',
        metadata: {
          generationId: 'gen_ka',
          providerCostUsd: 0.12,
          usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});

describe('createLanguageAdapter abort', () => {
  it('aborts the underlying provider fetch when the signal fires', async () => {
    let fetchedSignal: AbortSignal | undefined;
    const hangingFetch: typeof globalThis.fetch = (input, init) => {
      const request = new Request(input, init);
      fetchedSignal = request.signal;
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    };
    const adapter = createLanguageAdapter({ apiKey: 'test-key', fetch: hangingFetch });
    const controller = new AbortController();

    const consumed = collect(
      adapter.infer(textRequest('Say hi'), testDescriptor(), { signal: controller.signal })
    );
    await vi.waitFor(() => {
      expect(fetchedSignal).toBeDefined();
    });
    controller.abort();

    await expect(consumed).rejects.toMatchObject({ name: 'InferenceError', code: 'aborted' });
    expect(fetchedSignal?.aborted).toBe(true);
  });
});

describe('createLanguageAdapter empty turns', () => {
  it('treats an empty length-finish as a billable truncation terminal event', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            finishChunk('gen_len', {
              finishReason: 'length',
              usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17, cost: 0.12 },
            }),
          ]),
      ]),
    });

    const events = await collect(adapter.infer(textRequest('hi'), testDescriptor()));

    expect(events.at(-1)).toEqual({
      kind: 'finish',
      metadata: {
        generationId: 'gen_len',
        providerCostUsd: 0.12,
        usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
        finishReason: 'length',
      },
    });
  });

  it('treats an empty stop-finish as an empty completion error', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse([finishChunk('gen_e')])]),
    });

    await expect(collect(adapter.infer(textRequest('hi'), testDescriptor()))).rejects.toMatchObject(
      { name: 'InferenceError', code: 'empty_completion' }
    );
  });
});

describe('createLanguageAdapter multi-output', () => {
  /** SYNTHETIC: a text+image model streaming an image part through the language shape. */
  function filePartChunks(): unknown[] {
    return [
      {
        id: 'gen_img',
        provider: 'google',
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              images: [
                {
                  type: 'image_url',
                  image_url: {
                    url: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64')}`,
                  },
                },
              ],
            },
          },
        ],
      },
      finishChunk('gen_img'),
    ];
  }

  it('maps a file part to media events through the injected mapper', async () => {
    const mapped: { part: FilePart; index: number }[] = [];
    const mediaValue: MediaValue = {
      ref: 'media/conv/msg/uuid-1',
      mimeType: 'image/png',
      modality: 'image',
      byteLength: 8,
      metadata: {},
    };
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(filePartChunks())]),
    });

    const events = await collect(
      adapter.infer(textRequest('Draw'), testDescriptor(), {
        mapFilePart: (part, index) => {
          mapped.push({ part, index });
          return [
            { kind: 'media-start', index, modality: 'image', mimeType: part.mediaType },
            { kind: 'media-done', index, value: mediaValue },
          ];
        },
      })
    );

    expect(mapped).toHaveLength(1);
    expect(mapped[0]?.part.mediaType).toBe('image/png');
    expect(events).toContainEqual({
      kind: 'media-start',
      index: 0,
      modality: 'image',
      mimeType: 'image/png',
    });
    expect(events).toContainEqual({ kind: 'media-done', index: 0, value: mediaValue });
    expect(events.at(-1)?.kind).toBe('finish');
  });

  it('propagates a file part without a mapper contract as a defect outside the typed channel', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([() => sseResponse(filePartChunks())]),
    });

    const consumed = collect(adapter.infer(textRequest('Draw'), testDescriptor()));

    await expect(consumed).rejects.toThrow(/mapFilePart/);
    await expect(consumed).rejects.toMatchObject({ name: 'AdapterDefect' });
  });
});

describe('createLanguageAdapter stream mapping', () => {
  it('maps a replayed single-step text stream to the exact typed event sequence', async () => {
    const recorder = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });
    await collect(recorder.infer(textRequest('Say hi'), testDescriptor()));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const replayer = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({ store, mode: 'replay-only' }),
    });
    const events = await collect(replayer.infer(textRequest('Say hi'), testDescriptor()));

    expect(events).toEqual([
      { kind: 'step-start', step: 0 },
      { kind: 'text-delta', index: 0, content: 'Hello' },
      { kind: 'text-delta', index: 0, content: ' world' },
      {
        kind: 'step-finish',
        step: 0,
        generationId: 'gen_single',
        providerCostUsd: 0.12,
        usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
        servedBy: 'openai',
      },
      {
        kind: 'finish',
        metadata: {
          generationId: 'gen_single',
          providerCostUsd: 0.12,
          usage: { inputTokens: 12, outputTokens: 5, reasoningTokens: 0, cachedInputTokens: 0 },
          finishReason: 'stop',
        },
      },
    ]);
  });
});

/** A step's text answer from the endpoint the gateway names on the stream's chunks. */
function servedTextChunks(
  id: string,
  servedBy: string | undefined,
  usage?: Record<string, number>
): unknown[] {
  return [
    {
      id,
      ...(servedBy === undefined ? {} : { provider: servedBy }),
      choices: [{ index: 0, delta: { role: 'assistant', content: 'Found it' } }],
    },
    finishChunk(id, { usage }),
  ];
}

function stepFinishesOf(events: readonly InferenceEvent[]): InferenceEvent[] {
  return events.filter((event) => event.kind === 'step-finish');
}

describe('createLanguageAdapter served endpoint and step usage', () => {
  const STEP_USAGE = { prompt_tokens: 150_000, completion_tokens: 500, total_tokens: 150_500 };

  it('names the endpoint the stream reports on the step it served', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () => sseResponse(servedTextChunks('gen_served', 'Amazon Bedrock', STEP_USAGE)),
      ]),
    });
    const events = await collect(adapter.infer(textRequest('Say hi'), testDescriptor()));

    expect(stepFinishesOf(events)).toMatchObject([{ servedBy: 'Amazon Bedrock' }]);
  });

  it('carries the usage of the finished step', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () => sseResponse(servedTextChunks('gen_served', 'Amazon Bedrock', STEP_USAGE)),
      ]),
    });
    const events = await collect(adapter.infer(textRequest('Say hi'), testDescriptor()));

    expect(stepFinishesOf(events)).toMatchObject([
      { usage: { inputTokens: 150_000, outputTokens: 500 } },
    ]);
  });

  it('names no endpoint on a step whose stream names none', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () => sseResponse(servedTextChunks('gen_unnamed', undefined, STEP_USAGE)),
      ]),
    });
    const events = await collect(adapter.infer(textRequest('Say hi'), testDescriptor()));

    expect(stepFinishesOf(events)[0]).not.toHaveProperty('servedBy');
  });

  it('carries no usage on a step whose stream reports none', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () => sseResponse(servedTextChunks('gen_uncounted', 'Amazon Bedrock')),
      ]),
    });
    const events = await collect(adapter.infer(textRequest('Say hi'), testDescriptor()));

    expect(stepFinishesOf(events)[0]).not.toHaveProperty('usage');
  });

  it('names each step of a tool loop by the endpoint that served it, in step order', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: scriptedFetch([
        () =>
          sseResponse([
            { ...(toolCallChunk('gen_step1') as object), provider: 'Google Vertex' },
            finishChunk('gen_step1', { finishReason: 'tool_calls', usage: STEP_USAGE }),
          ]),
        () => sseResponse(servedTextChunks('gen_step2', 'Amazon Bedrock', STEP_USAGE)),
      ]),
    });
    const events = await collect(
      adapter.infer(loopRequest('Find hushbox'), loopDescriptor(), {
        tools: {
          registry: searchToolRegistry(() => Promise.resolve({ hits: 2 })),
          maxSteps: 2,
        },
      })
    );

    expect(stepFinishesOf(events)).toMatchObject([
      { servedBy: 'Google Vertex' },
      { servedBy: 'Amazon Bedrock' },
    ]);
  });
});

describe('recorded provider cost', () => {
  it('reads back out of the recording the same cost the adapter billed', async () => {
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: createCassetteFetch({
        store,
        mode: 'record',
        realFetch: scriptedFetch([() => sseResponse(simpleTextChunks())]),
      }),
    });

    const events = await collect(adapter.infer(textRequest('Say hi'), testDescriptor()));
    await vi.waitFor(() => {
      expect(store.list()).toHaveLength(1);
    });

    const finish = events.at(-1);
    if (finish?.kind !== 'finish') throw new Error('expected a terminal finish event');
    const recorded = await recordedStreamCostUsd(store, 'gen_single');

    expect(recorded).toBe(0.12);
    expect(finish.metadata.providerCostUsd).toBe(recorded);
  });
});

describe('wire message assembly (system + history)', () => {
  const HISTORY = [
    { role: 'user' as const, content: 'first question' },
    { role: 'assistant' as const, content: 'first answer' },
  ];

  const BASE_SYSTEM = buildTurnSystemPrompt({ utcDay: FIXTURE_UTC_DAY });

  // The SDK serializes the top-level `system` prompt as a text-part array,
  // while string message content stays a bare string.
  const systemMessage = (content: string): unknown => ({
    role: 'system',
    content: [{ type: 'text', text: content }],
  });

  interface CapturedCall {
    readonly request: () => Request;
    readonly fetch: typeof globalThis.fetch;
  }

  /** Captures the SDK's outgoing Request while serving one scripted response. */
  function captureFetch(response: () => Response): CapturedCall {
    let captured: Request | undefined;
    return {
      request: () => {
        if (captured === undefined) throw new Error('no request captured');
        return captured;
      },
      fetch: (input, init) => {
        captured = new Request(input, init);
        return Promise.resolve(response());
      },
    };
  }

  /** The serialized body the SDK handed the injected fetch, raw and parsed. */
  async function wireCall(
    request: InferenceRequest
  ): Promise<{ readonly text: string; readonly messages: unknown }> {
    const call = captureFetch(() => sseResponse(simpleTextChunks()));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: call.fetch,
    });
    await collect(adapter.infer(request, testDescriptor()));
    const text = await call.request().clone().text();
    const body = JSON.parse(text) as { messages: unknown };
    return { text, messages: body.messages };
  }

  async function wireMessages(request: InferenceRequest): Promise<unknown> {
    const wired = await wireCall(request);
    return wired.messages;
  }

  it('leads every turn with the base system prompt as a system message', async () => {
    const messages = await wireMessages(textRequest('and now?'));
    expect(messages).toEqual([systemMessage(BASE_SYSTEM), { role: 'user', content: 'and now?' }]);
  });

  it('sends no system message at all on a routing-only call', async () => {
    // The classifier's reserve prices its truncated context and the classifier
    // template — the base preamble is neither, so a call that carried it would
    // bill input no reservation covered. Measured at 1,739 characters against a
    // 4,708-character reserve basis whose worst-case emitted input already uses
    // all but 317 of it, so the preamble alone would overrun the headroom.
    const messages = await wireMessages({ ...textRequest('and now?'), routingOnly: true });
    expect(messages).toEqual([{ role: 'user', content: 'and now?' }]);
  });

  it('orders messages system → history → current user', async () => {
    const messages = await wireMessages({ ...textRequest('and now?'), history: HISTORY });
    expect(messages).toEqual([
      systemMessage(BASE_SYSTEM),
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'and now?' },
    ]);
  });

  it('folds client custom instructions into the leading system message', async () => {
    const { messages, text } = await wireCall({
      ...textRequest('and now?'),
      customInstructions: 'Answer only in French.',
    });
    expect(messages).toEqual([
      systemMessage(
        buildTurnSystemPrompt({
          utcDay: FIXTURE_UTC_DAY,
          customInstructions: 'Answer only in French.',
        })
      ),
      { role: 'user', content: 'and now?' },
    ]);
    // The equality compares the wire against the builder's own output, so it moves
    // with the builder; the raw bytes are what catch a builder that stops emitting.
    expect(text).toContain('Answer only in French.');
  });

  it('is byte-identical to the pre-system wire EXCEPT the added base system message', async () => {
    // With no custom instructions, the ONLY delta versus the history-era
    // adapter is the prepended base system message: history + current turn are
    // untouched, so stripping the leading system entry recovers the old shape.
    const withHistory = (await wireMessages({
      ...textRequest('and now?'),
      history: HISTORY,
    })) as unknown[];
    expect(withHistory[0]).toEqual(systemMessage(BASE_SYSTEM));
    expect(withHistory.slice(1)).toEqual([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'and now?' },
    ]);
  });

  it('preview measurement equals the length of the prompt the adapter sends (system + instructions + history + input)', async () => {
    // The parity the client composer relies on: the shared counter over the
    // shared builder's output measures EXACTLY the text the wire request
    // carries — system prompt (base + custom instructions), resent history,
    // and the current input, with no separators or extra framing. All-ASCII
    // fixtures so the UTF-16 code-unit count the counter uses is also the
    // UTF-8 byte length of the user-controlled text.
    const instructions = 'Answer only in French.';
    const prompt = 'and now?';
    const call = captureFetch(() => sseResponse(simpleTextChunks()));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: call.fetch,
    });
    await collect(
      adapter.infer(
        { ...textRequest(prompt), history: HISTORY, customInstructions: instructions },
        testDescriptor()
      )
    );
    const body: { messages: { content: string | { text: string }[] }[] } = await call
      .request()
      .clone()
      .json();
    const sentText = body.messages
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.text).join('')
      )
      .join('');

    const measured = promptCharacterCount({
      systemPrompt: buildTurnSystemPrompt({
        utcDay: FIXTURE_UTC_DAY,
        customInstructions: instructions,
      }),
      historyCharacters: historyCharacterCount(HISTORY),
      prompt,
    });
    expect(measured).toBe(sentText.length);
  });

  it('sends a reasoning-bearing history verbatim, so the measurement still matches', async () => {
    // The adapter transforms nothing: whatever history it is handed is exactly
    // what the provider receives, embedded reasoning included. That is what
    // makes the route's own strip the single seam deciding those bytes — the
    // count taken there is the count that reaches the wire.
    const prompt = 'and now?';
    const replayedAssistantTurn = serializeSegments([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'thoughts' }] },
      { kind: 'text', text: 'first answer' },
    ]);
    const history = [
      { role: 'user' as const, content: 'first question' },
      { role: 'assistant' as const, content: replayedAssistantTurn },
    ];
    const call = captureFetch(() => sseResponse(simpleTextChunks()));
    await collect(
      createLanguageAdapter({ apiKey: 'test-key', fetch: call.fetch }).infer(
        { ...textRequest(prompt), history },
        testDescriptor()
      )
    );
    const body: { messages: { content: string | { text: string }[] }[] } = await call
      .request()
      .clone()
      .json();
    const sentText = body.messages
      .map((message) =>
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part) => part.text).join('')
      )
      .join('');
    expect(sentText).toContain(replayedAssistantTurn);
    expect(sentText.length).toBe(
      promptCharacterCount({
        systemPrompt: BASE_SYSTEM,
        historyCharacters: historyCharacterCount(history),
        prompt,
      })
    );
  });

  it('hashes an empty history identically to an absent one (no spurious cassette miss)', async () => {
    const fixture = 'What is the capital of France?';
    const absent = captureFetch(() => sseResponse(simpleTextChunks()));
    await collect(
      createLanguageAdapter({ apiKey: 'test-key', fetch: absent.fetch }).infer(
        textRequest(fixture),
        testDescriptor()
      )
    );
    const empty = captureFetch(() => sseResponse(simpleTextChunks()));
    await collect(
      createLanguageAdapter({ apiKey: 'test-key', fetch: empty.fetch }).infer(
        { ...textRequest(fixture), history: [] },
        testDescriptor()
      )
    );
    expect(descriptorHash(await requestToDescriptor(empty.request()))).toBe(
      descriptorHash(await requestToDescriptor(absent.request()))
    );
  });

  it('hashes one request identically either side of a UTC day boundary', async () => {
    // The cassette key is a hash of the bytes actually sent, so anything on the
    // request path that reads a wall clock orphans every recording at UTC
    // midnight and charges a fresh set of real calls on the next CI run.
    const request = textRequest('What is the capital of France?');
    freezeClock(TEST_DAY_END, { toFake: ['Date'] });
    const lateInDay = captureFetch(() => sseResponse(simpleTextChunks()));
    await collect(
      createModelProvider({ apiKey: 'test-key', fetch: lateInDay.fetch }).infer(
        request,
        testDescriptor()
      )
    );
    setClock(TEST_DAY_END + 1);
    const nextDay = captureFetch(() => sseResponse(simpleTextChunks()));
    await collect(
      createModelProvider({ apiKey: 'test-key', fetch: nextDay.fetch }).infer(
        request,
        testDescriptor()
      )
    );
    expect(descriptorHash(await requestToDescriptor(nextDay.request()))).toBe(
      descriptorHash(await requestToDescriptor(lateInDay.request()))
    );
  });

  it('pins the canonical request shape with the base system prompt', async () => {
    // The canonical hash of a request shape invented HERE, not a lookup key for
    // any request CI records — those are built in `integration.setup.ts`. It
    // makes a change in what we send a deliberate edit: the literal moves
    // whenever the request shape does, most often the system prompt text.
    const call = captureFetch(() => sseResponse(simpleTextChunks()));
    const adapter = createLanguageAdapter({
      apiKey: 'test-key',
      fetch: call.fetch,
    });
    await collect(adapter.infer(textRequest('What is the capital of France?'), testDescriptor()));
    expect(descriptorHash(await requestToDescriptor(call.request()))).toBe('123bf1df5aa5f164');
  });
});
