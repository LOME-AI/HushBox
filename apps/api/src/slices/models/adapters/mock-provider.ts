import {
  CLASSIFIER_EFFORT_DIMENSION_MARKER,
  CLASSIFIER_MODEL_DIMENSION_MARKER,
  CLASSIFIER_SYSTEM_PROMPT_MARKER,
  REASONING_EFFORT_LABELS,
  ReasoningWire,
  SMART_MODEL_ID,
  WEB_SEARCH_TOOL_NAME,
  WebSearchResults,
  callShapeFamilyFor,
  mockDirectivesSchema,
} from '@hushbox/shared';
import { MEDIA_PARAMETER_NAMES, toolCallsOfSteps } from '@hushbox/shared/affordability';
import {
  InferenceError,
  abortedError,
  invalidRequestError,
  unsupportedModalityError,
} from './inference-error.js';
import { mediaFinishEvent, mediaOutputEvents } from './media-generate.js';
import { MOCK_VIDEO_BYTES, MOCK_VIDEO_MIME_TYPE } from './mock-video-clip.js';
import { ToolCallLimitError, toolErrorReason } from './tool-error-reason.js';
import type { GeneratedMediaFile } from './media-generate.js';
import type {
  EnvUtilities,
  InferenceEvent,
  InferenceRequest,
  MockDirectives,
  ModelDescriptor,
  ToolErrorReason,
  Usage,
} from '@hushbox/shared';
import type { InferOptions, ModelProvider, ToolDefinition } from '../ports/index.js';

// `MockDirectives` is owned by `@hushbox/shared` (the run-start contract carries
// it); re-exported here so the models barrel and every existing consumer keep a
// stable import site.
export type { MockDirectives } from '@hushbox/shared';

/**
 * The dev/E2E deterministic inference mock behind the ModelProvider port — the
 * new-tree home of the legacy `x-mock-*` e2e determinism seam. It replaces the
 * real OpenRouter provider in local dev and E2E (never production/CI — see
 * `mockProviderEnabled`), producing a deterministic echo for plain turns and
 * honoring four request-driven knobs the smart-model / multi-model specs need:
 *
 *   - `classifierResolution` — the model id the mock classifier "picks";
 *   - `classifierFailure`    — the classifier throws (survivable → fallback);
 *   - `failingModels`        — a listed model's generation fails at the port;
 *   - `classifierDelayMs`    — a first-event delay on the classifier stream.
 *
 * Scope: the LANGUAGE call-shape + the smart-model classifier (where the
 * classifier-shaped knobs live; `failingModels` is modality-independent and
 * fails a listed model in any family), plus IMAGE and VIDEO generate calls —
 * each returns a single deterministic canned artifact through the same
 * media-start/media-done/finish contract the real adapters emit, so media e2e
 * specs run without cassettes. Audio/embedding families are refused with the
 * same typed unsupported-modality error the real dispatch raises, never a crash.
 *
 * Directives arrive PER-REQUEST: the chat route parses `x-mock-*` headers (dev/E2E
 * only) into `MockDirectives`, the run-start body carries them to the DO, and the
 * conversation runtime selects this mock — with those directives — per run.
 */

/**
 * The characters this fake provider counts as one token — its own synthetic
 * tokenization, deterministic and never zero (finish usage is > 0). It is NOT
 * the money layer's input ratio and carries no obligation to track it — that
 * ratio sizes a reservation against a real tokenizer, while this invents a
 * plausible count for a provider that does not tokenize at all. This mock prices
 * itself through the inline cost below, never through this count.
 */
const MOCK_TOKEN_WIDTH = 4;
/** A tiny non-zero inline cost so settlement bills authoritative (not estimated). */
export const MOCK_GENERATION_COST_USD = 0.000_001;

/** The endpoint the mock names as serving each language call it answers. */
const MOCK_SERVED_BY = 'mock';

/**
 * Echo chunk width in *graphemes* (never code units): the echo is segmented by
 * grapheme cluster so a chunk boundary never splits a multi-code-point emoji or
 * combining sequence mid-token. 24 keeps the frame count low under CI
 * saturation while still streaming the echo in multiple `text-delta` frames.
 */
const MOCK_CHUNK_GRAPHEMES = 24;
/** The echo prefix (legacy-compatible: e2e specs substring-match "Echo:"). */
export const MOCK_ECHO_PREFIX = 'Echo:';
/**
 * Trailing fenced JSON block appended to every echo. It exercises two paths that
 * broke production and must stay covered by the dev/E2E mock: the streamdown
 * incomplete-markdown parser (a fenced block whose `{`/`}` arrive across frames)
 * and the SSE multi-line `data:` path (embedded newlines mid-stream).
 */
export const MOCK_ECHO_JSON_FENCE = '\n\n```json\n{\n  "ok": true\n}\n```';
/**
 * The echo's fixed affixes. For a turn that makes no web search, the streamed
 * (and therefore persisted) assistant text is exactly `prefix + prompt +
 * suffix`; this pair plus that composition rule is the only statement of what
 * the mock echoes, so a caller that must size the persisted text without
 * running the stream reproduces it from here rather than restating the shape.
 */
export const MOCK_ECHO_AFFIXES = {
  prefix: `${MOCK_ECHO_PREFIX}\n`,
  suffix: MOCK_ECHO_JSON_FENCE,
} as const;
/**
 * Deterministic thoughts streamed (ahead of the echo) whenever a language
 * request carries a reasoning config. Long enough to span several
 * grapheme-chunked reasoning deltas so multi-frame streaming assertions hold.
 */
