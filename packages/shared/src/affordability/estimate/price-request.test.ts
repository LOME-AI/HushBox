import { describe, expect, it } from 'vitest';

import { ASSISTANT_FRAMING_MAX_CHARS } from '../../assistant-text/grammar.ts';
import { STORAGE_COST_PER_CHARACTER_NANO } from './storage-rate.ts';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../../web-search/web-search-row.ts';
import { WEB_SEARCH_RESULT_MAX_CHARS, toolLoopBound } from '../tool-loop.ts';
import { stepResentInput, steppedCallLineItems } from './price-request.ts';
import { toolCallBillableNano } from './tool-pricing.ts';
import type { ToolLoopBound } from '../tool-loop.ts';
import type { SteppedCall } from './price-request.ts';
import type { NanoLineItem } from './types.ts';

function itemByLabel(items: readonly NanoLineItem[], label: string): NanoLineItem {
  const found = items.find((index) => index.label === label);
  if (!found) throw new Error(`no line item labelled ${label}`);
  return found;
}

/** One call at one input and output rate on every step of its loop, or its one step. */
function flatCall(input: bigint, output: bigint, toolLoop?: ToolLoopBound): SteppedCall {
  const stepRates = Array.from({ length: toolLoop?.steps ?? 1 }, () => ({ input, output }));
  return toolLoop === undefined ? { stepRates } : { stepRates, toolLoop };
}

/** The line items of `calls` over a 100-token prompt whose new message is 1,000 characters. */
function itemsOf(calls: readonly SteppedCall[]): readonly NanoLineItem[] {
  return steppedCallLineItems(calls, 100n, 1000);
}

const ONE_CALL = [flatCall(5n, 15n)];

const TWO_CALLS = [flatCall(5n, 15n), flatCall(2n, 8n)];

describe('steppedCallLineItems — calls at flat rates', () => {
  it('prices input tokens as a provider fixed item summed across models', () => {
    const input = itemByLabel(itemsOf(TWO_CALLS), 'text-input-tokens');
    // (5 + 2) input rate summed × 100 tokens
    expect(input.fixedNano).toBe(700n);
    expect(input.kind).toBe('provider');
  });

  it('prices output tokens as a provider variable rate summed across models', () => {
    const output = itemByLabel(itemsOf(TWO_CALLS), 'text-output-tokens');
    expect(output.variableOutputRateNano).toBe(23n);
    expect(output.kind).toBe('provider');
  });

  it('adds input storage as a pass-through storage fixed item', () => {
    const storage = itemByLabel(itemsOf(ONE_CALL), 'input-storage');
    expect(storage.fixedNano).toBe(1000n * STORAGE_COST_PER_CHARACTER_NANO);
    expect(storage.kind).toBe('storage');
  });

  it('adds output storage as a per-model pass-through variable rate at 5 chars per token', () => {
    const storage = itemByLabel(itemsOf(TWO_CALLS), 'output-storage');
    // 5 chars/token × 300 nano/char × 2 models
    expect(storage.variableOutputRateNano).toBe(5n * STORAGE_COST_PER_CHARACTER_NANO * 2n);
    expect(storage.kind).toBe('storage');
  });

  it('reserves the framing allowance as storage, once per answer', () => {
    const framing = itemByLabel(itemsOf(TWO_CALLS), 'framing-storage');
    expect(framing.fixedNano).toBe(
      2n * BigInt(ASSISTANT_FRAMING_MAX_CHARS) * STORAGE_COST_PER_CHARACTER_NANO
    );
    expect(framing.kind).toBe('storage');
  });

  it('handles a zero-length prompt with zero-cost fixed items', () => {
    const items = steppedCallLineItems(ONE_CALL, 0n, 0);
    expect(itemByLabel(items, 'text-input-tokens').fixedNano).toBe(0n);
    expect(itemByLabel(items, 'input-storage').fixedNano).toBe(0n);
  });

  it('applies no fee math — every amount is the billable rate as given', () => {
    const items = itemsOf(ONE_CALL);
    // input tokens: 5 × 100 = 500 exactly as given — no fee math applied
    expect(itemByLabel(items, 'text-input-tokens').fixedNano).toBe(500n);
    expect(itemByLabel(items, 'text-output-tokens').variableOutputRateNano).toBe(15n);
  });
});

