import { stepCountIs, streamText, tool, wrapLanguageModel } from 'ai';
import { match, P } from 'ts-pattern';
import { z } from 'zod';
import { ReasoningWire, buildTurnSystemPrompt, languageRoutingOptions } from '@hushbox/shared';
import { toolCallsOfSteps } from '@hushbox/shared/affordability';
import {
  InferenceError,
  abortedError,
  classifyInferenceFailure,
  emptyCompletionError,
  invalidRequestError,
  noReasoningEndpointsError,
  truncatedStreamError,
} from './inference-error.js';
import { validateInferenceCall } from './inference-boundary.js';
import { createOpenRouterProvider } from './openrouter-provider.js';
import { ToolCallLimitError, toolErrorReason } from './tool-error-reason.js';
import type { OpenRouterProvider } from '@openrouter/ai-sdk-provider';
import type {
  AssistantModelMessage,
  FinishReason,
  LanguageModel,
  LanguageModelMiddleware,
  LanguageModelUsage,
  ModelMessage,
  PrepareStepFunction,
  PrepareStepResult,
  StepResult,
  StopCondition,
  TextStreamPart,
  ToolModelMessage,
  ToolResultPart,
  ToolSet,
} from 'ai';
import type {
  FilePartMapper,
  InferenceEvent,
  InferenceRequest,
  ModelDescriptor,
  ToolErrorReason,
  Usage,
} from '@hushbox/shared';
import type {
  InferOptions,
  ModelProvider,
  ToolLoopOptions,
  ToolSelection,
} from '../ports/index.js';

/**
 * The language-family adapter behind the ModelProvider port: the AI SDK's
 * `streamText` against OpenRouter (`openrouter.chat`). Multi-output models
 * stream `file` parts through this same call-shape — mapped to media events via
 * the injected FilePartMapper. Every call pins the ZDR routing block via the
 * shared `languageRoutingOptions()` and reads the authoritative inline
 * `providerMetadata.openrouter.usage.cost` off each step and the finish.
 */
interface CreateLanguageAdapterOptions {
  readonly apiKey: string;
  /**
   * The cassette/fixture seam — tests inject a wrapped fetch here so calls
   * record/replay uniformly. Production omits it and the SDK uses
   * `globalThis.fetch`.
   */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * The first-class call settings the adapter can wire today. The
 * ParamSpec→wire compiler (catalog work) replaces this closed set; until
 * then an unknown key is rejected at the boundary, never dropped silently.
 */
const callParametersSchema = z.strictObject({
  maxOutputTokens: z.number().int().positive().optional(),
  temperature: z.number().optional(),
  topP: z.number().optional(),
  // The shared wire schema is composed, never re-typed: its strict
  // discriminated union makes `effort` + `max_tokens` together unparseable,
  // so an invalid pair is refused here instead of reaching the gateway.
  reasoning: ReasoningWire.optional(),
});

type CallParameters = z.infer<typeof callParametersSchema>;

function parseCallParameters(parameters: Record<string, unknown>): CallParameters {
  const parsed = callParametersSchema.safeParse(parameters);
  if (!parsed.success) {
    const keys = Object.keys(parameters).join(', ');
    throw invalidRequestError(`Unsupported inference parameters (keys: ${keys})`);
  }
  return parsed.data;
}

interface TextContentPart {
  type: 'text';
  text: string;
}

/**
 * Prior turns as wire messages, oldest first; the current turn is appended
 * after them. A future system prompt slots in ahead of this list without
 * touching the mapping. Absent history maps to [] — the request body is then
 * byte-identical to the pre-history adapter, keeping every recorded cassette
 * replayable.
 */
function toHistoryMessages(
  history: InferenceRequest['history']
): { role: 'user' | 'assistant'; content: string }[] {
  return (history ?? []).map((message) => ({ role: message.role, content: message.content }));
}

function toUserContent(inputs: InferenceRequest['inputs']): TextContentPart[] {
  return inputs.map((part) => {
    if (part.modality !== 'text') {
      // Media inputs ride by reference (ciphertext in R2); resolving them is
      // the engine's ValueStore seam, which lands with the catalog/domain
      // work — the adapter never holds storage access.
      throw invalidRequestError(`Unsupported input modality for language call: ${part.modality}`);
    }
    return { type: 'text', text: part.text };
  });
}

/**
 * An adapter-internal invariant break — a defect, never an expected
 * inference failure. Must escape the InferenceError channel: callers
 * translate InferenceError into typed domain failures, while a defect
 * propagates as an exception (500 + Sentry). The stream-loop catch rethrows
 * these instead of classifying them.
 */
export class AdapterDefect extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterDefect';
  }
}