export const MOCK_REASONING_TEXT =
  'Reading the request. Planning a faithful echo of the prompt. Ready to answer now.';
/** Each search's query is this, numbered from 1: fixed, so it always passes the query contract. */
const MOCK_WEB_SEARCH_QUERY = 'mock web search';
/** Introduces the result title a search turn's answer names, between the prompt and the fence. */
const MOCK_WEB_SEARCH_SOURCE_LABEL = '\n\nSource: ';
/** The answer line streamed before the first search when a search follows answer text. */
const MOCK_WEB_SEARCH_LEAD_IN = 'Let me search the web for that.';

/**
 * The human-facing dev-server streaming affordances (visible typewriter echo,
 * the "Generating…" media placeholder, the "Choosing a model…" classifier
 * indicator). They fire ONLY on a real interactive dev server (`isDevServer` —
 * excludes E2E, vitest, CI, production), matching the legacy `buildMockConfig`
 * gate; a per-request directive overrides either way. Values match legacy
 * (`services/ai/index.ts`).
 */
const LOCAL_DEV_TEXT_DELAY_MS = 60;
const LOCAL_DEV_MEDIA_DELAY_MS = 3000;
const LOCAL_DEV_CLASSIFIER_DELAY_MS = 1000;
/** The searches a dev-server turn makes when its run carries web search and no directive asks. */
const LOCAL_DEV_WEB_SEARCH_COUNT = 2;

/**
 * Deterministic canned media the mock synthesizes for image/video generate
 * calls in dev/E2E — a valid PNG (400×300 fixture, or `aspectRatio`-scaled) and
 * the committed WebM clip. Fixed bytes, never random, so a media e2e replay is
 * reproducible.
 */
const MOCK_IMAGE_MIME = 'image/png';

const MOCK_IMAGE_WIDTH = 400;
const MOCK_IMAGE_HEIGHT = 300;
const MOCK_IMAGE_GRAY = 128;
/** Long side (px) of an `aspectRatio`-scaled mock image — a plausible resolution. */
const MOCK_MEDIA_LONG_SIDE = 1024;
const PNG_SIGNATURE_BYTES = [137, 80, 78, 71, 13, 10, 26, 10];

/** CRC32 over `bytes` (standard PNG polynomial 0xEDB88320) for chunk checks. */
function crc32(bytes: Uint8Array): number {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 0 ? crc >>> 1 : (crc >>> 1) ^ 0xed_b8_83_20;
    }
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/** Adler-32 over `bytes` — the trailing checksum of a zlib stream. */
function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65_521;
    b = (b + a) % 65_521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Big-endian 4-byte encoding of an unsigned 32-bit value. */
