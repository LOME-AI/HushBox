import {
  CHARS_PER_TOKEN_STANDARD,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  assertNever,
} from '@hushbox/shared';
import { fetchModels, getSupportedVideoDurations } from '@hushbox/shared/models';

import { rawModelToModelInfo } from './model-mapping.js';
import { buildModelViewsForModality, type ModelViewFor } from './model-view.js';
import {
  TEST_IMAGE_BYTES,
  TEST_AUDIO_BYTES,
  TEST_VIDEO_BYTES,
  TEST_IMAGE_MIME,
  TEST_AUDIO_MIME,
  TEST_VIDEO_MIME,
  TEST_IMAGE_WIDTH,
  TEST_IMAGE_HEIGHT,
  TEST_AUDIO_DURATION_MS,
  TEST_VIDEO_DURATION_MS,
  TEST_VIDEO_WIDTH,
  TEST_VIDEO_HEIGHT,
} from './mock-fixtures/index.js';
import type { RawModel } from '@hushbox/shared/models';
import type {
  AIMessage,
  InferenceEvent,
  InferenceRequest,
  InferenceStream,
  MessageContentPart,
  Modality,
  MockAIClient,
  MockAIClientConfig,
  ModelInfo,
  RecordedInferenceRequest,
  TextRequest,
  VideoRequest,
} from './types.js';

/**
 * Default public `/v1/models` URL the mock client passes to `fetchModels`.
 * Tests that stub `globalThis.fetch` ignore the value; tests that don't stub
 * fetch will hit the real endpoint. Same URL production uses, so the catalog
 * is identical across mock and real clients.
 */
const DEFAULT_PUBLIC_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

/**
 * Default model id returned by classifier calls — overridable per test.
 *
 * Must be a cheap text model so it lands in the integration harness's top-N
 * eligible set (`buildHarness` sorts by cost). claude-haiku-4.5 is one of the
 * cheapest entries in the catalog below.
 */
const DEFAULT_CLASSIFIER_RESOLUTION = 'anthropic/claude-haiku-4.5';

/**
 * Default delay before the first classifier event so the pre-inference
 * stage's `stage:start` and `stage:done` events land in separate render
 * ticks; without it the loading indicator never paints. Explicit `0`
 * opts out for unit tests that care about microsecond timing.
 */
const DEFAULT_CLASSIFIER_DELAY_MS = 1000;

export {
  TEST_IMAGE_BYTES as CANNED_IMAGE,
  TEST_VIDEO_BYTES as CANNED_VIDEO,
  TEST_AUDIO_BYTES as CANNED_AUDIO,
  TEST_IMAGE_WIDTH as CANNED_IMAGE_WIDTH,
  TEST_IMAGE_HEIGHT as CANNED_IMAGE_HEIGHT,
  TEST_VIDEO_DURATION_MS as CANNED_VIDEO_DURATION_MS,
  TEST_VIDEO_WIDTH as CANNED_VIDEO_WIDTH,
  TEST_VIDEO_HEIGHT as CANNED_VIDEO_HEIGHT,
  TEST_AUDIO_DURATION_MS as CANNED_AUDIO_DURATION_MS,
} from './mock-fixtures/index.js';

/**
 * Per-generation accounting the mock remembers so {@link getGenerationStats}
 * can reproduce the cost the gateway would have charged. Recorded at the
 * moment a stream yields its `finish` event.
 */
interface MockGenerationRecord {
  modelId: string;
  inputTokens: number;
  outputTokens: number;
}

/** Mint a generation id and register its accounting in one call. */
type MintGenerationId = (record: MockGenerationRecord) => string;

/**
 * Module-level so generationIds minted by ANY mock instance resolve correctly
 * from ANY mock instance's `getGenerationStats`. Several integration tests
 * (see e.g. smart-model.integration.test.ts) build a second mock client for
 * stream config purposes while a parent mock handles billing — without a
 * shared registry, those crossing-instances lookups fail loudly even though
 * the test logic is correct. Ids embed `Date.now()` + a monotonic sequence
 * so cross-test collisions are impossible.
 */