const openrouterUsageMetadataSchema = z.looseObject({
  openrouter: z
    .looseObject({
      usage: z.looseObject({ cost: z.number().nullish() }).nullish(),
      provider: z.string().nullish(),
    })
    .nullish(),
});

/**
 * Pull the authoritative inline `openrouter.usage.cost` (USD) off a step's
 * provider metadata. Absent (or malformed) means the step reported no inline
 * cost — settlement falls back to the estimate; it is never a failure here.
 */
export function extractStepCost(metadata?: unknown): number | undefined {
  if (metadata === undefined || metadata === null) return undefined;
  const parsed = openrouterUsageMetadataSchema.safeParse(metadata);
  if (!parsed.success) return undefined;
  const cost = parsed.data.openrouter?.usage?.cost;
  return typeof cost === 'number' ? cost : undefined;
}

/** The endpoint that served a step, as OpenRouter names it on the stream's chunks. */
function extractServedBy(metadata: unknown): string | undefined {
  const parsed = openrouterUsageMetadataSchema.safeParse(metadata);
  return parsed.success ? (parsed.data.openrouter?.provider ?? undefined) : undefined;
}

/** A step's usage, only when the step reported both of its token counts. */
function stepUsageOf(usage: LanguageModelUsage): Usage | undefined {
  if (usage.inputTokens === undefined || usage.outputTokens === undefined) return undefined;
  return mapUsage(usage);
}