function uint32BE(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

/** Wrap `data` as a PNG chunk: length + type + data + CRC32(type + data). */
function pngChunk(type: string, data: readonly number[]): number[] {
  const body = [...new TextEncoder().encode(type), ...data];
  return [...uint32BE(data.length), ...body, ...uint32BE(crc32(Uint8Array.from(body)))];
}

/**
 * Encode `raster` as a zlib stream using uncompressed (stored) deflate blocks —
 * a fully spec-valid stream every PNG decoder inflates, produced without a
 * compression dependency. Blocks cap at 65535 bytes; the last is marked final.
 */
function zlibStored(raster: Uint8Array): number[] {
  const out: number[] = [0x78, 0x01]; // zlib header (CM=8, 32K window, no preset; 0x7801 % 31 === 0)
  const maxBlock = 0xff_ff;
  for (let offset = 0; offset < raster.length; offset += maxBlock) {
    const end = Math.min(offset + maxBlock, raster.length);
    const blockLength = end - offset;
    const complement = ~blockLength & 0xff_ff;
    out.push(
      end === raster.length ? 1 : 0,
      blockLength & 0xff,
      (blockLength >>> 8) & 0xff,
      complement & 0xff,
      complement >>> 8
    );
    for (const byte of raster.subarray(offset, end)) out.push(byte);
  }
  out.push(...uint32BE(adler32(raster)));
  return out;
}

/**
 * A programmatically-built valid `width`×`height` 8-bit grayscale PNG (signature
 * + IHDR + IDAT + IEND, correct chunk CRCs, a spec-valid stored-block zlib
 * stream), solid mid-gray. Never a hand-authored byte literal — a transcribed
 * literal is exactly what corrupted the previous mock (its IDAT body failed CRC
 * and could not inflate). The encoded dimensions are load-bearing:
 * `image-generation.spec.ts` decodes the rendered <img> and asserts its
 * naturalWidth/Height, which requires bytes a real browser decoder can genuinely
 * decode. The default fixture is 400×300; an `aspectRatio` request scales the
 * long side to {@link MOCK_MEDIA_LONG_SIDE}.
 */
function buildGrayscalePng(width: number, height: number, gray: number): Uint8Array {
  const raster = new Uint8Array(height * (1 + width));
  raster.fill(gray);
  for (let y = 0; y < height; y += 1) raster[y * (1 + width)] = 0; // per-row filter byte: none
  const ihdr = pngChunk('IHDR', [...uint32BE(width), ...uint32BE(height), 8, 0, 0, 0, 0]);
  const idat = pngChunk('IDAT', zlibStored(raster));
  const iend = pngChunk('IEND', []);
  return Uint8Array.from([...PNG_SIGNATURE_BYTES, ...ihdr, ...idat, ...iend]);
}

const MOCK_IMAGE_BYTES = buildGrayscalePng(MOCK_IMAGE_WIDTH, MOCK_IMAGE_HEIGHT, MOCK_IMAGE_GRAY);

/**
 * Pixel dimensions the mock image reports for a requested aspect ratio
 * ("16:9"), scaled so the longer side is {@link MOCK_MEDIA_LONG_SIDE}, so the
 * dev UI reserves a media box matching the requested shape. Falls back to the
 * 400×300 fixture when no (or a malformed) ratio is present — keeping the
 * common no-`aspectRatio` unit path deterministic. Video carries no dimensional
 * payload in the new media contract (its bytes are a fixed `ftyp` box and media
 * events carry no width/height), so only image is scaled.
 */
function mockImageDimensions(aspectRatio: string | undefined): { width: number; height: number } {
  const fallback = { width: MOCK_IMAGE_WIDTH, height: MOCK_IMAGE_HEIGHT };
  if (aspectRatio === undefined) return fallback;
  const [rawW, rawH] = aspectRatio.split(':');
  const ratioW = Number(rawW);
  const ratioH = Number(rawH);
  if (Number.isNaN(ratioW) || Number.isNaN(ratioH) || ratioW <= 0 || ratioH <= 0) {
    return fallback;
  }
  if (ratioW >= ratioH) {
    return {
      width: MOCK_MEDIA_LONG_SIDE,
      height: Math.round((MOCK_MEDIA_LONG_SIDE * ratioH) / ratioW),
    };
  }
  return {
    width: Math.round((MOCK_MEDIA_LONG_SIDE * ratioW) / ratioH),
    height: MOCK_MEDIA_LONG_SIDE,
  };
}

/**
 * The canned PNG for an image request: the 400×300 fixture when no aspect ratio
 * is requested (reuses the module-load fixture), else a freshly-encoded PNG at
 * the `aspectRatio`-scaled dimensions.
 */
function mockImageBytes(request: InferenceRequest): Uint8Array {
  const aspectRatio = request.parameters['aspectRatio'];
  const { width, height } = mockImageDimensions(
    typeof aspectRatio === 'string' ? aspectRatio : undefined
  );
  if (width === MOCK_IMAGE_WIDTH && height === MOCK_IMAGE_HEIGHT) return MOCK_IMAGE_BYTES;
  return buildGrayscalePng(width, height, MOCK_IMAGE_GRAY);
}

/** A header value as a non-empty string, or undefined. */
function readNonEmpty(value: string | undefined): string | undefined {
  return value === undefined || value === '' ? undefined : value;
}

/**
 * Parse the `x-mock-*` request headers into a validated {@link MockDirectives}.
 * A pure header reader (no Hono coupling): the caller supplies a header getter.
 * Malformed values are dropped, never thrown on — a bad header can never break a
 * request. `x-mock-hold-primary-stream` is the E2E stream-pause knob (dev/E2E
 * only, like every directive here); the mock holds the primary stream open until
 * an explicit release, and `x-mock-hold-primary-stream-stride` bounds how far
 * one release carries the stream before it parks again.
 */
export function parseMockDirectives(get: (name: string) => string | undefined): MockDirectives {
  const resolution = readNonEmpty(get('x-mock-classifier-resolution'));
  const classifierEffort = readNonEmpty(get('x-mock-classifier-effort'));
  const failingModels = readFailingModels(get('x-mock-failing-models'));
  const classifierDelayMs = readPositiveInt(get('x-mock-classifier-delay-ms'));
  const textDelayMs = readPositiveInt(get('x-mock-text-delay-ms'));
  const mediaDelayMs = readPositiveInt(get('x-mock-media-delay-ms'));
  const raw = {
    ...(resolution === undefined ? {} : { classifierResolution: resolution }),
    ...(classifierEffort === undefined ? {} : { classifierEffort }),
    ...(get('x-mock-classifier-failure') === 'true' ? { classifierFailure: true } : {}),
    ...(failingModels === undefined ? {} : { failingModels }),
    ...(classifierDelayMs === undefined ? {} : { classifierDelayMs }),
    ...(textDelayMs === undefined ? {} : { textDelayMs }),
    ...(mediaDelayMs === undefined ? {} : { mediaDelayMs }),
    ...readHoldDirectives(get),
    ...readWebSearchDirectives(get),
  };
  // `raw` is built from validated helpers; the schema is the final defensive gate
  // (malformed → inert). Return the parsed `data` so the result is exactly the
  // inferred `MockDirectives` shape (the literal `classifierFailure: true` the
  // wire type requires), not the widened object-literal type.
  const parsed = mockDirectivesSchema.safeParse(raw);
  return parsed.success ? parsed.data : {};
}

/**
 * The hold knobs, which only mean anything together: a stride is how far one
 * release carries a held stream, so it is read only for a stream that holds.
 */
function readHoldDirectives(
  get: (name: string) => string | undefined
): Pick<MockDirectives, 'holdPrimaryStream' | 'holdPrimaryStreamStride'> {
  if (get('x-mock-hold-primary-stream') !== 'true') return {};
  const stride = readPositiveInt(get('x-mock-hold-primary-stream-stride'));
  return {
    holdPrimaryStream: true,
    ...(stride === undefined ? {} : { holdPrimaryStreamStride: stride }),
  };
}

/** The web search knobs: how many searches, and whether answer text precedes them. */
function readWebSearchDirectives(
  get: (name: string) => string | undefined
): Pick<MockDirectives, 'webSearchCount' | 'webSearchAfterText'> {
  const count = readPositiveInt(get('x-mock-web-search-count'));
  return {
    ...(count === undefined ? {} : { webSearchCount: count }),
    ...(get('x-mock-web-search-after-text') === 'true' ? { webSearchAfterText: true } : {}),
  };
}

/** The CSV of failing model ids → a trimmed non-empty list, or undefined. */
function readFailingModels(value: string | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  const models = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return models.length > 0 ? models : undefined;
}

/** A header value parsed as a strictly-positive integer, or undefined. */
function readPositiveInt(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * THE env switch for the mock inference path: local dev OR E2E only (mirrors the
 * legacy `getAIClient` gate `isLocalDev || isE2E`). Production and CI-vitest read
 * `false` — production runs real OpenRouter; CI-vitest replays cassettes. This is
 * the single source both the runtime composer (provider selection) and
 * {@link mockDirectivesFor} (header gating) consult. The explicit `!isProduction`
 * term is belt-and-suspenders: the mock can never activate in production even if an
 * `E2E` binding errantly leaked into a production deploy.
 */
export function mockProviderEnabled(
  env: Pick<EnvUtilities, 'isLocalDev' | 'isE2E' | 'isProduction'>
): boolean {
  return (env.isLocalDev || env.isE2E) && !env.isProduction;
}

/**
 * The directives for a request, gated on {@link mockProviderEnabled}: parsed only
 * where the mock is active (dev/E2E), and inert (`{}`) everywhere else — so a
 * production request carrying `x-mock-*` headers is never read and never threaded.
 */
export function mockDirectivesFor(
  env: Pick<EnvUtilities, 'isLocalDev' | 'isE2E' | 'isProduction'>,
  get: (name: string) => string | undefined
): MockDirectives {
  return mockProviderEnabled(env) ? parseMockDirectives(get) : {};
}

/** The resolved streaming delays a run uses (ms); 0 means no delay. */
interface MockDelays {
  readonly textDelayMs: number;
  readonly mediaDelayMs: number;
  readonly classifierDelayMs: number;
}

/**
 * Resolve the per-run streaming delays, mirroring legacy `buildMockConfig`: a
 * per-request directive value always wins (`??`), otherwise the human-facing
 * dev-server default applies ONLY when `isDevServer` — the strict-subset env
 * flag (excludes E2E, vitest, CI, production), so automated test runs never
 * inherit artificial delay unless a test explicitly asks for one. The caller
 * derives `isDevServer` from `envUtils` (`createEnvUtilities().isDevServer`),
 * never from a raw `NODE_ENV`/`CI`/`E2E` check.
 */
export function resolveMockDelays(directives: MockDirectives, isDevServer: boolean): MockDelays {
  const devDefault = (value: number): number => (isDevServer ? value : 0);
  return {
    textDelayMs: directives.textDelayMs ?? devDefault(LOCAL_DEV_TEXT_DELAY_MS),
    mediaDelayMs: directives.mediaDelayMs ?? devDefault(LOCAL_DEV_MEDIA_DELAY_MS),
    classifierDelayMs: directives.classifierDelayMs ?? devDefault(LOCAL_DEV_CLASSIFIER_DELAY_MS),
  };
}

/**
 * A deterministic ModelProvider for dev/E2E; every generation is reproducible.
 * `awaitStreamRelease` is the dev/E2E stream-pause barrier the ConversationRoom
 * DO threads per-run (never on the wire): when `holdPrimaryStream` is set the
 * primary stream parks on it once a client can observe it active. An echo
 * parks after the reasoning deltas when the request reasons, otherwise after
 * its first chunk; a search turn parks with every search asked for and none
 * answered. Each release then carries the answer `holdPrimaryStreamStride`
 * chunks before it parks again, or to the end without a stride. Absent on the
 * real path and on every unheld run, so behavior is unchanged without it.
 *
 * `isDevServer` gates every dev-server default (see {@link resolveMockDelays}),
 * and a per-request directive always wins over one. It defaults `false`, so any
 * caller that does not thread the env flag, and therefore every automated
 * (E2E/vitest/CI) run, gets none of those defaults.
 */
export function createMockModelProvider(
  directives: MockDirectives = {},
  awaitStreamRelease?: () => Promise<void>,
  isDevServer = false
): ModelProvider {
  const failingModels = new Set(directives.failingModels);
  const delays = resolveMockDelays(directives, isDevServer);
  // The dev-server default follows the delays' rule: a directive always wins,
  // and only a real dev server searches without one.
  const webSearchCount =
    directives.webSearchCount ?? (isDevServer ? LOCAL_DEV_WEB_SEARCH_COUNT : undefined);
  let generationCounter = 0;
  const mintGenerationId = (): string => {
    generationCounter += 1;
    return `mock-gen-${String(generationCounter)}`;
  };
  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      options: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      const events = inferMock({
        request,
        descriptor,
        directives,
        delays,
        webSearchCount,
        failingModels,
        mintGenerationId,
        options,
        ...(awaitStreamRelease === undefined ? {} : { awaitStreamRelease }),
      });
      return options.signal === undefined ? events : endedOnAbort(events, options.signal);
    },
  };
}

