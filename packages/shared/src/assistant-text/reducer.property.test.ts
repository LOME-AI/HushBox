import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../web-search/web-search-row.ts';
import { ASSISTANT_FRAMING_MAX_CHARS, parseAssistantMessage } from './grammar.ts';
import {
  ASSISTANT_FRAME_CEILING,
  ASSISTANT_FRAME_LIMIT,
  createAssistantStream,
  reduceAssistantStream,
  serializeAssistantStream,
  settleAssistantStream,
} from './reducer.ts';
import { webSearchRowsInOrder } from './projection.ts';
import type { AssistantStreamState } from './reducer.ts';
import type { Segment } from './segments.ts';
import type { InferenceEvent } from '../workflow/inference.ts';

// The grammar's delimiters as literals the delimiter lint rule can see; this
// file is one it exempts, as adversarial model text for the grammar.
const RS = '\u001E';
const US = '\u001F';

/** `unicodeDeltas`: delta content of arbitrary code points, with the separators and header-shaped runs mixed in. */
const unicodeDeltas = fc
  .array(
    fc.oneof(
      fc.string({ unit: 'binary', maxLength: 4 }),
      fc.constantFrom(RS, US, `${RS}hb1${US}`, `${RS}t2${US}`, `${RS}r0${US}`, '\n\n', '😀')
    ),
    { minLength: 1, maxLength: 4 }
  )
  .map((parts) => parts.join(''));

type Outcome = 'result' | 'failed' | 'limit' | 'invalid-input' | 'none';

type StreamItem =
  | { readonly kind: 'reasoning' | 'text'; readonly content: string }
  | { readonly kind: 'step' }
  | {
      readonly kind: 'search';
      readonly query: string;
      readonly outcome: Outcome;
      readonly delay: number;
      readonly urls: readonly string[];
    };

const streamItems: fc.Arbitrary<StreamItem> = fc.oneof(
  fc.record({ kind: fc.constant('reasoning' as const), content: unicodeDeltas }),
  fc.record({ kind: fc.constant('text' as const), content: unicodeDeltas }),
  fc.record({ kind: fc.constant('step' as const) }),
  fc.record({
    kind: fc.constant('search' as const),
    query: unicodeDeltas,
    outcome: fc.constantFrom<Outcome>('result', 'failed', 'limit', 'invalid-input', 'none'),
    delay: fc.nat(6),
    urls: fc.array(fc.webUrl({ validSchemes: ['https'] }), { maxLength: 3 }),
  })
);

function outcomeEvent(
  id: string,
  outcome: Exclude<Outcome, 'none'>,
  urls: readonly string[]
): InferenceEvent {
  if (outcome !== 'result') return { kind: 'tool-error', id, name: 'webSearch', reason: outcome };
  const results = urls.map((url) => ({ title: url, url, snippet: '' }));
  return { kind: 'tool-result', id, name: 'webSearch', result: { results } };
}

interface ItemEvents {
  readonly now: readonly InferenceEvent[];
  readonly later?: { readonly delay: number; readonly event: InferenceEvent };
}

function itemEvents(item: StreamItem, counters: { step: number; calls: number }): ItemEvents {
  if (item.kind === 'step') {
    counters.step += 1;
    return { now: [{ kind: 'step-start', step: counters.step }] };
  }
  if (item.kind !== 'search') {
    const kind = item.kind === 'text' ? 'text-delta' : 'reasoning-delta';
    return { now: [{ kind, index: 0, content: item.content }] };
  }
  const id = `call-${String(counters.calls)}`;
  counters.calls += 1;
  const call: InferenceEvent = {
    kind: 'tool-call',
    id,
    name: 'webSearch',
    args: { query: item.query },
  };
  if (item.outcome === 'none') return { now: [call] };
  return {
    now: [call],
    later: { delay: item.delay, event: outcomeEvent(id, item.outcome, item.urls) },
  };
}

/** Lays the items out as events: steps numbered in order, each search's outcome `delay` items later. */
function toEvents(items: readonly StreamItem[]): InferenceEvent[] {
  const slots: InferenceEvent[][] = items.map(() => []);
  const trailing: InferenceEvent[] = [];
  const counters = { step: 0, calls: 0 };
  for (const [index, item] of items.entries()) {
    const { now, later } = itemEvents(item, counters);
    (slots[index] ?? trailing).push(...now);
    if (later !== undefined) (slots[index + later.delay] ?? trailing).push(later.event);
  }
  return [...slots.flat(), ...trailing];
}

/**
 * `assistantStreams`: arbitrary interleavings of reasoning, answer text and
 * step starts with zero to ten web searches, each resolved (result, failure,
 * cap refusal, rejected input) a few items later or never.
 */
const assistantStreams = fc
  .array(streamItems, { maxLength: 30 })
  .filter((items) => items.filter((item) => item.kind === 'search').length <= 10)
  .map((items) => toEvents(items));

/**
 * A span filled past the frame limit with thinking and searches and no answer
 * text, then one answer delta: that delta has no root text to join, so every
 * case opens a fallback frame.
 */
const FALLBACK_PREFIX: readonly StreamItem[] = [
  ...Array.from({ length: 30 }, (): StreamItem[] => [
    { kind: 'reasoning', content: 'x' },
    { kind: 'search', query: 'q', outcome: 'failed', delay: 0, urls: [] },
  ]).flat(),
  { kind: 'text', content: 'x' },
];

/**
 * `pathologicalStreams`: the fallback prefix, then long alternations that keep
 * the message past the frame limit.
 */
