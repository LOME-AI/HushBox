import { describe, expect, expectTypeOf, it } from 'vitest';
import { WEB_SEARCH_ROW_MAX_CHARS } from '../web-search/web-search-row.ts';
import { SEGMENT_KINDS, SEGMENT_SPECS } from './segments.ts';
import type { ContainerKind, Segment, SegmentKind, SegmentSpecTable } from './segments.ts';

const children = (): string => '';

describe('SEGMENT_SPECS', () => {
  it('has exactly one spec per kind', () => {
    const byName = (a: string, b: string): number => a.localeCompare(b);
    expect(Object.keys(SEGMENT_SPECS).toSorted(byName)).toEqual(
      [...SEGMENT_KINDS].toSorted(byName)
    );
  });

  it('gives every kind a distinct one-character wire code', () => {
    const codes = SEGMENT_KINDS.map((kind) => SEGMENT_SPECS[kind].code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const code of codes) expect(code).toHaveLength(1);
  });

  it('never uses a decimal digit as a wire code', () => {
    for (const kind of SEGMENT_KINDS) expect(SEGMENT_SPECS[kind].code).not.toMatch(/\d/);
  });

  it('places text at the root and inside reasoning', () => {
    expect(SEGMENT_SPECS.text.parents).toEqual(['root', 'reasoning']);
  });

  it('places reasoning at the root only', () => {
    expect(SEGMENT_SPECS.reasoning.parents).toEqual(['root']);
  });

  it('places a search row at the root and inside reasoning', () => {
    expect(SEGMENT_SPECS.webSearch.parents).toEqual(['root', 'reasoning']);
  });

  it('projects text into history as itself', () => {
    expect(SEGMENT_SPECS.text.toHistory({ kind: 'text', text: 'answer' }, children)).toBe('answer');
  });

  it('projects reasoning into history as nothing, whatever it holds', () => {
    const node = { kind: 'reasoning' as const, children: [{ kind: 'text' as const, text: 'x' }] };
    expect(SEGMENT_SPECS.reasoning.toHistory(node, () => 'x')).toBe('');
  });

  it('projects a search row into history as nothing', () => {
    const node = {
      kind: 'webSearch' as const,
      row: { v: 1 as const, searches: [], notRun: { limit: 0, invalidQuery: 0 } },
    };
    expect(SEGMENT_SPECS.webSearch.toHistory(node, children)).toBe('');
  });

  it('reserves the search-row allowance for search rows only', () => {
    expect(SEGMENT_SPECS.webSearch.storageAllowanceChars).toBe(WEB_SEARCH_ROW_MAX_CHARS);
    expect(SEGMENT_SPECS.text.storageAllowanceChars).toBe(0);
    expect(SEGMENT_SPECS.reasoning.storageAllowanceChars).toBe(0);
  });

  it('decodes a search row body back to the row it encodes', () => {
    const row = {
      v: 1 as const,
      searches: [{ query: 'q', status: 'done' as const }],
      notRun: { limit: 0, invalidQuery: 1 },
    };
    const body = SEGMENT_SPECS.webSearch.encodeBody({ kind: 'webSearch', row }, children);
    expect(SEGMENT_SPECS.webSearch.decodeBody(body, () => [])).toEqual({ kind: 'webSearch', row });
  });

  it('refuses a search row body that is not JSON', () => {
    expect(SEGMENT_SPECS.webSearch.decodeBody('{not json', () => [])).toBeUndefined();
  });

  it('refuses a search row body that does not match the row schema', () => {
    expect(SEGMENT_SPECS.webSearch.decodeBody('{"v":1}', () => [])).toBeUndefined();
  });

  it('refuses a reasoning body whose children do not decode', () => {
    expect(SEGMENT_SPECS.reasoning.decodeBody('x', () => undefined)).toBeUndefined();
  });
});

describe('segment types', () => {
  it('keys the spec table by exactly the segment kinds', () => {
    expectTypeOf<keyof SegmentSpecTable>().toEqualTypeOf<SegmentKind>();
  });

  it('refuses a spec table missing a kind at compile time', () => {
    // @ts-expect-error -- a table without every kind's spec must not compile
    const missing: SegmentSpecTable = {
      text: SEGMENT_SPECS.text,
      reasoning: SEGMENT_SPECS.reasoning,
    };
    expect(missing).toBeDefined();
  });

  it('draws every segment kind from the closed kind union', () => {
    expectTypeOf<Segment['kind']>().toEqualTypeOf<SegmentKind>();
  });

  it('names the two containers', () => {
    expectTypeOf<ContainerKind>().toEqualTypeOf<'root' | 'reasoning'>();
  });
});