/**
 * Ends a stream the way the language adapter ends an aborted SDK stream: the
 * pull that is pending when the signal fires, or the next one, throws the
 * `aborted` InferenceError, whether the stream is parked or streaming.
 */
async function* endedOnAbort(
  events: AsyncIterable<InferenceEvent>,
  signal: AbortSignal
): AsyncGenerator<InferenceEvent> {
  const iterator = events[Symbol.asyncIterator]();
  let onAbort!: () => void;
  const aborted = new Promise<'aborted'>((resolve) => {
    onAbort = (): void => {
      resolve('aborted');
    };
  });
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next === 'aborted') throw abortedError();
      if (next.done === true) return;
      yield next.value;
    }
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

interface MockContext {
  readonly request: InferenceRequest;
  readonly descriptor: ModelDescriptor;
  readonly directives: MockDirectives;
  readonly delays: MockDelays;
  /** The searches the turn makes when its run carries web search; undefined makes none. */
  readonly webSearchCount: number | undefined;
  readonly failingModels: ReadonlySet<string>;
  readonly mintGenerationId: () => string;
  readonly options: InferOptions;
  /** The dev/E2E stream-release barrier a language turn awaits under `holdPrimaryStream`. */
  readonly awaitStreamRelease?: () => Promise<void>;
}