const generationRegistry = new Map<string, MockGenerationRecord>();
let generationSeq = 0;
function mintGenerationId(record: MockGenerationRecord): string {
  generationSeq += 1;
  const id = `mock-gen-${String(Date.now())}-${String(generationSeq)}`;
  generationRegistry.set(id, record);
  return id;
}

function extractLastUserContent(messages: AIMessage[]): string {
  const lastUser = messages.findLast((m) => m.role === 'user');
  if (!lastUser) return 'No message';
  return typeof lastUser.content === 'string'
    ? lastUser.content
    : lastUser.content
        .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
        .map((p) => p.text)
        .join('');
}

/** Wrap a sync generator into an InferenceStream (AsyncIterator). */
function syncStream(generate: () => Generator<InferenceEvent>): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      const iterator = generate();
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          return Promise.resolve(iterator.next());
        },
      };
    },
  };
}

function messageContentLength(content: string | MessageContentPart[]): number {
  if (typeof content === 'string') return content.length;
  let length = 0;
  for (const part of content) {
    if (part.type === 'text') length += part.text.length;
  }
  return length;
}

function countPromptCharacters(messages: AIMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += messageContentLength(message.content);
  }
  return total;
}

function isClassifierRequest(request: TextRequest): boolean {
  const system = request.messages.find((m) => m.role === 'system');
  if (!system) return false;
  const content = typeof system.content === 'string' ? system.content : '';
  return content.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER);
}

function createClassifierStream(
  resolvedModelId: string,
  delayMs: number,
  classifierModel: string,
  mint: MintGenerationId
): InferenceStream {
  const events: InferenceEvent[] = [];
  for (const char of resolvedModelId) {
    events.push({ kind: 'text-delta', content: char });
  }
  const inputTokens = Math.ceil(resolvedModelId.length / CHARS_PER_TOKEN_STANDARD);
  const outputTokens = Math.ceil(resolvedModelId.length / CHARS_PER_TOKEN_STANDARD);
  events.push({
    kind: 'finish',
    providerMetadata: {
      generationId: mint({ modelId: classifierModel, inputTokens, outputTokens }),
      usage: { inputTokens, outputTokens },
    },
  });
  return delayedEventStream(events, delayMs);
}

function createFailingClassifierStream(error: Error, delayMs: number): InferenceStream {
  const gate = createFirstCallDelay(delayMs);
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      return {
        async next(): Promise<IteratorResult<InferenceEvent>> {
          await gate();
          throw error;
        },
      };
    },
  };
}

/**
 * Yield a pre-built event list one at a time, awaiting `delayMs` before the
 * first yield. Used by the classifier stream so the "Choosing the best
 * model…" indicator is observable in tests — without a delay the
 * `stage:start` → `stage:done` round-trip completes on the microtask queue
 * faster than Playwright's polling window.
 */
function delayedEventStream(events: readonly InferenceEvent[], delayMs: number): InferenceStream {
  const gate = createFirstCallDelay(delayMs);
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      let index = 0;
      return {
        async next(): Promise<IteratorResult<InferenceEvent>> {
          await gate();
          const event = events[index];
          if (event === undefined) {
            return { value: undefined, done: true };
          }
          index++;
          return { value: event, done: false };
        },
      };
    },
  };
}

/**
 * Returns a function that resolves after `delayMs` the first time it's called
 * and immediately on subsequent calls. `delayMs <= 0` returns a no-op gate.
 * Shared by mock streams that need to slow down their first event without
 * delaying every subsequent yield.
 */
function createFirstCallDelay(delayMs: number): () => Promise<void> {
  if (delayMs <= 0) return () => Promise.resolve();
  let pending = true;
  return () => {
    if (!pending) return Promise.resolve();
    pending = false;
    return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  };
}