function mapUsage(usage: LanguageModelUsage): Usage {
  const reasoningTokens = usage.outputTokenDetails.reasoningTokens;
  const cachedInputTokens = usage.inputTokenDetails.cacheReadTokens;
  return {
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

/** The cancellation a tool receives when its loop runs with no signal: one that never aborts. */
const NEVER_ABORTED = new AbortController().signal;

/**
 * Every tool is client-executed: its `execute` runs inside the SDK's loop with
 * the SDK's abort signal. A call the budget does not admit is refused with a
 * {@link ToolCallLimitError} before the definition's `execute` is reached.
 */
export function buildToolset(
  registry: ToolSelection,
  admits: (toolCallId: string) => boolean
): ToolSet {
  const tools: ToolSet = {};
  for (const [name, definition] of Object.entries(registry)) {
    tools[name] = tool({
      description: definition.description,
      inputSchema: definition.inputSchema,
      execute: (input: unknown, { toolCallId, abortSignal }) =>
        admits(toolCallId)
          ? definition.execute(input, { signal: abortSignal ?? NEVER_ABORTED })
          : Promise.reject(new ToolCallLimitError()),
    });
  }
  return tools;
}

/**
 * Every tool call the model emits in one inference, in emission order, so a
 * call's index is its ordinal. It is filled from the raw model stream: the SDK
 * parses a step's calls and runs their `execute`s only after that stream has
 * carried all of them, so each call's ordinal is fixed before any of its step's
 * tools run.
 */
interface CallLedger {
  readonly budget: number;
  readonly ids: string[];
  /** Where the latest model call's tool calls begin in `ids`. */
  latestModelCallStart: number;
}

/** The latest model call's tool calls whose ordinal is at or past the budget. */
function latestCallsPastBudget(ledger: CallLedger): ReadonlySet<string> {
  return new Set(ledger.ids.slice(Math.max(ledger.latestModelCallStart, ledger.budget)));
}

/**
 * Whether one of the latest model call's tool calls is within the budget. A
 * call the ledger never saw is not admitted, so an unexpected SDK ordering
 * fails closed.
 */
function admitsCall(ledger: CallLedger, toolCallId: string): boolean {
  return ledger.ids.slice(ledger.latestModelCallStart, ledger.budget).includes(toolCallId);
}

type WrapStream = NonNullable<LanguageModelMiddleware['wrapStream']>;
type RawStreamResult = Awaited<ReturnType<Parameters<WrapStream>[0]['doStream']>>;
type RawStreamPart = RawStreamResult['stream'] extends ReadableStream<infer Part> ? Part : never;

/** Records each model call's raw `tool-call` chunks into the ledger as they stream. */
function ledgerMiddleware(ledger: CallLedger): LanguageModelMiddleware {
  return {
    wrapStream: async ({ doStream }) => {
      const result = await doStream();
      ledger.latestModelCallStart = ledger.ids.length;
      return {
        ...result,
        stream: result.stream.pipeThrough(
          new TransformStream<RawStreamPart, RawStreamPart>({
            transform(part, controller): void {
              if (part.type === 'tool-call') ledger.ids.push(part.toolCallId);
              controller.enqueue(part);
            },
          })
        ),
      };
    },
  };
}

/**
 * What each errored call of a step failed with: the first error the step
 * records for the call. An invalid call carries the SDK's error on its
 * `tool-call`, ahead of a `tool-error` that holds only the SDK's message; a call
 * whose `execute` threw carries the thrown error on its `tool-error`.
 */
function stepErrorCauses(step: StepResult<ToolSet>): ReadonlyMap<string, unknown> {
  const causes = new Map<string, unknown>();
  for (const part of step.content) {
    if ('error' in part && 'toolCallId' in part && !causes.has(part.toolCallId)) {
      causes.set(part.toolCallId, part.error);
    }
  }
  return causes;
}

/** A tool-result part as the next step sends it: an error carries only its reason code. */
function resendResult(part: ToolResultPart, causes: ReadonlyMap<string, unknown>): ToolResultPart {
  if (part.output.type !== 'error-text' && part.output.type !== 'error-json') return part;
  return {
    ...part,
    output: { type: 'error-text', value: toolErrorReason(causes.get(part.toolCallId)) },
  };
}

/** An assistant message without its calls past the budget; nothing when none of it is left. */
function resendAssistant(
  message: AssistantModelMessage,
  pastBudget: ReadonlySet<string>
): ModelMessage[] {
  if (typeof message.content === 'string') return [message];
  const content = message.content.filter(
    (part) => part.type !== 'tool-call' || !pastBudget.has(part.toolCallId)
  );
  return content.length === 0 ? [] : [{ ...message, content }];
}

/** A tool message without the results of calls past the budget, its errors as reason codes. */
function resendTool(
  message: ToolModelMessage,
  pastBudget: ReadonlySet<string>,
  causes: ReadonlyMap<string, unknown>
): ModelMessage[] {
  const content = message.content
    .filter((part) => part.type !== 'tool-result' || !pastBudget.has(part.toolCallId))
    .map((part) => (part.type === 'tool-result' ? resendResult(part, causes) : part));
  return content.length === 0 ? [] : [{ ...message, content }];
}

/**
 * One step's response messages as the next step sends them: calls past the
 * budget are dropped with their results, and every remaining error result
 * carries only its reason code, never the SDK's or the tool's error text. A
 * message left with no content is dropped.
 */
function rewriteAppended(
  appended: readonly ModelMessage[],
  pastBudget: ReadonlySet<string>,
  causes: ReadonlyMap<string, unknown>
): ModelMessage[] {
  return appended.flatMap((message) => {
    if (message.role === 'assistant') return resendAssistant(message, pastBudget);
    if (message.role === 'tool') return resendTool(message, pastBudget, causes);
    return [message];
  });
}

const utf8 = new TextEncoder();

/** An upper bound on the tokens of a value's serialized text: a token spans at least one byte. */
function tokenBound(value: unknown): number {
  return utf8.encode(JSON.stringify(value)).byteLength;
}

function contextExhaustedError(): InferenceError {
  return new InferenceError(
    'context_length',
    'The tool loop left too little of the context window for an answer'
  );
}

interface ToolLoopPlan {
  readonly loop: ToolLoopOptions;
  readonly ledger: CallLedger;
  /** The model's context window, in tokens. */
  readonly contextWindow: number;
  /** Every step's output ceiling, in tokens. */
  readonly stepCeiling: number;
  readonly system: string | undefined;
  /** Set once the guard makes a step the final answer, so the loop stops after it. */
  readonly guard: { tripped: boolean };
}

/** Everything a step sends, bounded: its system prompt, its messages and its tool definitions. */
function wholeRequestBound(plan: ToolLoopPlan, messages: readonly ModelMessage[]): number {
  const tools = Object.entries(plan.loop.registry).map(([name, definition]) => ({
    name,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.inputSchema, { unrepresentable: 'any' }),
  }));
  return tokenBound({ system: plan.system, messages, tools });
}

/**
 * Before each step: the history rewrite, the tool-free steps and the
 * context-window guard. The final step the stop condition allows is tool-free
 * on its own terms, not only because a budget of steps minus one is spent by
 * then, so the rule holds whatever budget a node is given. From the second step
 * on, the step's input is its predecessor's reported input plus what that step
 * appended, or the whole request when none was reported; either is never low.
 * A step whose input plus its ceiling would overrun the window becomes the
 * final, tool-free answer at the room left, and the loop stops after it; with no
 * room left the inference fails.
 */
function prepareLoopStep(plan: ToolLoopPlan): PrepareStepFunction<ToolSet> {
  const { loop, ledger } = plan;
  return ({ stepNumber, steps, messages }): PrepareStepResult<ToolSet> => {
    const toolsOff = stepNumber === loop.maxSteps - 1 || ledger.ids.length >= ledger.budget;
    const previous = steps.at(-1);
    if (previous === undefined) return toolsOff ? { activeTools: [] } : undefined;
    const kept = messages.length - previous.response.messages.length;
    const appended = rewriteAppended(
      messages.slice(kept),
      latestCallsPastBudget(ledger),
      stepErrorCauses(previous)
    );
    const rewritten = [...messages.slice(0, kept), ...appended];
    const reported = previous.usage.inputTokens;
    const input =
      reported === undefined ? wholeRequestBound(plan, rewritten) : reported + tokenBound(appended);
    const room = plan.contextWindow - input;
    if (room >= plan.stepCeiling) {
      return { messages: rewritten, ...(toolsOff ? { activeTools: [] } : {}) };
    }
    // No minimum-answer floor: that constant is the money layer's, and a reasoning
    // wire here names an effort, not the token budget such a floor would add to.
    if (room < 1) throw contextExhaustedError();
    plan.guard.tripped = true;
    return { messages: rewritten, activeTools: [], maxOutputTokens: room };
  };
}

interface ToolLoopRun {
  readonly middleware: LanguageModelMiddleware;
  readonly settings: {
    readonly tools: ToolSet;
    readonly stopWhen: StopCondition<ToolSet>[];
    readonly prepareStep: PrepareStepFunction<ToolSet>;
  };
}

/**
 * A tool loop runs only where it can be bounded: it needs the model's context
 * window for the guard and a per-step output ceiling, which is what the hold
 * prices every step at. A call with no tools has no loop.
 */
function planToolLoop(
  loop: ToolLoopOptions | undefined,
  parameters: CallParameters,
  descriptor: ModelDescriptor,
  system: string | undefined
): ToolLoopRun | undefined {
  if (loop === undefined) return undefined;
  const contextWindow = descriptor.limits['contextLength'];
  const stepCeiling = parameters.maxOutputTokens;
  if (contextWindow === undefined || stepCeiling === undefined) {
    throw invalidRequestError(
      'A tool loop needs the model context window and a per-step output ceiling'
    );
  }
  const ledger: CallLedger = {
    budget: toolCallsOfSteps(loop.maxSteps),
    ids: [],
    latestModelCallStart: 0,
  };
  const guard = { tripped: false };
  return {
    middleware: ledgerMiddleware(ledger),
    settings: {
      tools: buildToolset(loop.registry, (toolCallId) => admitsCall(ledger, toolCallId)),
      stopWhen: [stepCountIs(loop.maxSteps), (): boolean => guard.tripped],
      prepareStep: prepareLoopStep({ loop, ledger, contextWindow, stepCeiling, system, guard }),
    },
  };
}

/** Per-kind slot indices: each distinct SDK stream id gets the next index. */
function indexFor(ids: Map<string, number>, id: string): number {
  const existing = ids.get(id);
  if (existing !== undefined) return existing;
  const assigned = ids.size;
  ids.set(id, assigned);
  return assigned;
}

interface StreamState {
  sawText: boolean;
  sawMedia: boolean;
  /**
   * A tool call that ended without a result is recoverable until turn end: the
   * model can answer on a later step. Only its reason is held, never its error
   * text, and it surfaces only if the turn ends empty.
   */
  toolErrorReason: ToolErrorReason | undefined;
  /** The SDK's error on each invalid call, whose `tool-error` carries only a message. */
  invalidCallErrors: Map<string, unknown>;
  finishPart: { finishReason: FinishReason; totalUsage: LanguageModelUsage } | undefined;
  stepGenerationIds: string[];
  /** Run total of the per-step inline costs; the terminal finish carries the sum. */
  totalCostUsd: number;
  sawCost: boolean;
  step: number;
  textIds: Map<string, number>;
  reasoningIds: Map<string, number>;
  fileIndex: number;
}

function mapTextDelta(part: { id: string; text: string }, state: StreamState): InferenceEvent[] {
  if (part.text.length === 0) return [];
  state.sawText = true;
  return [{ kind: 'text-delta', index: indexFor(state.textIds, part.id), content: part.text }];
}

function mapReasoningDelta(
  part: { id: string; text: string },
  state: StreamState
): InferenceEvent[] {
  if (part.text.length === 0) return [];
  return [
    { kind: 'reasoning-delta', index: indexFor(state.reasoningIds, part.id), content: part.text },
  ];
}

function mapToolCall(
  part: {
    toolCallId: string;
    toolName: string;
    input: unknown;
    invalid?: boolean | undefined;
    error?: unknown;
  },
  state: StreamState
): InferenceEvent[] {
  if (part.invalid === true) state.invalidCallErrors.set(part.toolCallId, part.error);
  return [{ kind: 'tool-call', id: part.toolCallId, name: part.toolName, args: part.input }];
}

/** A call that produced no result, as its reason alone; an aborted run emits nothing. */
function mapToolError(
  part: { toolCallId: string; toolName: string; error: unknown },
  state: StreamState,
  signal: AbortSignal | undefined
): InferenceEvent[] {
  const cause = state.invalidCallErrors.has(part.toolCallId)
    ? state.invalidCallErrors.get(part.toolCallId)
    : part.error;
  const reason = toolErrorReason(cause, signal);
  if (reason === undefined) return [];
  state.toolErrorReason = reason;
  return [{ kind: 'tool-error', id: part.toolCallId, name: part.toolName, reason }];
}

function mapToolResult(part: {
  toolCallId: string;
  toolName: string;
  output: unknown;
}): InferenceEvent[] {
  return [{ kind: 'tool-result', id: part.toolCallId, name: part.toolName, result: part.output }];
}

function mapFile(
  file: { mediaType: string; uint8Array: Uint8Array },
  state: StreamState,
  mapFilePart: FilePartMapper | undefined
): InferenceEvent[] {
  if (mapFilePart === undefined) {
    // Defect, not an expected failure: the caller invoked a multi-output
    // model without supplying the FilePartMapper contract.
    throw new AdapterDefect('language adapter: file part received without a mapFilePart contract');
  }
  state.sawMedia = true;
  const index = state.fileIndex;
  state.fileIndex += 1;
  // The SDK types GeneratedFile bytes as Uint8Array<ArrayBufferLike> but
  // constructs them from plain buffers (base64/binary payloads), never
  // SharedArrayBuffer-backed views — the narrowing is safe and zero-copy.
  const [start, done] = mapFilePart(
    { mediaType: file.mediaType, data: file.uint8Array as Uint8Array<ArrayBuffer> },
    index
  );
  return [start, done];
}

function mapStepStart(state: StreamState): InferenceEvent[] {
  state.step += 1;
  return [{ kind: 'step-start', step: state.step }];
}

function mapStepFinish(
  part: { response: { id: string }; providerMetadata: unknown; usage: LanguageModelUsage },
  state: StreamState
): InferenceEvent[] {
  // OpenRouter's `gen-…` id rides the response metadata as `response.id` (its
  // chat providerMetadata carries no generation id); the SDK guarantees it is
  // present. The inline per-step cost rides `providerMetadata.openrouter.usage`.
  const generationId = part.response.id;
  state.stepGenerationIds.push(generationId);
  const cost = extractStepCost(part.providerMetadata);
  if (cost !== undefined) {
    state.totalCostUsd += cost;
    state.sawCost = true;
  }
  const usage = stepUsageOf(part.usage);
  const servedBy = extractServedBy(part.providerMetadata);
  return [
    {
      kind: 'step-finish',
      step: state.step,
      generationId,
      ...(cost === undefined ? {} : { providerCostUsd: cost }),
      ...(usage === undefined ? {} : { usage }),
      ...(servedBy === undefined ? {} : { servedBy }),
    },
  ];
}

export function mapPart(
  part: TextStreamPart<ToolSet>,
  state: StreamState,
  mapFilePart: FilePartMapper | undefined,
  signal?: AbortSignal
): InferenceEvent[] {
  return (
    match(part)
      .with({ type: 'text-delta' }, (p) => mapTextDelta(p, state))
      .with({ type: 'reasoning-delta' }, (p) => mapReasoningDelta(p, state))
      .with({ type: 'tool-call' }, (p) => mapToolCall(p, state))
      .with({ type: 'tool-result' }, (p) => mapToolResult(p))
      .with({ type: 'tool-error' }, (p) => mapToolError(p, state, signal))
      .with({ type: 'file' }, (p) => mapFile(p.file, state, mapFilePart))
      .with({ type: 'start-step' }, () => mapStepStart(state))
      .with({ type: 'finish-step' }, (p) => mapStepFinish(p, state))
      .with({ type: 'finish' }, (p): InferenceEvent[] => {
        state.finishPart = { finishReason: p.finishReason, totalUsage: p.totalUsage };
        return [];
      })
      .with({ type: 'error' }, (p) => {
        throw classifyInferenceFailure(p.error);
      })
      .with({ type: 'abort' }, (p) => {
        throw abortedError(p.reason);
      })
      // Deliberately unmapped — no InferenceEvent leaves the adapter:
      // start / text-start / text-end / reasoning-start / reasoning-end are
      // lifecycle markers (the deltas carry the content; slot indices come
      // from part ids); tool-input-start/delta/end stream the input the
      // terminal tool-call part already carries whole; source / raw / custom
      // carry no content or billing payload the port models; tool-output-denied
      // / tool-approval-request / tool-approval-response belong to the SDK's
      // tool-approval flow — ToolDefinition exposes no approval contract, so
      // nothing upstream could answer one; reasoning-file carries a file on the
      // reasoning path, where this port carries text alone, so mapping it to a
      // media event would put an artifact in front of the user that no product
      // surface asks for. `.exhaustive()` makes any future SDK part kind a
      // compile error here instead of a silent swallow.
      .with(
        {
          type: P.union(
            'start',
            'text-start',
            'text-end',
            'reasoning-start',
            'reasoning-end',
            'tool-input-start',
            'tool-input-delta',
            'tool-input-end',
            'source',
            'raw',
            'custom',
            'tool-output-denied',
            'tool-approval-request',
            'tool-approval-response',
            'reasoning-file'
          ),
        },
        (): InferenceEvent[] => []
      )
      .exhaustive()
  );
}

/**
 * An empty turn after a tool call ended without a result. The message names the
 * reason alone: the SDK's error text can quote the model's arguments.
 */
function unrecoveredToolError(reason: ToolErrorReason): InferenceError {
  return new InferenceError(
    'upstream_error',
    `Model produced no output after a tool call ended without a result (reason: ${reason})`
  );
}

/**
 * Terminal decision table for a turn that produced no visible output: an
 * unrecovered tool error surfaces by its reason alone; an empty `length`
 * finish is BILLABLE TRUNCATION — a valid terminal state the caller persists
 * and charges — so it falls through to the finish event; anything else
 * (tool-call exhaustion, content filter, bare stop) is an empty completion.
 */
function throwForEmptyTurn(state: StreamState, finishReason: FinishReason): void {
  if (state.sawText || state.sawMedia) return;
  if (state.toolErrorReason !== undefined) throw unrecoveredToolError(state.toolErrorReason);
  if (finishReason === 'length') return;
  throw emptyCompletionError(finishReason);
}

interface InferStreamInput {
  provider: OpenRouterProvider;
  request: InferenceRequest;
  descriptor: ModelDescriptor;
  options: InferOptions;
}

function noopOnError(): void {
  // deliberate: see the onError comment at the streamText call
}

interface OptionalCallSettings {
  abortSignal?: AbortSignal;
  maxOutputTokens?: number;
  temperature?: number;
  topP?: number;
  providerOptions?: { openrouter: { reasoning: ReasoningWire } };
}

/** Conditional spreads so an absent option never lands as an explicit undefined. */
function callSettingsFor(parameters: CallParameters, options: InferOptions): OptionalCallSettings {
  return {
    ...(options.signal === undefined ? {} : { abortSignal: options.signal }),
    ...(parameters.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: parameters.maxOutputTokens }),
    ...(parameters.temperature === undefined ? {} : { temperature: parameters.temperature }),
    ...(parameters.topP === undefined ? {} : { topP: parameters.topP }),
    // Call-level `providerOptions.openrouter` spreads OVER the model-settings
    // args in the provider's doStream, so this is the reasoning config's
    // authoritative wire path.
    ...(parameters.reasoning === undefined
      ? {}
      : { providerOptions: { openrouter: { reasoning: parameters.reasoning } } }),
  };
}

