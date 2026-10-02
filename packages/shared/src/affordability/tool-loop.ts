/**
 * The one home of a model's tool loop: which tools exist and what each declares,
 * how many tool calls a turn may make at each effort rung, how steps relate to
 * calls, and the bound the shared estimator expands into a loop's price. The
 * browser and the server both read it, so a hold, a preview and a charge cannot
 * disagree about a loop.
 *
 * It declares no price and bakes no fee: every money figure it carries is an
 * after-fee rate read from the tool fee seam.
 */

import { z } from 'zod';

import { SEGMENT_SPECS } from '../assistant-text/segments.ts';
import {
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  WebSearchQuery,
} from '../web-search/web-search-contract.ts';
import { EFFORT_OPTION_IDS } from './dimensions/effort.ts';
import { toolCallBillableNano } from './estimate/tool-pricing.ts';
import { inputTokensOf } from './price/quantities.ts';
import type { SegmentKind } from '../assistant-text/segments.ts';
import type { ResolvedReasoningEffort } from './reasoning-effort.ts';

export const TOOL_NAMES = [WEB_SEARCH_TOOL_NAME] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

const TOOL_NAME_SET: ReadonlySet<string> = new Set(TOOL_NAMES);

export function isToolName(name: string): name is ToolName {
  return TOOL_NAME_SET.has(name);
}

/**
 * The largest serialized web-search result the hold reserves for. The search
 * adapter's field limits keep every ordinary payload within it; a payload that
 * still exceeds it is returned whole and alerted on, never cut.
 */
export const WEB_SEARCH_RESULT_MAX_CHARS = 6000;

/**
 * The tool-use system prompt reserved on every tool-carrying step, in tokens:
 * Anthropic's documented figure for Claude Sonnet 4.5 under `tool_choice`
 * `auto`, taken for every model family.
 */
export const TOOL_USE_SYSTEM_PROMPT_TOKENS = 496;

interface ToolDefinitionText {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
}

/**
 * The characters of a tool's definition: its name, its description and its
 * input's JSON Schema, serialized.
 */
export function toolDefinitionChars(definition: ToolDefinitionText): number {
  return JSON.stringify({
    name: definition.name,
    description: definition.description,
    inputSchema: z.toJSONSchema(definition.inputSchema, { unrepresentable: 'any' }),
  }).length;
}

interface ToolDeclaration {
  /** The largest result the tool returns to the model, in characters. */
  readonly resultMaxChars: number;
  /** The segment kind that stores the tool's record in the answer text. */
  readonly recordKind: SegmentKind;
  /** The characters of the tool's definition, which every tool-carrying step sends. */
  readonly definitionChars: number;
}

export const TOOL_DECLARATIONS: Readonly<Record<ToolName, ToolDeclaration>> = {
  [WEB_SEARCH_TOOL_NAME]: {
    resultMaxChars: WEB_SEARCH_RESULT_MAX_CHARS,
    recordKind: 'webSearch',
    definitionChars: toolDefinitionChars({
      name: WEB_SEARCH_TOOL_NAME,
      description: WEB_SEARCH_TOOL_DESCRIPTION,
      inputSchema: WebSearchQuery,
    }),
  },
};

const TOOL_CALL_CAP_FLOOR = 2;
const TOOL_CALL_CAP_CEILING = 10;

/**
 * The cap at one position of an ascending ladder `length` rungs long: linear
 * from the floor at the bottom rung to the ceiling at the top, rounded half up
 * in integers. A one-rung ladder takes the ceiling.
 */
function toolCallCapAt(position: number, length: number): number {
  const top = length - 1;
  if (top < 1) return TOOL_CALL_CAP_CEILING;
  const span = TOOL_CALL_CAP_CEILING - TOOL_CALL_CAP_FLOOR;
  return TOOL_CALL_CAP_FLOOR + Math.floor((2 * span * position + top) / (2 * top));
}

/**
 * The cap at every rung of an ascending ladder. It reads only each rung's
 * position, so a rung added to the effort ladder re-spreads the caps with no
 * edit here.
 */
export function toolCallCapsOver(domain: readonly string[]): readonly number[] {
  return domain.map((_rung, position) => toolCallCapAt(position, domain.length));
}

/**
 * How many tool calls, across all tools together, a turn at `effort` may make.
 * A turn with no reasoning ladder (`undefined`) has no effort control at all and
 * takes the ceiling.
 */
