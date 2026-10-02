/**
 * The text line items of calls priced step by step: each step's input and
 * output at that step's own rates, input, output and framing storage, and a
 * call's tool loop when it carries one. It applies NO fee math (rates arrive
 * billable from the catalog, and a tool's per-call rate arrives after-fee in
 * its loop bound) and does NO char→token conversion — the caller converts
 * before it builds the calls. The price core's cost curve is its caller, with
 * each step's tier rates.
 */

import { ASSISTANT_FRAMING_MAX_CHARS } from '../../assistant-text/grammar.ts';
import { charStorageNanoUsd } from './storage-rate.ts';
import { outputStorageNanoUsdPerToken } from '../price/quantities.ts';
import type { NanoLineItem } from './types.ts';
import type { ToolLoopBound } from '../tool-loop.ts';

/** Every leg of the text path, summed over the calls. */
interface TextLegs {
  promptEveryStep: bigint;
  outputEveryStep: bigint;
  outputStorageEveryStep: bigint;
  ownOutputResent: bigint;
  resultsResent: bigint;
  toolUseOverhead: bigint;
  toolCallFees: bigint;
  recordStorage: bigint;
  hasToolLoop: boolean;
}

/** One step's token rates, as a stepped call's builder reads them. */
export interface StepTokenRates {
  readonly input: bigint;
  readonly output: bigint;
}

/**
 * One call priced step by step: each step's rates, first step first, and the
 * loop that makes it more than one step. A call with no loop is one step.
 */
export interface SteppedCall {
  readonly stepRates: readonly StepTokenRates[];
  readonly toolLoop?: ToolLoopBound;
}

/** What one step sends beside the prompt, in tokens except the output count. */
export interface StepResentInput {
  /** How many earlier steps' outputs the step re-sends, each up to the output ceiling. */
  readonly earlierOutputs: number;
  readonly resultTokens: number;
  readonly overheadTokens: number;
}

/**
 * What step `step` of a call sends beside its prompt. A tool loop's step k
 * re-sends the k − 1 outputs before it, re-sends every call's result once any
 * call has run, and carries the tool-use overhead unless it is the final,
 * tool-free step. Each part is an upper bound under the loop's caps, and they
 * hold at once. A call with no loop has one step and sends only its prompt.
 */
export function stepResentInput(loop: ToolLoopBound | undefined, step: number): StepResentInput {
  const steps = loop?.steps ?? 1;
  if (!Number.isSafeInteger(step) || step < 1 || step > steps) {
    throw new RangeError('stepResentInput: step must be an integer from 1 to the call’s steps');
  }
  if (loop === undefined) return { earlierOutputs: 0, resultTokens: 0, overheadTokens: 0 };
  return {
    earlierOutputs: step - 1,
    resultTokens: step >= 2 ? loop.calls * loop.resultTokens : 0,
    overheadTokens: step <= steps - 1 ? loop.overheadTokens : 0,
  };
}

/**
 * One call's legs added into the running sums, each step's input priced at
 * that step's own input rate and its output at its own output rate. Every
 * step's output also reserves its stored characters at the stored-output
 * ratio, a reservation rather than a bound.
 */
function addCallLegs(
  legs: TextLegs,
  call: SteppedCall,
  promptTokens: bigint,
  storagePerToken: bigint
): TextLegs {
  const loop = call.toolLoop;
  if (call.stepRates.length !== (loop?.steps ?? 1)) {
    throw new RangeError('steppedCallLineItems: a call needs one rate pair per step');
  }
  const summed = { ...legs };
  for (const [index, rates] of call.stepRates.entries()) {
    const resent = stepResentInput(loop, index + 1);
    summed.promptEveryStep += promptTokens * rates.input;
    summed.outputEveryStep += rates.output;
    summed.outputStorageEveryStep += storagePerToken;
    summed.ownOutputResent += BigInt(resent.earlierOutputs) * rates.input;
    summed.resultsResent += BigInt(resent.resultTokens) * rates.input;
    summed.toolUseOverhead += BigInt(resent.overheadTokens) * rates.input;
  }
  if (loop === undefined) return summed;
  return {
    ...summed,
    toolCallFees: summed.toolCallFees + BigInt(loop.calls) * loop.callFeeNano,
    recordStorage: summed.recordStorage + charStorageNanoUsd(loop.recordStorageChars),
    hasToolLoop: true,
  };
}

/**
 * The tool-loop line items. The model's own re-sent output scales with the
 * output ceiling, so it rides the variable rate beside each step's output; the
 * re-sent results, the tool-use overhead, the fees and the stored records are
 * fixed.
 */
function toolLoopLineItems(legs: TextLegs): readonly NanoLineItem[] {
  if (!legs.hasToolLoop) return [];
  return [
    {
      label: 'tool-loop-output-resent',
      variableOutputRateNano: legs.ownOutputResent,
      kind: 'provider',
    },
    { label: 'tool-results-resent', fixedNano: legs.resultsResent, kind: 'provider' },
    { label: 'tool-use-overhead', fixedNano: legs.toolUseOverhead, kind: 'provider' },
    { label: 'tool-call-fees', fixedNano: legs.toolCallFees, kind: 'provider' },
    { label: 'tool-record-storage', fixedNano: legs.recordStorage, kind: 'storage' },
  ];
}

/**
 * The text line items of calls that each send `promptTokens`: every call's
 * legs summed, input storage once, and one framing allowance per answer: the
 * characters HushBox itself writes into a stored answer. The caller has
 * validated the counts.
 */
export function steppedCallLineItems(
  calls: readonly SteppedCall[],
  promptTokens: bigint,
  inputChars: number
): readonly NanoLineItem[] {
  const storagePerToken = outputStorageNanoUsdPerToken();
  let legs: TextLegs = {
    promptEveryStep: 0n,
    outputEveryStep: 0n,
    outputStorageEveryStep: 0n,
    ownOutputResent: 0n,
    resultsResent: 0n,
    toolUseOverhead: 0n,
    toolCallFees: 0n,
    recordStorage: 0n,
    hasToolLoop: false,
  };
  for (const call of calls) legs = addCallLegs(legs, call, promptTokens, storagePerToken);

  return [
    { label: 'text-input-tokens', fixedNano: legs.promptEveryStep, kind: 'provider' },
    { label: 'input-storage', fixedNano: charStorageNanoUsd(inputChars), kind: 'storage' },
    { label: 'text-output-tokens', variableOutputRateNano: legs.outputEveryStep, kind: 'provider' },
    {
      label: 'output-storage',
      variableOutputRateNano: legs.outputStorageEveryStep,
      kind: 'storage',
    },
    {
      label: 'framing-storage',
      fixedNano: charStorageNanoUsd(ASSISTANT_FRAMING_MAX_CHARS) * BigInt(calls.length),
      kind: 'storage',
    },
    ...toolLoopLineItems(legs),
  ];
}