const pathologicalStreams = fc
  .array(fc.constantFrom<StreamItem['kind']>('reasoning', 'text', 'step', 'search'), {
    minLength: 100,
    maxLength: 300,
  })
  .map((kinds) =>
    toEvents([
      ...FALLBACK_PREFIX,
      ...kinds.map((kind): StreamItem => {
        if (kind === 'search') return { kind, query: 'q', outcome: 'failed', delay: 0, urls: [] };
        if (kind === 'step') return { kind };
        return { kind, content: 'x' };
      }),
    ])
  );

/**
 * `nativeStreams`: a message that opens with a native think block, then long
 * alternations of reasoning, text (reasoning until the close tag, answer
 * after it), step starts, searches and the close tag.
 */
const nativeStreams = fc
  .array(fc.constantFrom('reasoning', 'text', 'step', 'search', 'close'), {
    minLength: 100,
    maxLength: 300,
  })
  .map((kinds) => [
    { kind: 'text-delta' as const, index: 0, content: '<think>' },
    ...toEvents(
      kinds.map((kind): StreamItem => {
        if (kind === 'search') return { kind, query: 'q', outcome: 'failed', delay: 0, urls: [] };
        if (kind === 'step') return { kind };
        if (kind === 'close') return { kind: 'text', content: '</think>' };
        return { kind, content: 'x' };
      })
    ),
  ]);

function reduceAll(events: readonly InferenceEvent[]): AssistantStreamState {
  let state = createAssistantStream();
  for (const event of events) state = reduceAssistantStream(state, event);
  return state;
}

function modelChars(events: readonly InferenceEvent[]): number {
  let sum = 0;
  for (const event of events) {
    if (event.kind === 'text-delta' || event.kind === 'reasoning-delta')
      sum += event.content.length;
  }
  return sum;
}

function textChars(nodes: readonly Segment[]): number {
  let sum = 0;
  for (const node of nodes) {
    if (node.kind === 'text') sum += node.text.length;
    if (node.kind === 'reasoning') sum += textChars(node.children);
  }
  return sum;
}

function authoredChars(
  events: readonly InferenceEvent[],
  text: string
): { framing: number; rows: number } {
  let rows = 0;
  for (const row of webSearchRowsInOrder(parseAssistantMessage(text))) {
    rows += JSON.stringify(row).length;
  }
  return { framing: text.length - rows - modelChars(events), rows };
}

describe('assistant stream reducer properties', () => {
  it('stores text that parses back to the settled tree (generator: assistantStreams)', () => {
    fc.assert(
      fc.property(assistantStreams, (events) => {
        const settled = settleAssistantStream(reduceAll(events));
        expect(parseAssistantMessage(serializeAssistantStream(settled).text)).toEqual(settled.tree);
      })
    );
  });

  it('writes live text that parses back to the live tree after every event (generator: assistantStreams)', () => {
    fc.assert(
      fc.property(assistantStreams, (events) => {
        let state = createAssistantStream();
        for (const event of events) {
          state = reduceAssistantStream(state, event);
          expect(parseAssistantMessage(serializeAssistantStream(state).text)).toEqual(state.tree);
        }
      }),
      // Every prefix is serialized and parsed, so a case costs its length squared.
      { numRuns: 300 }
    );
  });

  it('keeps authored characters within their allowances (generator: assistantStreams)', () => {
    fc.assert(
      fc.property(assistantStreams, (events) => {
        const { text } = serializeAssistantStream(settleAssistantStream(reduceAll(events)));
        const authored = authoredChars(events, text);
        expect(authored.framing).toBeLessThanOrEqual(ASSISTANT_FRAMING_MAX_CHARS);
        expect(authored.rows).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
      })
    );
  });

  it('keeps framing within its allowance past the frame limit (generator: pathologicalStreams)', () => {
    fc.assert(
      fc.property(pathologicalStreams, (events) => {
        const settled = settleAssistantStream(reduceAll(events));
        const { text } = serializeAssistantStream(settled);
        expect(authoredChars(events, text).framing).toBeLessThanOrEqual(
          ASSISTANT_FRAMING_MAX_CHARS
        );
        expect(settled.frameCount).toBeGreaterThan(ASSISTANT_FRAME_LIMIT);
        expect(settled.frameCount).toBeLessThanOrEqual(ASSISTANT_FRAME_CEILING);
        expect(parseAssistantMessage(text)).toEqual(settled.tree);
      }),
      // Each case reduces up to three hundred events.
      { numRuns: 300 }
    );
  });

  it('keeps frames within the ceiling for a message opening with a native think block (generator: nativeStreams)', () => {
    fc.assert(
      fc.property(nativeStreams, (events) => {
        const settled = settleAssistantStream(reduceAll(events));
        const { text } = serializeAssistantStream(settled);
        expect(settled.frameCount).toBeLessThanOrEqual(ASSISTANT_FRAME_CEILING);
        expect(authoredChars(events, text).framing).toBeLessThanOrEqual(
          ASSISTANT_FRAMING_MAX_CHARS
        );
        expect(parseAssistantMessage(text)).toEqual(settled.tree);
      }),
      // Each case reduces up to three hundred events.
      { numRuns: 300 }
    );
  });

  it('keeps every model character, so no delta is lost or invented (generator: assistantStreams)', () => {
    fc.assert(
      fc.property(assistantStreams, (events) => {
        const settled = settleAssistantStream(reduceAll(events));
        const stored = parseAssistantMessage(serializeAssistantStream(settled).text);
        const delivered = modelChars(events);
        const inTree = textChars(stored);
        // Separators are the only characters the reducer adds to text frames.
        expect(inTree).toBeGreaterThanOrEqual(delivered);
        expect((inTree - delivered) % 2).toBe(0);
      })
    );
  });
});