/**
 * The stream-loop failure disposition: adapter defects stay exceptions;
 * everything else classifies to a typed InferenceError. With the
 * require-parameters routing guard pinned on reasoning calls, a no-providers
 * refusal on one means the reasoning config itself narrowed the endpoint
 * pool to zero — re-typed so callers can render a targeted next action.
 */
function streamFailure(error: unknown, parameters: CallParameters): Error {
  if (error instanceof AdapterDefect) return error;
  const classified = classifyInferenceFailure(error);
  if (classified.code === 'no_providers_available' && parameters.reasoning !== undefined) {
    return noReasoningEndpointsError(classified);
  }
  return classified;
}

/**
 * The turn's system prompt, or none at all.
 *
 * The server-owned base preamble rides every ANSWER turn (paid and trial), and
 * client custom instructions fold into it. A ROUTING-ONLY call carries no
 * preamble: its own prompt is the whole instruction, and its reserve prices
 * exactly that — the preamble would be input no reservation covered.
 *
 * This is the only place client custom instructions enter a provider request,
 * so a call shape that sends no system prompt carries none — media generation
 * included, by decision rather than omission.
 */
function systemPromptFor(request: InferenceRequest): string | undefined {
  if (request.routingOnly === true) return undefined;
  return buildTurnSystemPrompt({
    utcDay: request.utcDay,
    ...(request.customInstructions === undefined
      ? {}
      : { customInstructions: request.customInstructions }),
  });
}

