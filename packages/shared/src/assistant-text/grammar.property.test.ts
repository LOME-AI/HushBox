import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { WEB_SEARCH_ENTRY_STATUSES } from '../web-search/web-search-row.ts';
import { isHttpUrl } from '../web-search/web-search-contract.ts';
import { parseAssistantMessage, serializeSegments } from './grammar.ts';
import type { Segment } from './segments.ts';
import type { WebSearchRow } from '../web-search/web-search-row.ts';

// The grammar's delimiters as literals the delimiter lint rule can see; this
// file is one it exempts, as adversarial model text for the grammar.
const RS = '\u001E';
const US = '\u001F';
const MARKER = `${RS}hb1${US}`;

/**
 * `modelTextAtoms`: characters and fragments that stress the grammar (the
 * separators alone, the marker, header-shaped runs for every known and one
 * unknown code, digits, lone surrogates, astral characters and JSON
 * punctuation), mixed with arbitrary code points.
 */
const modelTextAtoms = fc.oneof(
  fc.constantFrom(
    'a',
    'Z',
    '0',
    '9',
    ' ',
    '\n',
    'é',
    '😀',
    '{',
    '"',
    RS,
    US,
    'hb1',
    MARKER,
    `${RS}t3${US}`,
    `${RS}r12${US}`,
    `${RS}s0${US}`,
    `${RS}z1${US}`,
    String.fromCodePoint(0xd8_00),
    String.fromCodePoint(0xdc_00)
  ),
  fc.string({ unit: 'binary', maxLength: 3 })
);

/** `modelTexts`: model text of up to twelve atoms, empty included. */
const modelTexts = fc
  .array(modelTextAtoms, { maxLength: 12, size: 'max' })
  .map((atoms) => atoms.join(''));

/** `webSearchRows`: rows with every status, optional sources of http(s) pages, and counts. */
const webSearchRows: fc.Arbitrary<WebSearchRow> = fc.record({
  v: fc.constant(1 as const),
  searches: fc.array(
    fc.record(
      {
        query: modelTexts,
        status: fc.constantFrom(...WEB_SEARCH_ENTRY_STATUSES),
        sources: fc.array(
          fc.record({ title: modelTexts, url: fc.webUrl().filter((url) => isHttpUrl(url)) }),
          {
            maxLength: 3,
          }
        ),
      },
      { requiredKeys: ['query', 'status'] }
    ),
    { maxLength: 3 }
  ),
  notRun: fc.record({ limit: fc.nat(20), invalidQuery: fc.nat(20) }),
});

const textSegments: fc.Arbitrary<Segment> = modelTexts.map((text) => ({ kind: 'text', text }));
const searchSegments: fc.Arbitrary<Segment> = webSearchRows.map((row) => ({
  kind: 'webSearch',
  row,
}));

/** `segmentTrees`: every tree the kind specs allow: text and rows at the root and in reasoning. */
const segmentTrees: fc.Arbitrary<readonly Segment[]> = fc.array(
  fc.oneof(
    textSegments,
    searchSegments,
    fc
      .array(fc.oneof(textSegments, searchSegments), { maxLength: 5 })
      .map((children): Segment => ({ kind: 'reasoning', children }))
  ),
  { maxLength: 6 }
);

/** `malformedMessages`: the marker followed by arbitrary header-shaped and text atoms. */
const malformedMessages = fc
  .array(
    fc.oneof(
      modelTextAtoms,
      fc.nat(40).map((n) => `${RS}t${String(n)}${US}`),
      fc.nat(40).map((n) => `${RS}r${String(n)}${US}`),
      fc.nat(40).map((n) => `${RS}s${String(n)}${US}`)
    ),
    { maxLength: 20 }
  )
  .map((atoms) => `${MARKER}${atoms.join('')}`);

describe('assistant-text grammar properties', () => {
  it('round-trips every tree the kind specs allow (generator: segmentTrees)', () => {
    fc.assert(
      fc.property(segmentTrees, (tree) => {
        expect(parseAssistantMessage(serializeSegments(tree))).toEqual(tree);
      })
    );
  });

  it('writes a single non-empty answer text bare unless it begins with a separator (generator: modelTexts)', () => {
    fc.assert(
      fc.property(modelTexts, (text) => {
        fc.pre(text !== '' && !text.startsWith(RS));
        expect(serializeSegments([{ kind: 'text', text }])).toBe(text);
      })
    );
  });

  it('reads any non-empty text without the marker as one answer segment (generator: modelTexts)', () => {
    fc.assert(
      fc.property(modelTexts, (text) => {
        fc.pre(text !== '' && !text.startsWith(MARKER));
        expect(parseAssistantMessage(text)).toEqual([{ kind: 'text', text }]);
      })
    );
  });

  it('never lets model text forge a node, wherever it sits (generator: modelTexts)', () => {
    fc.assert(
      fc.property(modelTexts, modelTexts, modelTexts, (thought, first, second) => {
        const tree: Segment[] = [
          { kind: 'reasoning', children: [{ kind: 'text', text: thought }] },
          { kind: 'text', text: first },
          { kind: 'webSearch', row: { v: 1, searches: [], notRun: { limit: 0, invalidQuery: 0 } } },
          { kind: 'text', text: second },
        ];
        expect(parseAssistantMessage(serializeSegments(tree))).toEqual(tree);
      })
    );
  });

  it('reads malformed history deterministically, as a stable tree or as one bare text (generator: malformedMessages)', () => {
    fc.assert(
      fc.property(malformedMessages, (message) => {
        const tree = parseAssistantMessage(message);
        const bare = tree.length === 1 && tree[0]?.kind === 'text' && tree[0].text === message;
        if (!bare) expect(parseAssistantMessage(serializeSegments(tree))).toEqual(tree);
        expect(parseAssistantMessage(message)).toEqual(tree);
      })
    );
  });
});
