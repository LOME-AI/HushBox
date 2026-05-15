import {
  CHARS_PER_TOKEN_STANDARD,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  assertNever,
} from '@hushbox/shared';
import { fetchModels } from '@hushbox/shared/models';

import { rawModelToModelInfo } from './model-mapping.js';
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
  MockAIClient,
  MockAIClientConfig,
  ModelInfo,
  RecordedInferenceRequest,
  TextRequest,
} from './types.js';

/**
 * Default public `/v1/models` URL the mock client passes to `fetchModels`.
 * Tests that stub `globalThis.fetch` ignore the value; tests that don't stub
 * fetch will hit the real endpoint. Same URL production uses, so the catalog
 * is identical across mock and real clients.
 */
const DEFAULT_PUBLIC_MODELS_URL = 'https://ai-gateway.vercel.sh/v1/models';

/** Deterministic mock cost returned by getGenerationStats (USD). */
const MOCK_GENERATION_STATS_COST = 0.001;

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
const DEFAULT_CLASSIFIER_DELAY_MS = 500;

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

function createClassifierStream(modelId: string, delayMs: number): InferenceStream {
  const events: InferenceEvent[] = [];
  for (const char of modelId) {
    events.push({ kind: 'text-delta', content: char });
  }
  events.push({
    kind: 'finish',
    providerMetadata: {
      generationId: `mock-classifier-${String(Date.now())}`,
      usage: {
        inputTokens: Math.ceil(modelId.length / CHARS_PER_TOKEN_STANDARD),
        outputTokens: Math.ceil(modelId.length / CHARS_PER_TOKEN_STANDARD),
      },
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

function createTextStream(request: TextRequest): InferenceStream {
  const echoContent = `Echo:\n${extractLastUserContent(request.messages)}`;

  return syncStream(function* (): Generator<InferenceEvent> {
    for (const char of echoContent) {
      yield { kind: 'text-delta', content: char };
    }

    const promptCharacters = countPromptCharacters(request.messages);

    yield {
      kind: 'finish',
      providerMetadata: {
        generationId: `mock-gen-${String(Date.now())}`,
        usage: {
          inputTokens: Math.ceil(promptCharacters / CHARS_PER_TOKEN_STANDARD),
          outputTokens: Math.ceil(echoContent.length / CHARS_PER_TOKEN_STANDARD),
        },
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

function createVideoStream(): InferenceStream {
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
            return createClassifierStream(classifierResolution, classifierDelayMs);
          }
          return createTextStream(request);
        }
        case 'image': {
          return createImageStream();
        }
        case 'video': {
          return createVideoStream();
        }
        case 'audio': {
          return createAudioStream();
        }
        default: {
          return assertNever(request);
        }
      }
    },

    getGenerationStats(): Promise<{ costUsd: number }> {
      return Promise.resolve({ costUsd: MOCK_GENERATION_STATS_COST });
    },

    getRequestHistory(): RecordedInferenceRequest[] {
      return [...history];
    },

    clearHistory(): void {
      history.length = 0;
    },
  };
}