/**
 * `.chat()` (not the callable `openrouter(model)`, whose overloads infer the
 * completion model). The routing settings pin ZDR + no-collection +
 * no-fallbacks and enable inline usage/cost accounting; a reasoning call
 * additionally pins the require-parameters routing guard so an endpoint can
 * never silently drop the reasoning config. A tool loop's model counts its
 * calls as they stream.
 */
function chatModelFor(
  provider: OpenRouterProvider,
  request: InferenceRequest,
  parameters: CallParameters,
  toolLoop: ToolLoopRun | undefined
): LanguageModel {
  const model = provider.chat(
    request.model,
    languageRoutingOptions({ reasoning: parameters.reasoning !== undefined })
  );
  return toolLoop === undefined
    ? model
    : wrapLanguageModel({ model, middleware: toolLoop.middleware });
}

async function* inferLanguage(input: InferStreamInput): AsyncGenerator<InferenceEvent> {
  const { provider, request, descriptor, options } = input;
  const parameters = parseCallParameters(request.parameters);
  const content = toUserContent(request.inputs);

  const system = systemPromptFor(request);
  const toolLoop = planToolLoop(options.tools, parameters, descriptor, system);

  const result = streamText({
    model: chatModelFor(provider, request, parameters, toolLoop),
    ...(system === undefined ? {} : { system }),
    messages: [...toHistoryMessages(request.history), { role: 'user', content }],
    // The SDK's own retry is off: its RetryError buries the provider error in
    // an array the classifier cannot chain-walk.
    maxRetries: 0,
    // The SDK's default onError is console.error; errors already reach the
    // caller as typed throws from the stream loop, and raw console output
    // is banned (telemetry rides the SafeLogFields logger).
    onError: noopOnError,
    ...callSettingsFor(parameters, options),
    ...toolLoop?.settings,
  });

  const state: StreamState = {
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

  // The SDK surfaces stream and tool failures as data parts on the stream
  // rather than throwing; anything thrown by iteration itself is classified
  // the same way — except adapter defects, which must stay exceptions rather
  // than masquerade as expected upstream failures.
  try {
    for await (const part of result.stream) {
      yield* mapPart(part, state, options.mapFilePart, options.signal);
    }
  } catch (error) {
    throw streamFailure(error, parameters);
  }

  const finishPart = state.finishPart;
  if (finishPart === undefined) throw truncatedStreamError();
  throwForEmptyTurn(state, finishPart.finishReason);

  // Single-step runs carry the generationId on the terminal finish; on
  // multi-step runs each step-finish already carried its own. The terminal
  // cost is the sum of the per-step inline costs — the run's billing truth.
  const generationId =
    state.stepGenerationIds.length === 1 ? state.stepGenerationIds[0] : undefined;
  const providerCostUsd = state.sawCost ? state.totalCostUsd : undefined;
  yield {
    kind: 'finish',
    metadata: {
      ...(generationId === undefined ? {} : { generationId }),
      ...(providerCostUsd === undefined ? {} : { providerCostUsd }),
      usage: mapUsage(finishPart.totalUsage),
      finishReason: finishPart.finishReason,
    },
  };
}

export function createLanguageAdapter(options: CreateLanguageAdapterOptions): ModelProvider {
  const provider = createOpenRouterProvider(options);

  return {
    infer(
      request: InferenceRequest,
      descriptor: ModelDescriptor,
      inferOptions: InferOptions = {}
    ): AsyncIterable<InferenceEvent> {
      validateInferenceCall(request, descriptor);
      return inferLanguage({ provider, request, descriptor, options: inferOptions });
    },
  };
}