export function toolCallCapFor(effort?: ResolvedReasoningEffort): number {
  if (effort === undefined) return TOOL_CALL_CAP_CEILING;
  return toolCallCapAt(EFFORT_OPTION_IDS.indexOf(effort), EFFORT_OPTION_IDS.length);
}

/** The most tool calls any turn may make: the cap's maximum over every rung and none. */
export const TOOL_CALL_CAP_MAX: number = Math.max(
  toolCallCapFor(),
  ...EFFORT_OPTION_IDS.map((effort) => toolCallCapFor(effort))
);

/**
 * The steps a loop of `calls` tool calls takes: one per call and a final,
 * tool-free answering step.
 */
export function toolLoopStepsFor(calls: number): number {
  if (!Number.isSafeInteger(calls) || calls < 0) {
    throw new RangeError('toolLoopStepsFor: calls must be a non-negative integer');
  }
  return calls + 1;
}

/** The tool calls a node declaring `steps` may make; the inverse of {@link toolLoopStepsFor}. */
export function toolCallsOfSteps(steps: number): number {
  if (!Number.isSafeInteger(steps) || steps < 1) {
    throw new RangeError('toolCallsOfSteps: steps must be a positive integer');
  }
  return steps - 1;
}

/** A declared loop narrowed to the rung a classifier decided: never longer than declared. */
export function carveToolLoopSteps(
  declaredSteps: number,
  decidedEffort: ResolvedReasoningEffort | undefined
): number {
  return Math.min(declaredSteps, toolLoopStepsFor(toolCallCapFor(decidedEffort)));
}

declare const toolLoopBoundBrand: unique symbol;

/**
 * The facts the estimator prices a tool loop from. Branded: {@link toolLoopBound}
 * is its only mint, so no consumer can hand-build a loop.
 */
export interface ToolLoopBound {
  readonly steps: number;
  readonly calls: number;
  /** The largest result any of the tools returns, in input tokens. */
  readonly resultTokens: number;
  /** The largest after-fee per-call rate any of the tools charges. */
  readonly callFeeNano: bigint;
  /** The storage allowance of the tools' record kinds, each kind counted once. */
  readonly recordStorageChars: number;
  /**
   * The input one tool-carrying step is estimated to add, in tokens: the
   * tool-use system prompt and the definitions of the distinct tools.
   */
  readonly overheadTokens: number;
  readonly [toolLoopBoundBrand]: true;
}

/**
 * The bound of a loop of `calls` calls over `tools`. The result size and the fee
 * are each the largest over the tools, because any call may go to any of them.
 */
export function toolLoopBound(tools: readonly ToolName[], calls: number): ToolLoopBound {
  if (tools.length === 0) {
    throw new RangeError('toolLoopBound: a tool loop needs at least one tool');
  }
  if (!Number.isSafeInteger(calls) || calls < 1 || calls > TOOL_CALL_CAP_MAX) {
    throw new RangeError('toolLoopBound: calls must be an integer from 1 to the tool-call cap');
  }
  let resultTokens = 0;
  let callFeeNano = 0n;
  const recordKinds = new Set<SegmentKind>();
  for (const tool of tools) {
    const declaration = TOOL_DECLARATIONS[tool];
    resultTokens = Math.max(resultTokens, inputTokensOf(declaration.resultMaxChars));
    const fee = toolCallBillableNano(tool);
    if (fee > callFeeNano) callFeeNano = fee;
    recordKinds.add(declaration.recordKind);
  }
  let recordStorageChars = 0;
  for (const kind of recordKinds) recordStorageChars += SEGMENT_SPECS[kind].storageAllowanceChars;
  let definitionChars = 0;
  for (const tool of new Set(tools)) definitionChars += TOOL_DECLARATIONS[tool].definitionChars;
  const bound = {
    steps: toolLoopStepsFor(calls),
    calls,
    resultTokens,
    callFeeNano,
    recordStorageChars,
    overheadTokens: TOOL_USE_SYSTEM_PROMPT_TOKENS + inputTokensOf(definitionChars),
  };
  return bound as ToolLoopBound;
}

/**
 * What `calls` calls of `tool` charge: the after-fee rate per call. The count is
 * bounded by the cap, so a charge can never exceed what any hold reserved.
 */
export function toolCallChargeNanoUsd(tool: ToolName, calls: number): bigint {
  if (!Number.isSafeInteger(calls) || calls < 0 || calls > TOOL_CALL_CAP_MAX) {
    throw new RangeError('toolCallChargeNanoUsd: calls must be an integer from 0 to the cap');
  }
  return BigInt(calls) * toolCallBillableNano(tool);
}
