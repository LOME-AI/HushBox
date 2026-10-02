import { z } from 'zod';
import { MediaValue } from './content-value.ts';
import { Modality } from '../affordability/model/modality.ts';
import { ResolvedReasoningEffort } from '../affordability/reasoning-effort.ts';

/**
 * Multimodal I/O contract — replaces the text-or-one-blob event model.
 * Text rides inline; media inputs ride by reference (request-body staging or
 * the short-TTL `inputs/` fallback). Extending input modalities = add a
 * variant here alongside the enum migration (rare, deliberate).
 */
export const MediaRef = z.object({
  ref: z.string().min(1),
  mimeType: z.string().min(1),
  byteLength: z.number().int().nonnegative(),
});

export type MediaRef = z.infer<typeof MediaRef>;

export const InputPart = z.discriminatedUnion('modality', [
  z.object({ modality: z.literal('text'), text: z.string() }),
  z.object({ modality: z.literal('image'), ref: MediaRef }),
  z.object({ modality: z.literal('audio'), ref: MediaRef }),
  z.object({ modality: z.literal('video'), ref: MediaRef }),
]);

export type InputPart = z.infer<typeof InputPart>;

/**
 * One prior turn of client-supplied conversation history. Content is
 * E2E-encrypted at rest, so the server cannot reconstruct history — the client
 * decrypts and resends it each turn (stateless). Deliberately unbounded: no
 * count cap, no length cap, no alternation constraint (founder ruling); the
 * engine/platform byte budgets and the trial price gate are the only limits.
 */
export const ChatHistoryMessage = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1),
});

export type ChatHistoryMessage = z.infer<typeof ChatHistoryMessage>;

export const InferenceRequest = z.object({
  model: z.string().min(1),
  inputs: z.array(InputPart),
  parameters: z.record(z.string(), z.unknown()), // validated against descriptor.parameters
  outputs: z.array(Modality),
  /**
   * PRIOR turns only, oldest first — the current turn rides `inputs` and the
   * language adapter appends it last. Absent means exactly the single-message
   * behavior that predates history.
   */
  history: z.array(ChatHistoryMessage).optional(),
  /**
   * Client-supplied plaintext custom instructions, folded into the base system
   * prompt. Stored instructions are E2E-encrypted (the server cannot decrypt the
   * blob), so — like `history` — the client decrypts and resends them each turn.
   * Absent leaves the base system prompt untouched.
   */
  customInstructions: z.string().max(5000).optional(),
  /**
   * True when this call is ROUTING INTERNALS rather than an answer — today, the
   * turn's classifier. It suppresses the base system preamble: the classifier
   * reserve prices its truncated context plus the classifier template, and the
   * preamble is neither, so a routing call that carried it would bill input no
   * reservation covered (`docs/BILLING.md` §Reasoning Effort 6/7).
   *
   * It rides the REQUEST rather than the run context because the preamble is
   * ADDED at the adapter; there is nothing for a caller to withhold.
   */
  routingOnly: z.boolean().optional(),
  /**
   * The UTC calendar day (`YYYY-MM-DD`) the base system prompt tells the model
   * it is. It carries the rendered key rather than an instant so the request
   * holds exactly the bytes that reach the wire — and therefore exactly the
   * bytes the cassette hashes.
   *
   * Required, and on the REQUEST for the same reason as `routingOnly`: the
   * preamble is ADDED at the adapter, so the adapter would otherwise have to
   * read a wall clock. A clock read there re-keys every recorded cassette at
   * UTC midnight; a required field makes a caller that supplies no day a
   * compile error instead.
   */
  utcDay: z.iso.date(),
});

export type InferenceRequest = z.infer<typeof InferenceRequest>;

/**
 * Terminal finish reasons — mirrors the AI SDK's `FinishReason` union
 * exactly (the SDK maps unmapped provider reasons to `other`). `length` with
 * empty output is billable terminal success — truncation, not error; that
 * semantic lives in consumers, the event only carries the reason.
 */
export const FINISH_REASONS = [
  'stop',
  'length',
  'content-filter',
  'tool-calls',
  'error',
  'other',
] as const;

export const FinishReason = z.enum(FINISH_REASONS);
export type FinishReason = z.infer<typeof FinishReason>;

export const Usage = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  cachedInputTokens: z.number().int().nonnegative().optional(),
});

export type Usage = z.infer<typeof Usage>;

/**
 * The endpoint that served a provider request, as the stream names it. The
 * gateway routes each request to one of a model's endpoints, so a multi-step
 * call can be served by several.
 */
const ServedBy = z.string().min(1);

/**
 * Terminal metadata: observed usage feeds the settlement estimate;
 * `generationId` keys a per-generation record (absent on multi-step runs,
 * where each step-finish carries its own id). `providerCostUsd` is the raw
 * provider-charged cost in USD read inline off the response — the billing
 * truth settlement charges directly (no true-up); absent when the provider
 * returns no inline cost (image generation, or the pathological missing-cost
 * path), where settlement falls back to the deterministic estimate. Carried
 * as the raw USD number; nano-USD conversion happens at settlement.
 */
export const ProviderMetadata = z.object({
  generationId: z.string().min(1).optional(),
  usage: Usage,
  finishReason: FinishReason,
  providerCostUsd: z.number().optional(),
  raw: z.record(z.string(), z.unknown()).optional(),
  // Set only by a call that names its endpoint at its end rather than per step.
  servedBy: ServedBy.optional(),
});