async function* inferMock(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const { request, descriptor } = ctx;
  if (request.model === SMART_MODEL_ID) {
    // Defensive: the virtual sentinel must be resolved to a real candidate before
    // inference; mirror the real gateway's rejection so a forwarding bug fails in
    // tests too, not only in production.
    throw invalidRequestError(`Mock provider received the virtual '${SMART_MODEL_ID}' id`);
  }
  const family = callShapeFamilyFor(descriptor.outputs);
  if (family !== 'image' && family !== 'video' && family !== 'language') {
    throw unsupportedModalityError(descriptor.outputs);
  }
  if (family === 'language' && isClassifierRequest(request)) {
    yield* classifierStream(ctx);
    return;
  }
  if (ctx.failingModels.has(request.model)) {
    // A directed generation failure — the typed InferenceError the engine treats
    // as an expected inference failure (err), exactly like a real provider outage.
    // It sits ahead of every family's generation branch because the directive is
    // modality-independent: one mechanism fails text, image and video alike, and a
    // named video model fails without first having to carry a valid duration.
    throw new InferenceError('upstream_error', `Mock: model ${request.model} is unavailable`);
  }
  if (family === 'image') {
    yield* mediaStream(ctx, 'image', MOCK_IMAGE_MIME, mockImageBytes(request));
    return;
  }
  if (family === 'video') {
    assertSupportedVideoDuration(request, descriptor);
    yield* mediaStream(ctx, 'video', MOCK_VIDEO_MIME_TYPE, MOCK_VIDEO_BYTES);
    return;
  }
  yield* languageStream(ctx);
}

/** A language turn: a search turn when the run carries web search and the turn searches, else the echo. */
function languageStream(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const search = webSearchOf(ctx);
  return search === undefined ? echoStream(ctx) : searchStream(ctx, search);
}

/** A turn's web search: the run's tool, the searches asked for, and where they fall. */
interface MockWebSearch {
  readonly tool: ToolDefinition;
  readonly count: number;
  /** The tool calls the run's loop admits; the calls past it are refused. */
  readonly budget: number;
  readonly afterText: boolean;
}

/** The turn's web search, when the run carries the tool and this turn searches. */
function webSearchOf(ctx: MockContext): MockWebSearch | undefined {
  const count = ctx.webSearchCount;
  const loop = ctx.options.tools;
  const tool = loop?.registry[WEB_SEARCH_TOOL_NAME];
  if (count === undefined || loop === undefined || tool === undefined) return undefined;
  return {
    tool,
    count,
    budget: toolCallsOfSteps(loop.maxSteps),
    afterText: ctx.directives.webSearchAfterText === true,
  };
}

/** One search call: what it returned, or why it returned nothing. */
type SearchOutcome = { readonly result: unknown } | { readonly reason: ToolErrorReason };

/** A held run's stream-release barrier and how many chunks one release carries it. */
interface MockHold {
  readonly release: () => Promise<void>;
  readonly stride?: number;
}

/** The hold a run parks under: only a `holdPrimaryStream` run with a barrier wired has one. */
function holdOf(ctx: MockContext): MockHold | undefined {
  const release = ctx.awaitStreamRelease;
  if (ctx.directives.holdPrimaryStream !== true || release === undefined) return undefined;
  const stride = ctx.directives.holdPrimaryStreamStride;
  return { release, ...(stride === undefined ? {} : { stride }) };
}

/**
 * A two-step tool loop in the real adapter's event order. The first step
 * streams the request's reasoning, then the lead-in line when asked for, then
 * the searches. The second step answers with the echo, naming the first
 * result's title. Each step reports its own generation and inline cost, and the
 * finish carries their sum and no generation id, as a multi-step run does.
 *
 * Under a hold the turn parks once with every search asked for and none
 * answered, the searching state a client can watch; its answer text then parks
 * after every stride of chunks, as the echo does.
 */