describe('steppedCallLineItems — a tool loop', () => {
  const loopCalls = [flatCall(5n, 15n, toolLoopBound(['webSearch'], 10))];

  it('sends the prompt on every step of the loop', () => {
    expect(itemByLabel(itemsOf(loopCalls), 'text-input-tokens').fixedNano).toBe(11n * 100n * 5n);
  });

  it('prices every step’s output and its storage per output token', () => {
    const items = itemsOf(loopCalls);
    expect(itemByLabel(items, 'text-output-tokens').variableOutputRateNano).toBe(11n * 15n);
    expect(itemByLabel(items, 'output-storage').variableOutputRateNano).toBe(
      11n * 5n * STORAGE_COST_PER_CHARACTER_NANO
    );
  });

  it('prices the model’s own earlier output re-sent as input, per output token', () => {
    const resent = itemByLabel(itemsOf(loopCalls), 'tool-loop-output-resent');
    expect(resent.variableOutputRateNano).toBe(((11n * 10n) / 2n) * 5n);
    expect(resent.kind).toBe('provider');
  });

  it('prices every call’s result re-sent on every later step', () => {
    const resultTokens = BigInt(Math.ceil(WEB_SEARCH_RESULT_MAX_CHARS / 3));
    const resent = itemByLabel(itemsOf(loopCalls), 'tool-results-resent');
    expect(resent.fixedNano).toBe(10n * 10n * resultTokens * 5n);
    expect(resent.kind).toBe('provider');
  });

  it('prices every call at the tool’s after-fee rate', () => {
    const fees = itemByLabel(itemsOf(loopCalls), 'tool-call-fees');
    expect(fees.fixedNano).toBe(10n * toolCallBillableNano('webSearch'));
    expect(fees.kind).toBe('provider');
  });

  it('reserves storage for the tools’ stored records', () => {
    const records = itemByLabel(itemsOf(loopCalls), 'tool-record-storage');
    expect(records.fixedNano).toBe(
      BigInt(WEB_SEARCH_ROW_MAX_CHARS) * STORAGE_COST_PER_CHARACTER_NANO
    );
    expect(records.kind).toBe('storage');
  });

  it('reserves the tool-use overhead on every step but the tool-free answering step', () => {
    const bound = toolLoopBound(['webSearch'], 7);
    const overhead = itemByLabel(itemsOf([flatCall(5n, 15n, bound)]), 'tool-use-overhead');
    expect(overhead.fixedNano).toBe(7n * BigInt(bound.overheadTokens) * 5n);
    expect(overhead.kind).toBe('provider');
  });

  it('keeps input storage once however long the loop', () => {
    expect(itemByLabel(itemsOf(loopCalls), 'input-storage').fixedNano).toBe(
      1000n * STORAGE_COST_PER_CHARACTER_NANO
    );
  });

  it('prices a loop-free sibling at one step beside a looping one', () => {
    const items = itemsOf([...loopCalls, flatCall(2n, 8n)]);
    expect(itemByLabel(items, 'text-input-tokens').fixedNano).toBe(11n * 100n * 5n + 100n * 2n);
    expect(itemByLabel(items, 'text-output-tokens').variableOutputRateNano).toBe(11n * 15n + 8n);
    expect(itemByLabel(items, 'tool-call-fees').fixedNano).toBe(
      10n * toolCallBillableNano('webSearch')
    );
  });

  it('prices a request with no loop at exactly its per-call items plus framing', () => {
    expect(itemsOf(ONE_CALL).map((entry) => entry.label)).toEqual([
      'text-input-tokens',
      'input-storage',
      'text-output-tokens',
      'output-storage',
      'framing-storage',
    ]);
  });
});

describe('steppedCallLineItems — one call priced step by step', () => {
  const loop: ToolLoopBound = toolLoopBound(['webSearch'], 2);
  const stepRates = [
    { input: 10n, output: 100n },
    { input: 20n, output: 200n },
    { input: 30n, output: 300n },
  ];
  const items = steppedCallLineItems([{ stepRates, toolLoop: loop }], 100n, 0);

  it('sends the prompt on each step at that step’s input rate', () => {
    expect(itemByLabel(items, 'text-input-tokens').fixedNano).toBe(100n * (10n + 20n + 30n));
  });

  it('prices each step’s output at that step’s output rate', () => {
    expect(itemByLabel(items, 'text-output-tokens').variableOutputRateNano).toBe(600n);
  });

  it('prices step k’s k − 1 re-sent outputs at step k’s input rate', () => {
    expect(itemByLabel(items, 'tool-loop-output-resent').variableOutputRateNano).toBe(
      0n * 10n + 1n * 20n + 2n * 30n
    );
  });

  it('prices every call’s result on each later step at that step’s input rate', () => {
    expect(itemByLabel(items, 'tool-results-resent').fixedNano).toBe(
      2n * BigInt(loop.resultTokens) * (20n + 30n)
    );
  });

  it('prices the tool-use overhead on each tool-carrying step at that step’s input rate', () => {
    expect(itemByLabel(items, 'tool-use-overhead').fixedNano).toBe(
      BigInt(loop.overheadTokens) * (10n + 20n)
    );
  });

  it('refuses step rates whose count is not the call’s step count', () => {
    expect(() =>
      steppedCallLineItems([{ stepRates: stepRates.slice(1), toolLoop: loop }], 100n, 0)
    ).toThrow(RangeError);
  });
});

describe('stepResentInput', () => {
  const loop: ToolLoopBound = toolLoopBound(['webSearch'], 7);

  it('adds nothing beside the prompt on a call with no loop', () => {
    expect(stepResentInput(undefined, 1)).toEqual({
      earlierOutputs: 0,
      resultTokens: 0,
      overheadTokens: 0,
    });
  });

  it('sends the tool-use overhead and nothing re-sent on a loop’s first step', () => {
    expect(stepResentInput(loop, 1)).toEqual({
      earlierOutputs: 0,
      resultTokens: 0,
      overheadTokens: loop.overheadTokens,
    });
  });

  it('re-sends every earlier output and every call’s result on the tool-free last step', () => {
    expect(stepResentInput(loop, 8)).toEqual({
      earlierOutputs: 7,
      resultTokens: 7 * loop.resultTokens,
      overheadTokens: 0,
    });
  });

  it.each([0, 9, 1.5])('refuses step %s of an eight-step loop', (step) => {
    expect(() => stepResentInput(loop, step)).toThrow(RangeError);
  });

  it('refuses a second step on a call with no loop', () => {
    expect(() => stepResentInput(undefined, 2)).toThrow(RangeError);
  });
});
