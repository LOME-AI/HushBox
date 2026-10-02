import { describe, expect, expectTypeOf, it } from 'vitest';
import { buildRenderContext } from '@/components/chat/segments/render-context';
import { SEGMENT_SUMMARIES, summarizeChildren } from '@/components/chat/segments/segment-summaries';
import type { SegmentSummaryTable } from '@/components/chat/segments/segment-summaries';
import type { ReasoningSegment, Segment, SegmentKind, WebSearchRow } from '@hushbox/shared';

const A = { title: 'A', url: 'https://a.example/' };
const B = { title: 'B', url: 'https://b.example/' };

function search(...searches: WebSearchRow['searches']): Segment {
  return { kind: 'webSearch', row: { v: 1, searches, notRun: { limit: 0, invalidQuery: 0 } } };
}

function summaryOf(
  span: ReasoningSegment,
  streaming = false
): ReturnType<typeof summarizeChildren> {
  const context = buildRenderContext([span], {
    messageId: 'm',
    isStreaming: streaming,
    modelName: 'Sonnet 4.5',
    reasoningTokens: undefined,
    reasoningEffort: undefined,
  });
  return summarizeChildren(span.children, context);
}

describe('SEGMENT_SUMMARIES', () => {
  it('has an entry for every segment kind, so a kind without one fails to compile', () => {
    expectTypeOf<keyof SegmentSummaryTable>().toEqualTypeOf<SegmentKind>();
    expect(Object.keys(SEGMENT_SUMMARIES).toSorted((a, b) => a.localeCompare(b))).toEqual([
      'reasoning',
      'text',
      'webSearch',
    ]);
  });
});

describe('SEGMENT_SUMMARIES entries without a one-liner fragment', () => {
  const context = buildRenderContext([], {
    messageId: 'm',
    isStreaming: false,
    modelName: undefined,
    reasoningTokens: undefined,
    reasoningEffort: undefined,
  });

  it('gives a reasoning span nothing to add to a parent one-liner', () => {
    const span: ReasoningSegment = { kind: 'reasoning', children: [] };
    expect(SEGMENT_SUMMARIES.reasoning.fragments([span], context)).toEqual([]);
    expect(SEGMENT_SUMMARIES.reasoning.liveActivity(span)).toBeUndefined();
  });

  it('gives text nothing to add to a parent one-liner', () => {
    expect(SEGMENT_SUMMARIES.text.fragments([{ kind: 'text', text: 'a' }], context)).toEqual([]);
  });
});

describe('summarizeChildren', () => {
  it('adds nothing for a span of thoughts alone', () => {
    expect(summaryOf({ kind: 'reasoning', children: [{ kind: 'text', text: 'hm' }] })).toEqual({
      fragments: [],
      liveActivity: undefined,
    });
  });

  it('totals the pages of every search in the span into one fragment', () => {
    const span: ReasoningSegment = {
      kind: 'reasoning',
      children: [
        { kind: 'text', text: 'a' },
        search({ query: 'q1', status: 'done', sources: [A] }),
        { kind: 'text', text: 'b' },
        search({ query: 'q2', status: 'done', sources: [A, B] }),
      ],
    };
    expect(summaryOf(span).fragments).toEqual(['Searched 2 sources']);
  });

  it('names a running search as the live activity', () => {
    const span: ReasoningSegment = {
      kind: 'reasoning',
      children: [{ kind: 'text', text: 'a' }, search({ query: 'q', status: 'searching' })],
    };
    expect(summaryOf(span, true).liveActivity).toBe('searching the web');
  });

  it('names no live activity once the searches settle', () => {
    const span: ReasoningSegment = {
      kind: 'reasoning',
      children: [search({ query: 'q', status: 'done', sources: [A] }), { kind: 'text', text: 'b' }],
    };
    expect(summaryOf(span, true).liveActivity).toBeUndefined();
  });
});