async function* searchStream(
  ctx: MockContext,
  search: MockWebSearch
): AsyncGenerator<InferenceEvent> {
  const prompt = promptTextOf(ctx.request);
  const delayMs = ctx.delays.textDelayMs;
  const reasoningText = mockReasoningTextFor(ctx.request.parameters['reasoning']);
  const leadIn = search.afterText ? MOCK_WEB_SEARCH_LEAD_IN : '';
  const hold = holdOf(ctx);
  yield { kind: 'step-start', step: 0 };
  if (reasoningText !== undefined) yield* reasoningDeltas(reasoningText, delayMs);
  if (leadIn !== '') yield* textDeltas(leadIn, delayMs);
  const firstTitle = yield* searchCalls(ctx, search, hold?.release);
  const searchingOutput = leadIn === '' ? 0 : tokensOf(leadIn);
  const searchingUsage = { inputTokens: tokensOf(prompt), outputTokens: searchingOutput };
  yield stepFinishEvent(0, ctx.mintGenerationId(), searchingUsage);
  yield { kind: 'step-start', step: 1 };
  const source = firstTitle === undefined ? '' : `${MOCK_WEB_SEARCH_SOURCE_LABEL}${firstTitle}`;
  const content = `${MOCK_ECHO_AFFIXES.prefix}${prompt}${source}${MOCK_ECHO_AFFIXES.suffix}`;
  const answer = textDeltas(content, delayMs);
  yield* hold === undefined ? answer : strideParks(answer, hold.release, hold.stride);
  const outputTokens = tokensOf(`${leadIn}${content}`);
  // The steps split the finish's usage between them, so the two agree as the real loop's do.
  yield stepFinishEvent(1, ctx.mintGenerationId(), {
    inputTokens: 0,
    outputTokens: outputTokens - searchingOutput,
  });
  yield {
    kind: 'finish',
    metadata: {
      usage: {
        inputTokens: tokensOf(prompt),
        outputTokens,
        ...(reasoningText === undefined ? {} : { reasoningTokens: tokensOf(reasoningText) }),
      },
      finishReason: 'stop',
      providerCostUsd: MOCK_GENERATION_COST_USD + MOCK_GENERATION_COST_USD,
    },
  };
}

/**
 * Asks for every search at once, then answers each: a call within the loop's
 * budget runs through the tool's `execute`, and the rest are refused as the
 * adapter refuses them. A held run parks between the asking and the answering.
 * Returns the first result's title, when one returned.
 */
async function* searchCalls(
  ctx: MockContext,
  search: MockWebSearch,
  park: (() => Promise<void>) | undefined
): AsyncGenerator<InferenceEvent, string | undefined> {
  // A run with no signal hands `execute` one that never aborts, as the language adapter does.
  const signal = ctx.options.signal ?? new AbortController().signal;
  const calls = Array.from({ length: search.count }, (_unused, index) => ({
    id: `mock-search-${String(index + 1)}`,
    args: { query: `${MOCK_WEB_SEARCH_QUERY} ${String(index + 1)}` },
  }));
  for (const call of calls) {
    yield { kind: 'tool-call', id: call.id, name: WEB_SEARCH_TOOL_NAME, args: call.args };
  }
  if (park !== undefined) await park();
  let firstTitle: string | undefined;
  for (const [index, call] of calls.entries()) {
    const outcome =
      index < search.budget
        ? await searchOutcome(search.tool, call.args, signal)
        : { reason: toolErrorReason(new ToolCallLimitError()) };
    if ('reason' in outcome) {
      yield { kind: 'tool-error', id: call.id, name: WEB_SEARCH_TOOL_NAME, reason: outcome.reason };
      continue;
    }
    firstTitle ??= firstTitleOf(outcome.result);
    yield { kind: 'tool-result', id: call.id, name: WEB_SEARCH_TOOL_NAME, result: outcome.result };
  }
  return firstTitle;
}

/**
 * Runs one search through the tool's `execute`. A throw becomes its reason, as
 * the adapter maps it; one after the run aborted fails the stream as aborted,
 * with no reason, as the adapter's abort does.
 */
async function searchOutcome(
  tool: ToolDefinition,
  args: unknown,
  signal: AbortSignal
): Promise<SearchOutcome> {
  try {
    return { result: await tool.execute(args, { signal }) };
  } catch (error) {
    const reason = toolErrorReason(error, signal);
    if (reason === undefined) throw abortedError();
    return { reason };
  }
}

/** The first result's title, when the search found any; the web search tool answers only results. */
function firstTitleOf(result: unknown): string | undefined {
  return WebSearchResults.parse(result).results[0]?.title;
}

function stepFinishEvent(step: number, generationId: string, usage: Usage): InferenceEvent {
  return {
    kind: 'step-finish',
    step,
    generationId,
    providerCostUsd: MOCK_GENERATION_COST_USD,
    usage,
    servedBy: MOCK_SERVED_BY,
  };
}

/** A classifier call is recognized by the marker the shared prompt embeds. */
function isClassifierRequest(request: InferenceRequest): boolean {
  return request.inputs.some(
    (part) => part.modality === 'text' && part.text.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)
  );
}

async function* classifierStream(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const { request, directives } = ctx;
  // The classifier delay is a first-event gate (the "Choosing a model…"
  // indicator), never a per-chunk typewriter — its short output emits at once.
  await delay(ctx.delays.classifierDelayMs);
  if (directives.classifierFailure === true) {
    throw new InferenceError('upstream_error', 'Mock: classifier unavailable');
  }
  // The requested dimensions ride the prompt's marker line (the same
  // no-prompt-coupling contract as the base marker). A legacy prompt carrying
  // neither dimension marker is model routing.
  const { model, effort } = classifierDimensionsOf(request);
  // One labelled line per dimension, exactly as the shared prompt instructs:
  // the answer parser reads by label, never by position.
  const lines: string[] = [];
  if (model) {
    // The routing choice: the directive, else the classifier's own model id —
    // by construction the cheapest candidate, which the resolver matches
    // exactly, so the default deterministically routes to the cheapest.
    lines.push(`model: ${directives.classifierResolution ?? request.model}`);
  }
  if (effort) {
    // The effort choice: the directive, else the canonical middle rung. It is
    // the MOCK's own deterministic answer, deliberately not the product's
    // fallback — a mock that answered what the reducer falls back to could not
    // tell "the classifier chose" from "nothing was chosen". Emitted as the
    // user-facing LABEL, because the classifier is presented labels and the
    // answer parser matches on them.
    const option = directives.classifierEffort ?? 'medium';
    lines.push(`effort: ${REASONING_EFFORT_LABELS[option]}`);
  }
  const answer = lines.join('\n');
  yield* textDeltas(answer, 0);
  yield finishEvent(promptTextOf(request), answer, ctx.mintGenerationId());
}