function createTextStream(request: TextRequest, mint: MintGenerationId): InferenceStream {
  // Emit a response that exercises both edge cases that broke production:
  // (a) embedded newlines in streamed content (the SSE multi-line data: path)
  // (b) a fenced code block containing `{`/`}` braces (the streamdown
  //     incomplete-markdown parsing path)
  // Existing tests substring-match on "Echo:" so the prefix is preserved.
  const echoContent =
    `Echo:\n${extractLastUserContent(request.messages)}\n\n` + '```json\n{\n  "ok": true\n}\n```';

  return syncStream(function* (): Generator<InferenceEvent> {
    for (const char of echoContent) {
      yield { kind: 'text-delta', content: char };
    }

    const promptCharacters = countPromptCharacters(request.messages);
    const inputTokens = Math.ceil(promptCharacters / CHARS_PER_TOKEN_STANDARD);
    const outputTokens = Math.ceil(echoContent.length / CHARS_PER_TOKEN_STANDARD);

    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: mint({ modelId: request.model, inputTokens, outputTokens }),
        usage: { inputTokens, outputTokens },
      },
    };
  });
}

function createImageStream(): InferenceStream {
  return syncStream(function* (): Generator<InferenceEvent> {
    yield { kind: 'media-start', mediaType: 'image', mimeType: TEST_IMAGE_MIME };
    yield {
      kind: 'media-done',
      bytes: TEST_IMAGE_BYTES,
      mimeType: TEST_IMAGE_MIME,
      width: TEST_IMAGE_WIDTH,
      height: TEST_IMAGE_HEIGHT,
    };
    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-gen-${String(Date.now())}`,
      },
    };
  });
}

/**
 * Build an `InferenceStream` whose first `next()` rejects with `error`.
 * Mirrors the real Gateway's video-rejection path, which throws a raw
 * provider Error on the consumer's iteration rather than emitting a
 * structured event. Lets the stream-pipeline surface the error verbatim
 * the same way it does in production.
 */
function rejectingStream(error: Error): InferenceStream {
  return {
    [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
      return {
        next(): Promise<IteratorResult<InferenceEvent>> {
          return Promise.reject(error);
        },
      };
    },
  };
}

function createVideoStream(request: VideoRequest): InferenceStream {
  const requested = request.durationSeconds;
  if (requested !== undefined) {
    const supported = getSupportedVideoDurations(request.model);
    if (supported !== undefined && !supported.includes(requested)) {
      // Veo's wire response is the exact byte string below — keep the mock
      // symmetric so E2E tests fail on the same message production users see.
      return rejectingStream(
        new Error(
          `Video generation failed: Unsupported output video duration ${String(requested)} seconds, supported durations are [${supported.join(',')}] for feature text_to_video.`
        )
      );
    }
  }

  return syncStream(function* (): Generator<InferenceEvent> {
    yield { kind: 'media-start', mediaType: 'video', mimeType: TEST_VIDEO_MIME };
    yield {
      kind: 'media-done',
      bytes: TEST_VIDEO_BYTES,
      mimeType: TEST_VIDEO_MIME,
      width: TEST_VIDEO_WIDTH,
      height: TEST_VIDEO_HEIGHT,
      durationMs: TEST_VIDEO_DURATION_MS,
    };
    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-gen-${String(Date.now())}`,
      },
    };
  });
}

