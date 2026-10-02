import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { SEGMENT_SPECS } from '../assistant-text/segments.ts';
import {
  WEB_SEARCH_TOOL_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  WebSearchQuery,
} from '../web-search/web-search-contract.ts';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../web-search/web-search-row.ts';
import { toolCallBillableNano } from './estimate/tool-pricing.ts';
import { inputTokensOf } from './price/quantities.ts';
import {
  TOOL_CALL_CAP_MAX,
  TOOL_DECLARATIONS,
  TOOL_NAMES,
  TOOL_USE_SYSTEM_PROMPT_TOKENS,
  WEB_SEARCH_RESULT_MAX_CHARS,
  carveToolLoopSteps,
  isToolName,
  toolCallCapFor,
  toolCallCapsOver,
  toolCallChargeNanoUsd,
  toolCallsOfSteps,
  toolDefinitionChars,
  toolLoopBound,
  toolLoopStepsFor,
} from './tool-loop.ts';
import type { ResolvedReasoningEffort } from './reasoning-effort.ts';

describe('the tool names', () => {
  it('names web search as a tool', () => {
    expect(TOOL_NAMES).toEqual(['webSearch']);
  });

  it('recognises a registered tool name', () => {
    expect(isToolName('webSearch')).toBe(true);
  });

  it('refuses a name no tool is registered under', () => {
    expect(isToolName('codeInterpreter')).toBe(false);
  });

  it('declares what the loop reads of web search', () => {
    expect(TOOL_DECLARATIONS.webSearch).toEqual({
      resultMaxChars: WEB_SEARCH_RESULT_MAX_CHARS,
      recordKind: 'webSearch',
      definitionChars: toolDefinitionChars({
        name: WEB_SEARCH_TOOL_NAME,
        description: WEB_SEARCH_TOOL_DESCRIPTION,
        inputSchema: WebSearchQuery,
      }),
    });
    expect(WEB_SEARCH_RESULT_MAX_CHARS).toBe(6000);
  });
});

describe('toolCallCapFor', () => {
  it.each<[ResolvedReasoningEffort, number]>([
    ['off', 2],
    ['lite', 4],
    ['low', 5],
    ['medium', 7],
    ['high', 8],
    ['max', 10],
  ])('gives %s a cap of %i tool calls', (effort, cap) => {
    expect(toolCallCapFor(effort)).toBe(cap);
  });

  it('gives a turn with no reasoning ladder the ceiling', () => {
    expect(toolCallCapFor()).toBe(10);
  });

  it('publishes the largest cap any turn can take', () => {
    expect(TOOL_CALL_CAP_MAX).toBe(10);
  });
});

/**
 * An ascending effort ladder of 1 to 12 rungs. The derivation reads only each
 * rung's position, so the names are placeholders.
 */
const effortDomains: fc.Arbitrary<readonly string[]> = fc
  .integer({ min: 1, max: 12 })
  .map((length) => Array.from({ length }, (_value, index) => `rung-${String(index)}`));

describe('toolCallCapsOver — the cap spread over any ladder', () => {
  it('starts at the floor, ends at the ceiling, never falls and never passes the maximum', () => {
    fc.assert(
      fc.property(effortDomains, (domain) => {
        const caps = toolCallCapsOver(domain);
        expect(caps).toHaveLength(domain.length);
        expect(caps.at(-1)).toBe(10);
        if (domain.length > 1) expect(caps[0]).toBe(2);
        for (const [index, cap] of caps.entries()) {
          expect(cap).toBeLessThanOrEqual(TOOL_CALL_CAP_MAX);
          if (index > 0) expect(cap).toBeGreaterThanOrEqual(caps[index - 1] ?? Infinity);
        }
      })
    );
  });

  it('gives a one-rung ladder the ceiling', () => {
    expect(toolCallCapsOver(['only'])).toEqual([10]);
  });

  it('re-spreads the caps when a seventh rung joins the ladder', () => {
    expect(toolCallCapsOver(['a', 'b', 'c', 'd', 'e', 'f'])).toEqual([2, 4, 5, 7, 8, 10]);
    expect(toolCallCapsOver(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual([2, 3, 5, 6, 7, 9, 10]);
  });
});

describe('steps and calls', () => {
  it('adds the tool-free answering step to the call budget', () => {
    expect(toolLoopStepsFor(10)).toBe(11);
    expect(toolLoopStepsFor(0)).toBe(1);
  });

  it('reads the call budget back out of a step count', () => {
    expect(toolCallsOfSteps(11)).toBe(10);
    expect(toolCallsOfSteps(1)).toBe(0);
  });

  it('round-trips every call budget through its step count', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1000 }), (calls) => {
        expect(toolCallsOfSteps(toolLoopStepsFor(calls))).toBe(calls);
      })
    );
  });

  it.each([-1, 1.5, Number.NaN])('refuses a call budget of %d', (calls) => {
    expect(() => toolLoopStepsFor(calls)).toThrow(RangeError);
  });

  it.each([0, -3, 2.5])('refuses a step count of %d', (steps) => {
    expect(() => toolCallsOfSteps(steps)).toThrow(RangeError);
  });
});