/** The dimension markers on the classifier prompt's marker line. */
function classifierDimensionsOf(request: InferenceRequest): {
  readonly model: boolean;
  readonly effort: boolean;
} {
  let markerLine = '';
  for (const part of request.inputs) {
    if (part.modality === 'text' && part.text.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)) {
      markerLine = part.text.split('\n')[0] ?? '';
      break;
    }
  }
  const effort = markerLine.includes(CLASSIFIER_EFFORT_DIMENSION_MARKER);
  const model = markerLine.includes(CLASSIFIER_MODEL_DIMENSION_MARKER) || !effort;
  return { model, effort };
}

/**
 * Synthesize one deterministic media artifact, mirroring the real image/video
 * adapters' event shape: the canned bytes flow through the caller's
 * `mapFilePart` (a missing mapper is an AdapterDefect, exactly as in the real
 * path) into a media-start/media-done pair, then a terminal finish. Video
 * carries OpenRouter's inline cost + a generation id so settlement bills
 * authoritative; image carries neither (its API returns no inline cost, so
 * settlement falls back to the deterministic estimate).
 */
async function* mediaStream(
  ctx: MockContext,
  modality: 'image' | 'video',
  mimeType: string,
  bytes: Uint8Array
): AsyncGenerator<InferenceEvent> {
  const file: GeneratedMediaFile = { mediaType: mimeType, uint8Array: bytes };
  const events = mediaOutputEvents([file], ctx.options.mapFilePart);
  // Emit media-start immediately so the placeholder paints, hold for the media
  // delay (visible "Generating…" on a dev server; 0 elsewhere), then media-done
  // — mirroring legacy's `buildMediaStream` sequencing.
  for (const [index, event] of events.entries()) {
    if (index > 0) await delay(ctx.delays.mediaDelayMs);
    yield event;
  }
  if (modality === 'video') {
    const metadata = {
      openrouter: { generationId: ctx.mintGenerationId(), cost: MOCK_GENERATION_COST_USD },
    };
    yield mediaFinishEvent(metadata, { inputTokens: 0, outputTokens: 0 }, MOCK_GENERATION_COST_USD);
    return;
  }
  yield mediaFinishEvent(undefined, { inputTokens: 0, outputTokens: 0 });
}

/**
 * Parity with the real video path: an unsupported requested duration is refused
 * before synthesis. The domain is the model's OWN catalog ParamSpec — the same
 * declaration `model-call-execution`'s pre-flight and every media dimension read
 * — so a model that declares no duration set is unconstrained, and a
 * non-integer/absent requested value imposes no check.
 */
function assertSupportedVideoDuration(
  request: InferenceRequest,
  descriptor: ModelDescriptor
): void {
  const requested = request.parameters[MEDIA_PARAMETER_NAMES.durationSeconds];
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested <= 0) return;
  const spec = descriptor.parameters[MEDIA_PARAMETER_NAMES.durationSeconds];
  if (spec?.type !== 'enum' || spec.values === undefined) return;
  if (!spec.values.includes(requested)) {
    throw invalidRequestError(
      `Unsupported video duration (${String(requested)}s) for model ${request.model}`
    );
  }
}

/**
 * The mock's thoughts for a request's `reasoning` param: only an ACTIVE wire
 * (effort or token budget) thinks — absence, a malformed value, and the
 * hard-off `{ enabled: false }` wire all produce none.
 */
function mockReasoningTextFor(reasoning: unknown): string | undefined {
  const wire = ReasoningWire.safeParse(reasoning);
  if (!wire.success || 'enabled' in wire.data) return undefined;
  return MOCK_REASONING_TEXT;
}

async function* echoStream(ctx: MockContext): AsyncGenerator<InferenceEvent> {
  const prompt = promptTextOf(ctx.request);
  // Newline-separated, never same-line: a same-line prefix would put any
  // column-0-sensitive markdown the prompt starts with (code fences, headings,
  // lists) mid-line and corrupt the shape prod would produce (mock fidelity).
  // The trailing JSON fence exercises the streamdown incomplete-markdown + SSE
  // multi-line `data:` paths.
  const content = `${MOCK_ECHO_AFFIXES.prefix}${prompt}${MOCK_ECHO_AFFIXES.suffix}`;
  const delayMs = ctx.delays.textDelayMs;
  // Deterministic reasoning emission: a request carrying an ACTIVE reasoning
  // config streams a few reasoning deltas ahead of the echo text (mirroring
  // the real provider's reasoning-before-answer ordering) and bills
  // reasoningTokens on the finish — so reasoning assertions stay
  // provider-agnostic under the local mock run and E2E gets deterministic
  // thoughts. Reasoning-free requests and the hard-off `{ enabled: false }`
  // wire are byte-for-byte unchanged: off must behave exactly like no
  // reasoning (no deltas, no reasoningTokens).
  const reasoningText = mockReasoningTextFor(ctx.request.parameters['reasoning']);
  if (reasoningText !== undefined) {
    yield* reasoningDeltas(reasoningText, delayMs);
  }
  // The dev/E2E stream-pause path: park at the DO-owned release barrier once the
  // client can deterministically observe an active stream, then drain the
  // remainder + finish. Unset (or no barrier wired) is the unchanged instant
  // echo. A reasoning request has already emitted that observable activity, so
  // the park lands in the reasoning-only phase — thoughts streamed, no answer
  // yet — which is the only phase a live-reasoning assertion can be made in.
  // Without reasoning the first answer delta is the only signal there is, so it
  // still precedes the park.
  const hold = holdOf(ctx);
  if (hold !== undefined) {
    yield* parkingTextDeltas(content, delayMs, hold.release, {
      ...(reasoningText === undefined ? {} : { alreadyObservable: true }),
      ...(hold.stride === undefined ? {} : { stride: hold.stride }),
    });
    yield finishEvent(prompt, content, ctx.mintGenerationId(), reasoningText);
    return;
  }
  yield* textDeltas(content, delayMs);
  yield finishEvent(prompt, content, ctx.mintGenerationId(), reasoningText);
}

