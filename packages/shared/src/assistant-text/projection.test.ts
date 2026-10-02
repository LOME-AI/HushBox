import { describe, expect, it } from 'vitest';
import { rowPageCounts } from '../web-search/web-search-row.ts';
import { serializeSegments } from './grammar.ts';
import { assistantAnswerText, assistantHistoryText, webSearchRowsInOrder } from './projection.ts';
import type { Segment } from './segments.ts';
import type { WebSearchRow } from '../web-search/web-search-row.ts';

const textSegment = (value: string): Segment => ({ kind: 'text', text: value });
const reasoningSegment = (...children: Segment[]): Segment => ({ kind: 'reasoning', children });
const rowOf = (...urls: string[]): WebSearchRow => ({
  v: 1,
  searches: [{ query: 'q', status: 'done', sources: urls.map((url) => ({ title: url, url })) }],
  notRun: { limit: 0, invalidQuery: 0 },
});
const searchSegment = (...urls: string[]): Segment => ({ kind: 'webSearch', row: rowOf(...urls) });

const MIXED = serializeSegments([
  reasoningSegment(textSegment('t1'), searchSegment('https://a/'), textSegment('t2')),
  textSegment('A1'),
  searchSegment('https://a/', 'https://b/'),
  textSegment('A2'),
]);

describe('assistantHistoryText', () => {
  it('keeps only root answer text, joined by a blank line', () => {
    expect(assistantHistoryText(MIXED)).toBe('A1\n\nA2');
  });

  it('returns bare text unchanged', () => {
    expect(assistantHistoryText('plain answer')).toBe('plain answer');
  });

  it('is empty for a turn with no answer text', () => {
    expect(assistantHistoryText(serializeSegments([reasoningSegment(textSegment('t'))]))).toBe('');
  });

  it('skips an empty answer text rather than joining around it', () => {
    expect(
      assistantHistoryText(serializeSegments([textSegment(''), searchSegment(), textSegment('A')]))
    ).toBe('A');
  });
});

describe('assistantAnswerText', () => {
  it('keeps only root answer text, joined by a blank line', () => {
    expect(assistantAnswerText(MIXED)).toBe('A1\n\nA2');
  });

  it('returns bare text unchanged', () => {
    expect(assistantAnswerText('effort: Lite')).toBe('effort: Lite');
  });

  it('is empty for the empty message', () => {
    expect(assistantAnswerText('')).toBe('');
  });
});

describe('webSearchRowsInOrder', () => {
  it('lists every row in document order across every depth', () => {
    const tree: Segment[] = [
      reasoningSegment(textSegment('t'), searchSegment('https://a/')),
      textSegment('A'),
      searchSegment('https://b/'),
    ];
    expect(webSearchRowsInOrder(tree)).toEqual([rowOf('https://a/'), rowOf('https://b/')]);
  });

  it('feeds the per-message page counts: a page found while reasoning counts once for the message', () => {
    const tree: Segment[] = [
      reasoningSegment(searchSegment('https://a/', 'https://b/')),
      textSegment('A'),
      searchSegment('https://b/', 'https://c/'),
    ];
    expect(rowPageCounts(webSearchRowsInOrder(tree))).toEqual([
      { firstFound: 2, foundEarlier: 0 },
      { firstFound: 1, foundEarlier: 1 },
    ]);
  });
});