function createAudioStream(): InferenceStream {
  return syncStream(function* (): Generator<InferenceEvent> {
    yield { kind: 'media-start', mediaType: 'audio', mimeType: TEST_AUDIO_MIME };
    yield {
      kind: 'media-done',
      bytes: TEST_AUDIO_BYTES,
      mimeType: TEST_AUDIO_MIME,
      durationMs: TEST_AUDIO_DURATION_MS,
    };
    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-gen-${String(Date.now())}`,
      },
    };
  });
}

export function createMockAIClient(config: MockAIClientConfig = {}): MockAIClient {
  const history: RecordedInferenceRequest[] = [];
  const failingModels = new Set(config.failingModels);
  const classifierResolution = config.classifierResolution ?? DEFAULT_CLASSIFIER_RESOLUTION;
  const classifierFailure =
    config.classifierFailure === true ? new Error('Classifier unavailable (test)') : null;
  const classifierDelayMs = Math.max(0, config.classifierDelayMs ?? DEFAULT_CLASSIFIER_DELAY_MS);

  const publicModelsUrl = config.publicModelsUrl ?? DEFAULT_PUBLIC_MODELS_URL;

  // Bind the module-level minter so each closure has a stable reference.
  const mint: MintGenerationId = mintGenerationId;

  return {
    isMock: true,

    async listRawModels(): Promise<RawModel[]> {
      const models = await fetchModels({ publicModelsUrl });
      return models.map((m) => structuredClone(m));
    },

    async listModels(): Promise<ModelInfo[]> {
      const raw = await this.listRawModels();
      return raw.map((m) => rawModelToModelInfo(m));
    },

    async listModelsForModality<M extends Modality>(
      modality: M
    ): Promise<readonly ModelViewFor<M>[]> {
      const raw = await this.listRawModels();
      return buildModelViewsForModality(raw, modality);
    },

    async getModel(id: string): Promise<ModelInfo> {
      const models = await this.listModels();
      const model = models.find((m) => m.id === id);
      if (!model) throw new Error(`Model not found: ${id}`);
      return model;
    },

    stream(request: InferenceRequest): InferenceStream {
      if (failingModels.has(request.model)) {
        const errorMessage = `Model ${request.model} is unavailable`;
        return {
          [Symbol.asyncIterator](): AsyncIterator<InferenceEvent> {
            return {
              next(): Promise<IteratorResult<InferenceEvent>> {
                return Promise.reject(new Error(errorMessage));
              },
            };
          },
        };
      }

      // The mock never reaches a real gateway, so ZDR is moot in practice;
      // we tag every recorded request with `zdrEnforced: true` so test
      // assertions can detect a future regression on the real-client path
      // (where ZDR_PROVIDER_OPTIONS must be set on EVERY SDK call).
      const recorded: RecordedInferenceRequest = {
        ...structuredClone(request),
        zdrEnforced: true,
      };
      history.push(recorded);

      switch (request.modality) {
        case 'text': {
          if (isClassifierRequest(request)) {
            if (classifierFailure !== null) {
              return createFailingClassifierStream(classifierFailure, classifierDelayMs);
            }
            return createClassifierStream(
              classifierResolution,
              classifierDelayMs,
              request.model,
              mint
            );
          }
          return createTextStream(request, mint);
        }
        case 'image': {
          return createImageStream();
        }
        case 'video': {
          return createVideoStream(request);
        }
        case 'audio': {
          return createAudioStream();
        }
        default: {
          return assertNever(request);
        }
      }
    },

    /**
     * Returns the gateway-equivalent cost for a generationId minted by this
     * mock's text or classifier stream. Reads the model's REAL per-token
     * pricing from the catalog and multiplies by recorded token counts —
     * mirrors production semantics so per-model cost differences flow into
     * billing assertions instead of being masked by a flat constant.
     *
     * Fast-fails loudly on:
     *   - unknown generationId (never minted by this mock instance)
     *   - model id missing from the catalog
     *   - catalog pricing fields missing or non-positive
     * The whole point is to surface mock/catalog drift instead of silently
     * defaulting to a placeholder cost.
     */
    async getGenerationStats(generationId: string): Promise<{ costUsd: number }> {
      const record = generationRegistry.get(generationId);
      if (!record) {
        throw new Error(
          `Unknown mock generationId: ${generationId} (no record in this mock instance — ` +
            `did you cross client instances, or call getGenerationStats with a forged id?)`
        );
      }
      const model = await this.getModel(record.modelId);
      if (model.pricing.kind !== 'token') {
        throw new Error(
          `Mock cost lookup: model ${record.modelId} has non-token pricing kind ` +
            `(${model.pricing.kind}); getGenerationStats is only valid for text generations`
        );
      }
      const { inputPerToken, outputPerToken } = model.pricing;
      if (inputPerToken <= 0 || outputPerToken <= 0) {
        throw new Error(
          `Mock cost lookup: model ${record.modelId} has no usable per-token pricing ` +
            `(inputPerToken=${String(inputPerToken)}, outputPerToken=${String(outputPerToken)})`
        );
      }
      const costUsd = record.inputTokens * inputPerToken + record.outputTokens * outputPerToken;
      return { costUsd };
    },

    getRequestHistory(): RecordedInferenceRequest[] {
      return [...history];
    },

    clearHistory(): void {
      history.length = 0;
    },
  };
}