/**
 * The echo under the dev/E2E hold: it parks at the release barrier once the
 * client can deterministically observe an active stream, and again after every
 * `stride` further chunks, so a test can walk the stream forward a known
 * distance at a time. No stride means one park for the whole run. Parking only
 * with a chunk in hand is what keeps the last release the one that finishes the
 * run rather than leaving it parked on an exhausted echo.
 */
async function* parkingTextDeltas(
  content: string,
  delayMs: number,
  release: () => Promise<void>,
  options: { readonly alreadyObservable?: true; readonly stride?: number }
): AsyncGenerator<InferenceEvent> {
  const iterator = textDeltas(content, delayMs)[Symbol.asyncIterator]();
  if (options.alreadyObservable !== true) {
    const first = await iterator.next();
    /* v8 ignore next -- the echo content carries the non-empty prefix, so a first delta always exists */
    if (first.done === true) return;
    yield first.value;
  }
  await release();
  yield* strideParks(iterator, release, options.stride);
}

/**
 * Streams `chunks` for a held run that is not parked: it parks after every
 * `stride` chunks, and only with a chunk in hand, so the last release is the
 * one that finishes the stream. No stride lets every chunk through.
 */
async function* strideParks(
  chunks: AsyncIterator<InferenceEvent>,
  release: () => Promise<void>,
  stride: number | undefined
): AsyncGenerator<InferenceEvent> {
  let sinceRelease = 0;
  for (let next = await chunks.next(); next.done !== true; next = await chunks.next()) {
    if (sinceRelease === stride) {
      await release();
      sinceRelease = 0;
    }
    yield next.value;
    sinceRelease += 1;
  }
}

/** The current-turn user text: the last non-marker text input part. */
function promptTextOf(request: InferenceRequest): string {
  for (let index = request.inputs.length - 1; index >= 0; index -= 1) {
    const part = request.inputs[index];
    if (part?.modality === 'text' && !part.text.startsWith(CLASSIFIER_SYSTEM_PROMPT_MARKER)) {
      return part.text;
    }
  }
  return '';
}

async function* textDeltas(content: string, delayMs: number): AsyncGenerator<InferenceEvent> {
  // One text stream → slot index 0 for every delta (model-call-execution
  // concatenates by content, not index). Grapheme-segmented so a chunk boundary
  // never splits a multi-code-point cluster. The first chunk emits immediately;
  // each subsequent chunk waits `delayMs` (the typewriter cadence; 0 = instant).
  const chunks = chunkByGrapheme(content, MOCK_CHUNK_GRAPHEMES);
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await delay(delayMs);
    yield { kind: 'text-delta', index: 0, content: chunk };
  }
}

/**
 * Reasoning counterpart of {@link textDeltas}: one reasoning stream at slot
 * index 0, grapheme-chunked, same typewriter cadence rules.
 */
async function* reasoningDeltas(content: string, delayMs: number): AsyncGenerator<InferenceEvent> {
  const chunks = chunkByGrapheme(content, MOCK_CHUNK_GRAPHEMES);
  for (const [index, chunk] of chunks.entries()) {
    if (index > 0) await delay(delayMs);
    yield { kind: 'reasoning-delta', index: 0, content: chunk };
  }
}

/** Split `content` into chunks of at most `size` grapheme clusters (never mid-cluster). */
function chunkByGrapheme(content: string, size: number): string[] {
  const graphemes = Array.from(
    new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(content),
    (entry) => entry.segment
  );
  const chunks: string[] = [];
  for (let index = 0; index < graphemes.length; index += size) {
    chunks.push(graphemes.slice(index, index + size).join(''));
  }
  return chunks;
}

function finishEvent(
  input: string,
  output: string,
  generationId: string,
  reasoningText?: string
): InferenceEvent {
  return {
    kind: 'finish',
    metadata: {
      usage: {
        inputTokens: tokensOf(input),
        outputTokens: tokensOf(output),
        ...(reasoningText === undefined ? {} : { reasoningTokens: tokensOf(reasoningText) }),
      },
      finishReason: 'stop',
      providerCostUsd: MOCK_GENERATION_COST_USD,
      generationId,
      servedBy: MOCK_SERVED_BY,
    },
  };
}

function tokensOf(text: string): number {
  return Math.max(1, Math.ceil(text.length / MOCK_TOKEN_WIDTH));
}

/** Resolve after `ms` (a positive delay), or immediately when `ms <= 0`. */
function delay(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}