describe('carveToolLoopSteps', () => {
  it('narrows a declared loop to the decided rung', () => {
    expect(carveToolLoopSteps(11, 'low')).toBe(6);
  });

  it('keeps a declared loop shorter than the rung allows', () => {
    expect(carveToolLoopSteps(3, 'max')).toBe(3);
  });

  it('never exceeds the declared steps, for any rung or none', () => {
    const efforts: readonly (ResolvedReasoningEffort | undefined)[] = [
      'off',
      'lite',
      'low',
      'medium',
      'high',
      'max',
      undefined,
    ];
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 40 }), fc.constantFrom(...efforts), (steps, effort) => {
        expect(carveToolLoopSteps(steps, effort)).toBeLessThanOrEqual(steps);
      })
    );
  });
});

/** The overhead a web-search loop reserves, derived from the shared web-search declaration. */
function webSearchOverheadTokens(): number {
  const definitionChars = toolDefinitionChars({
    name: WEB_SEARCH_TOOL_NAME,
    description: WEB_SEARCH_TOOL_DESCRIPTION,
    inputSchema: WebSearchQuery,
  });
  return TOOL_USE_SYSTEM_PROMPT_TOKENS + inputTokensOf(definitionChars);
}

describe('toolLoopBound', () => {
  it('bounds a web-search loop', () => {
    const bound = toolLoopBound(['webSearch'], 10);
    expect(bound.steps).toBe(11);
    expect(bound.calls).toBe(10);
    expect(bound.resultTokens).toBe(inputTokensOf(WEB_SEARCH_RESULT_MAX_CHARS));
    expect(bound.callFeeNano).toBe(toolCallBillableNano('webSearch'));
    expect(bound.recordStorageChars).toBe(SEGMENT_SPECS.webSearch.storageAllowanceChars);
    expect(bound.recordStorageChars).toBe(WEB_SEARCH_ROW_MAX_CHARS);
  });

  it('sizes a web-search result at 2,000 tokens, the same for every payer', () => {
    // 6,000 result characters at 3 input characters per token.
    expect(toolLoopBound(['webSearch'], 10).resultTokens).toBe(2000);
  });

  it('takes the largest result and fee over its tools rather than their sum', () => {
    const once = toolLoopBound(['webSearch'], 4);
    const twice = toolLoopBound(['webSearch', 'webSearch'], 4);
    expect(twice.resultTokens).toBe(once.resultTokens);
    expect(twice.callFeeNano).toBe(once.callFeeNano);
  });

  it('stores each record kind once however many tools write it', () => {
    expect(toolLoopBound(['webSearch', 'webSearch'], 4).recordStorageChars).toBe(
      WEB_SEARCH_ROW_MAX_CHARS
    );
  });

  it('refuses a loop with no tool', () => {
    expect(() => toolLoopBound([], 1)).toThrow(RangeError);
  });

  it('sizes the tool-use overhead from the system prompt plus the shared web-search definition', () => {
    expect(toolLoopBound(['webSearch'], 7).overheadTokens).toBe(webSearchOverheadTokens());
  });

  it('declares a tool-use system prompt of 496 tokens', () => {
    expect(TOOL_USE_SYSTEM_PROMPT_TOKENS).toBe(496);
  });

  it.each([1, 10])('keeps the tool-use overhead the same for a loop of %i calls', (calls) => {
    expect(toolLoopBound(['webSearch'], calls).overheadTokens).toBe(webSearchOverheadTokens());
  });

  it('counts a tool named twice as one definition in the overhead', () => {
    expect(toolLoopBound(['webSearch', 'webSearch'], 4).overheadTokens).toBe(
      webSearchOverheadTokens()
    );
  });

  it.each([0, -1, 2.5, 11, Number.NaN])('refuses a call count of %d', (calls) => {
    expect(() => toolLoopBound(['webSearch'], calls)).toThrow(RangeError);
  });
});

describe('toolDefinitionChars', () => {
  const definition = {
    name: 'lookup',
    description: 'Look a thing up.',
    inputSchema: z.object({ query: z.string() }),
  };

  it('measures a definition as its serialized JSON', () => {
    const sent = JSON.stringify({
      name: 'lookup',
      description: 'Look a thing up.',
      inputSchema: z.toJSONSchema(z.object({ query: z.string() }), { unrepresentable: 'any' }),
    });
    expect(toolDefinitionChars(definition)).toBe(sent.length);
  });

  it('grows with a longer description', () => {
    expect(
      toolDefinitionChars({ ...definition, description: `${definition.description} More words.` })
    ).toBe(toolDefinitionChars(definition) + ' More words.'.length);
  });
});

/** A call count the charge accepts: every count from none to the cap. */
const chargeableCallCounts = fc.integer({ min: 0, max: TOOL_CALL_CAP_MAX });

describe('toolCallChargeNanoUsd', () => {
  it('charges each call at the after-fee rate', () => {
    expect(toolCallChargeNanoUsd('webSearch', 3)).toBe(3n * toolCallBillableNano('webSearch'));
  });

  it('charges nothing for no calls', () => {
    expect(toolCallChargeNanoUsd('webSearch', 0)).toBe(0n);
  });

  it('never charges more than the cap’s worth of calls', () => {
    fc.assert(
      fc.property(chargeableCallCounts, (calls) => {
        expect(toolCallChargeNanoUsd('webSearch', calls)).toBeLessThanOrEqual(
          BigInt(TOOL_CALL_CAP_MAX) * toolCallBillableNano('webSearch')
        );
      })
    );
  });

  it.each([-1, 1.5, TOOL_CALL_CAP_MAX + 1])('refuses a count of %d', (calls) => {
    expect(() => toolCallChargeNanoUsd('webSearch', calls)).toThrow(RangeError);
  });
});