export type ProviderMetadata = z.infer<typeof ProviderMetadata>;

export const ToolCall = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
});

export type ToolCall = z.infer<typeof ToolCall>;

export const ToolResult = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  result: z.unknown(),
});

export type ToolResult = z.infer<typeof ToolResult>;

/**
 * Why a tool call produced no result: `execute` threw (`failed`), the dispatch
 * cap refused it (`limit`), or the SDK rejected its arguments
 * (`invalid-input`). An abort emits no event at all. Closed, and carrying no
 * error text, so a failure's message can never reach a client or a log.
 */
export const TOOL_ERROR_REASONS = ['failed', 'limit', 'invalid-input'] as const;

export const ToolErrorReason = z.enum(TOOL_ERROR_REASONS);
export type ToolErrorReason = z.infer<typeof ToolErrorReason>;

/**
 * The extended streaming event union: text/reasoning deltas,
 * agentic tool activity with per-step generations (each step's generationId
 * feeds its own usage_records row), media events, and the terminal finish.
 */
export const InferenceEvent = z.discriminatedUnion('kind', [
  // Every model output stream's FIRST event: labels the stream with the
  // provider-facing model id actually called, so clients can title per-model
  // tiles (multi-model) and surface Smart Model's classifier-resolved choice
  // without a side channel. Rides the replay buffer like any event, so the
  // label survives reconnect. Never billed, never persisted, never content.
  z.object({
    kind: z.literal('stream-start'),
    modelId: z.string().min(1),
    // Present iff the call is a media-family generation (image/video): the
    // EARLY per-node media signal, emitted before the provider call returns.
    // Clients swap the tile to "Generating…" on it (the frame's streamId is
    // the node identity; the precise mime arrives later on media-start).
    // Text/embedding streams omit it.
    outputModality: Modality.optional(),
    // The id this stream's answer is stored under, minted when the run started,
    // so a live tile and the stored row that replaces it are one message. Absent
    // on a stream no stored row follows (a trial run).
    messageId: z.string().min(1).optional(),
  }),
  z.object({ kind: z.literal('text-delta'), index: z.number(), content: z.string() }),
  z.object({ kind: z.literal('reasoning-delta'), index: z.number(), content: z.string() }),
  ToolCall.extend({ kind: z.literal('tool-call') }),
  ToolResult.extend({ kind: z.literal('tool-result') }),
  z.object({
    kind: z.literal('tool-error'),
    id: z.string().min(1),
    name: z.string().min(1),
    reason: ToolErrorReason,
  }),
  z.object({ kind: z.literal('step-start'), step: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('step-finish'),
    step: z.number().int().nonnegative(),
    generationId: z.string().min(1),
    // Per-step provider cost (USD) for an agentic step, read inline off the
    // step's response; summed across steps into the run's terminal cost.
    providerCostUsd: z.number().optional(),
    // The step's own usage, which decides the long-context tier of that step alone.
    usage: Usage.optional(),
    servedBy: ServedBy.optional(),
  }),
  z.object({
    kind: z.literal('media-start'),
    index: z.number(),
    modality: Modality,
    mimeType: z.string().min(1),
  }),
  z.object({ kind: z.literal('media-done'), index: z.number(), value: MediaValue }),
  // Synthetic per-node generation progress for VIDEO streams (image gets only
  // start/done — generations are short). Server-paced: a 0→95 sweep at
  // expected-duration cadence, then 95 heartbeats until the real completion;
  // media-done/run-terminal frames end the tile (clients render done as 100%).
  // `index` aligns with the media-start/media-done pair of the same stream.
  // Never billed, never persisted, never content.
  z.object({
    kind: z.literal('media-progress'),
    index: z.number(),
    percent: z.number().int().min(0).max(100),
  }),
  z.object({
    kind: z.literal('finish'),
    metadata: ProviderMetadata,
    // The rung this call's reasoning wire was minted at. Deliberately a sibling
    // of `metadata` rather than a member of it: the provider reports what the
    // model did, while the level is what the CALLER asked for, and only the
    // caller that minted the wire knows which rung it named (two rungs can
    // clamp to one identical budget). It rides the terminal frame so a client
    // watching its own turn badges the level live, off the same resolution
    // settlement persists. Absent means no level was recorded; `off` is a
    // recorded level and travels as itself, so the two never collapse.
    reasoningEffort: ResolvedReasoningEffort.optional(),
  }),
]);

export type InferenceEvent = z.infer<typeof InferenceEvent>;

/**
 * Multi-output rule: a text+image model streams `file` parts through
 * the *language* call-shape; the language adapter maps each file part to a
 * media-start/media-done event pair.
 */
export const FilePart = z.object({
  mediaType: z.string().min(1),
  data: z.instanceof(Uint8Array),
});

export type FilePart = z.infer<typeof FilePart>;

type EventOfKind<K extends InferenceEvent['kind']> = Extract<InferenceEvent, { kind: K }>;

export type FilePartMediaEvents = readonly [EventOfKind<'media-start'>, EventOfKind<'media-done'>];

export type FilePartMapper = (part: FilePart, index: number) => FilePartMediaEvents;
