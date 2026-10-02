import { describe, expect, it } from 'vitest';
import { buildRenderContext } from '@/components/chat/segments/render-context';
import type { MessageRenderFacts } from '@/components/chat/segments/render-context';
import type { ReasoningSegment, Segment, WebSearchRow, WebSearchSegment } from '@hushbox/shared';

const SETTLED: MessageRenderFacts = {
  messageId: 'm-1',
  isStreaming: false,
  modelName: 'Sonnet 4.5',
  reasoningTokens: undefined,
  reasoningEffort: undefined,
};
const STREAMING: MessageRenderFacts = { ...SETTLED, isStreaming: true };

const EXAMPLE = { title: 'Example Domain', url: 'https://example.com/' };

function text(value: string): Segment {
  return { kind: 'text', text: value };
}

function reasoning(...children: Segment[]): ReasoningSegment {
  return { kind: 'reasoning', children };
}

function search(...searches: WebSearchRow['searches']): WebSearchSegment {
  return { kind: 'webSearch', row: { v: 1, searches, notRun: { limit: 0, invalidQuery: 0 } } };
}

describe('buildRenderContext keys', () => {
  it('keys each node by its kind and its ordinal among that kind in pre-order', () => {
    const thought = text('think');
    const nestedRow = search({ query: 'q', status: 'done', sources: [] });
    const span = reasoning(thought, nestedRow);
    const rootRow = search({ query: 'r', status: 'done', sources: [] });
    const answer = text('Answer');
    const context = buildRenderContext([span, answer, rootRow], SETTLED);
    expect(context.keyOf(span)).toBe('reasoning:0');
    expect(context.keyOf(thought)).toBe('text:0');
    expect(context.keyOf(nestedRow)).toBe('webSearch:0');
    expect(context.keyOf(answer)).toBe('text:1');
    expect(context.keyOf(rootRow)).toBe('webSearch:1');
  });

  it('gives equal trees equal keys, so a live tile and its stored message share view state', () => {
    const build = (): { row: WebSearchSegment; tree: readonly Segment[] } => {
      const row = search({ query: 'q', status: 'done', sources: [] });
      return { row, tree: [reasoning(text('a'), row), text('b')] };
    };
    const live = build();
    const stored = build();
    expect(buildRenderContext(live.tree, STREAMING).keyOf(live.row)).toBe(
      buildRenderContext(stored.tree, SETTLED).keyOf(stored.row)
    );
  });

  it('refuses a node from another tree rather than inventing a key', () => {
    const context = buildRenderContext([text('a')], SETTLED);
    expect(() => context.keyOf(text('a'))).toThrow();
  });
});

describe('buildRenderContext pages', () => {
  it('counts a page found inside reasoning as found earlier for a later row in the answer', () => {
    const nested = search({ query: 'a', status: 'done', sources: [EXAMPLE] });
    const inline = search({ query: 'b', status: 'done', sources: [EXAMPLE] });
    const context = buildRenderContext([reasoning(text('t'), nested), text('x'), inline], SETTLED);
    expect(context.rowPages(context.keyOf(nested)).firstFound).toBe(1);
    expect(context.rowPages(context.keyOf(inline)).firstFound).toBe(0);
    expect(context.rowPages(context.keyOf(inline)).entries[0]?.foundEarlier).toBe(1);
  });

  it('refuses a key that names no search row', () => {
    const context = buildRenderContext([text('a')], SETTLED);
    expect(() => context.rowPages('text:0')).toThrow();
  });
});

describe('buildRenderContext live state', () => {
  it('marks the root-last reasoning span live while the message streams', () => {
    const span = reasoning(text('thinking'));
    const context = buildRenderContext([span], STREAMING);
    expect(context.liveReasoningKey).toBe(context.keyOf(span));
  });

  it('marks no span live once answer text follows it', () => {
    const context = buildRenderContext([reasoning(text('t')), text('A')], STREAMING);
    expect(context.liveReasoningKey).toBeUndefined();
  });

  it('marks no span live on a settled message', () => {
    expect(buildRenderContext([reasoning(text('t'))], SETTLED).liveReasoningKey).toBeUndefined();
  });

  it('streams into the last text only when it is the last node in the message', () => {
    const tail = text('streaming');
    const context = buildRenderContext([text('lead'), search(), tail], STREAMING);
    expect(context.streamingTextKey).toBe(context.keyOf(tail));
  });

  it('streams into no text while a row is the last node', () => {
    const context = buildRenderContext([text('lead'), search()], STREAMING);
    expect(context.streamingTextKey).toBeUndefined();
  });

  it('names the first reasoning span, which alone carries the effort', () => {
    const first = reasoning(text('a'));
    const context = buildRenderContext([first, text('b'), reasoning(text('c'))], SETTLED);
    expect(context.firstReasoningKey).toBe(context.keyOf(first));
  });

  it('knows whether the root holds any answer text', () => {
    expect(buildRenderContext([reasoning(text('t'))], SETTLED).hasAnswer).toBe(false);
    expect(buildRenderContext([reasoning(text('t')), text('A')], SETTLED).hasAnswer).toBe(true);
  });
});

describe('buildRenderContext still-working cue', () => {
  it('places the cue after a settled row that ends a streaming message', () => {
    const row = search({ query: 'q', status: 'done', sources: [EXAMPLE] });
    const context = buildRenderContext([text('lead'), row], STREAMING);
    expect(context.workingAfterKey).toBe(context.keyOf(row));
  });

  it('places no cue while the last row is still searching', () => {
    const row = search({ query: 'q', status: 'searching' });
    expect(buildRenderContext([row], STREAMING).workingAfterKey).toBeUndefined();
  });

  it('places no cue once text follows the row', () => {
    const context = buildRenderContext([search(), text('more')], STREAMING);
    expect(context.workingAfterKey).toBeUndefined();
  });

  it('places no cue on a settled message', () => {
    expect(buildRenderContext([search()], SETTLED).workingAfterKey).toBeUndefined();
  });
});
