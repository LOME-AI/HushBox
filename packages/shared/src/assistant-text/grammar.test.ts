import { describe, expect, it } from 'vitest';
import {
  FRAME_HEADER_MAX_CHARS,
  MESSAGE_MARKER_CHARS,
  SEGMENT_TEXT_SEPARATOR,
  afterThinkClose,
  leadingThinkOpen,
  parseAssistantMessage,
  serializeSegments,
  splitAtThinkClose,
  withoutLeadingMarker,
} from './grammar.ts';
import {
  createAssistantStream,
  reduceAssistantStream,
  serializeAssistantStream,
  settleAssistantStream,
} from './reducer.ts';
import type { AssistantStreamState } from './reducer.ts';
import type { Segment } from './segments.ts';
import type { InferenceEvent } from '../workflow/inference.ts';
import type { WebSearchRow } from '../web-search/web-search-row.ts';

// The wire format written out byte for byte: these vectors freeze it, which a
// round-trip property alone cannot do.
const RS = '\u001E';
const US = '\u001F';
const MAGIC = `${RS}hb1${US}`;

const textSegment = (value: string): Segment => ({ kind: 'text', text: value });
const reasoningSegment = (...children: Segment[]): Segment => ({ kind: 'reasoning', children });
const ROW: WebSearchRow = {
  v: 1,
  searches: [{ query: 'q', status: 'done' }],
  notRun: { limit: 0, invalidQuery: 0 },
};
const ROW_JSON = JSON.stringify(ROW);

describe('serializeSegments', () => {
  it('writes a single answer text bare, byte-identical to the model text', () => {
    expect(serializeSegments([textSegment('hello')])).toBe('hello');
  });

  it('writes an empty tree as the empty string', () => {
    expect(serializeSegments([])).toBe('');
  });

  it('frames a single empty text so it survives a round trip', () => {
    expect(serializeSegments([textSegment('')])).toBe(`${MAGIC}${RS}t0${US}`);
  });

  it('frames a single text that begins with the record separator', () => {
    const value = `${RS}hb1${US}looks framed`;
    expect(serializeSegments([textSegment(value)])).toBe(
      `${MAGIC}${RS}t${String(value.length)}${US}${value}`
    );
  });

  it('frames reasoning then answer as nested length-prefixed frames', () => {
    expect(serializeSegments([reasoningSegment(textSegment('ab')), textSegment('c')])).toBe(
      `${MAGIC}${RS}r6${US}${RS}t2${US}ab${RS}t1${US}c`
    );
  });

  it('writes a search row body as its JSON', () => {
    const segment: Segment = { kind: 'webSearch', row: ROW };
    expect(serializeSegments([segment])).toBe(
      `${MAGIC}${RS}s${String(ROW_JSON.length)}${US}${ROW_JSON}`
    );
  });

  it('counts frame lengths in UTF-16 units', () => {
    expect(serializeSegments([reasoningSegment(textSegment('😀'))])).toBe(
      `${MAGIC}${RS}r6${US}${RS}t2${US}😀`
    );
  });

  it('refuses a reasoning segment nested in reasoning', () => {
    expect(() => serializeSegments([reasoningSegment(reasoningSegment(textSegment('x')))])).toThrow(
      new RangeError('a reasoning segment cannot sit in reasoning')
    );
  });
});

describe('withoutLeadingMarker', () => {
  it('removes the frame marker at the start of the text', () => {
    expect(withoutLeadingMarker(`${MAGIC}${RS}t1${US}a`)).toBe(`${RS}t1${US}a`);
  });

  it('removes every frame marker repeated at the start', () => {
    expect(withoutLeadingMarker(`${MAGIC}${MAGIC}rest`)).toBe('rest');
  });

  it('keeps a marker that is not at the start', () => {
    expect(withoutLeadingMarker(`a${MAGIC}`)).toBe(`a${MAGIC}`);
  });

  it('keeps text without a marker unchanged', () => {
    expect(withoutLeadingMarker('plain')).toBe('plain');
  });
});

describe('parseAssistantMessage', () => {
  it('reads the empty string as an empty tree', () => {
    expect(parseAssistantMessage('')).toEqual([]);
  });

  it('reads unframed text as one answer segment', () => {
    expect(parseAssistantMessage('plain answer')).toEqual([textSegment('plain answer')]);
  });

  it('reads text that starts with a record separator but no marker as one answer segment', () => {
    expect(parseAssistantMessage(`${RS}t1${US}a`)).toEqual([textSegment(`${RS}t1${US}a`)]);
  });

  it('reads nested frames back into the tree', () => {
    expect(parseAssistantMessage(`${MAGIC}${RS}r6${US}${RS}t2${US}ab${RS}t1${US}c`)).toEqual([
      reasoningSegment(textSegment('ab')),
      textSegment('c'),
    ]);
  });

  it('reads a search row nested in reasoning', () => {
    const row = `${RS}s${String(ROW_JSON.length)}${US}${ROW_JSON}`;
    expect(parseAssistantMessage(`${MAGIC}${RS}r${String(row.length)}${US}${row}`)).toEqual([
      reasoningSegment({ kind: 'webSearch', row: ROW }),
    ]);
  });

  it('skips a frame with an unknown code but a valid length', () => {
    expect(parseAssistantMessage(`${MAGIC}${RS}z3${US}xyz${RS}t1${US}a`)).toEqual([
      textSegment('a'),
    ]);
  });

  it('never scans a text body, so delimiters inside it are inert', () => {
    const body = `${RS}r3${US}${MAGIC}`;
    expect(parseAssistantMessage(`${MAGIC}${RS}t${String(body.length)}${US}${body}`)).toEqual([
      textSegment(body),
    ]);
  });

  describe('malformed input reads as one bare text segment', () => {
    const cases: [string, string][] = [
      ['a length running past the end', `${MAGIC}${RS}t9${US}ab`],
      ['a length running past its parent', `${MAGIC}${RS}r3${US}${RS}t5${US}abcdef`],
      ['a missing unit separator', `${MAGIC}${RS}t2ab`],
      ['a header with no digits', `${MAGIC}${RS}t${US}ab`],
      ['a length with a leading zero', `${MAGIC}${RS}t01${US}a`],
      ['a length with too many digits', `${MAGIC}${RS}t1234567890${US}a`],
      ['a length that runs into a letter', `${MAGIC}${RS}t1a${US}x`],
      ['bytes between frames', `${MAGIC}${RS}t1${US}ax`],
      ['a header cut off after its separator', `${MAGIC}${RS}`],
      ['a frame that does not start with the separator', `${MAGIC}Xt1${US}a`],
      ['an empty length before a well-formed frame', `${MAGIC}${RS}t${US}${RS}t1${US}a`],
      ['a length followed by something other than the unit separator', `${MAGIC}${RS}t1Xa`],
      ['reasoning nested in reasoning', `${MAGIC}${RS}r8${US}${RS}r4${US}${RS}t0${US}`],
      ['a search row that is not JSON', `${MAGIC}${RS}s2${US}{x`],
      [
        'a search row source that is not http(s)',
        (() => {
          const json = JSON.stringify({
            v: 1,
            searches: [
              { query: 'q', status: 'done', sources: [{ title: 't', url: 'javascript:x' }] },
            ],
            notRun: { limit: 0, invalidQuery: 0 },
          });
          return `${MAGIC}${RS}s${String(json.length)}${US}${json}`;
        })(),
      ],
    ];

    it.each(cases)('%s', (_name, input) => {
      expect(parseAssistantMessage(input)).toEqual([textSegment(input)]);
    });
  });

  it('keeps every frame aligned after a UTF-8 round trip that replaces a lone surrogate', () => {
    const lone = String.fromCodePoint(0xd8_00);
    const serialized = serializeSegments([
      reasoningSegment(textSegment(`a${lone}b`)),
      textSegment('c'),
    ]);
    const decoded = new TextDecoder().decode(new TextEncoder().encode(serialized));
    expect(parseAssistantMessage(decoded)).toEqual([
      reasoningSegment(textSegment('a\uFFFDb')),
      textSegment('c'),
    ]);
  });

  it('frames a body whose length has seven digits with a header of the maximum size', () => {
    const body = 'x'.repeat(1_000_000);
    const serialized = serializeSegments([textSegment(body), textSegment('y')]);
    const header = serialized.slice(
      MESSAGE_MARKER_CHARS,
      serialized.indexOf(US, MESSAGE_MARKER_CHARS) + 1
    );
    expect(header).toBe(`${RS}t1000000${US}`);
    expect(header).toHaveLength(FRAME_HEADER_MAX_CHARS);
    expect(parseAssistantMessage(serialized)).toEqual([textSegment(body), textSegment('y')]);
  });

  it('refuses an eight-digit length even when a body of that length follows', () => {
    const input = `${MAGIC}${RS}t10000000${US}${'x'.repeat(10_000_000)}`;
    const [only] = parseAssistantMessage(input);
    expect(only?.kind === 'text' && only.text === input).toBe(true);
  });

  it('parses a long run of malformed frames within the test timeout', () => {
    const unknownFrame = `${RS}z0${US}`;
    const input = `${MAGIC}${unknownFrame.repeat(200_000)}${RS}t999${US}`;
    expect(parseAssistantMessage(input)).toEqual([textSegment(input)]);
  });
});

describe('native think tags', () => {
  describe('leadingThinkOpen', () => {
    const NOTHING_HELD = { whitespace: '', tag: '' };

    it('holds whitespace alone as undecided', () => {
      expect(leadingThinkOpen(NOTHING_HELD, ' \n')).toEqual({
        state: 'undecided',
        held: { whitespace: ' \n', tag: '' },
      });
    });

    it('holds a proper prefix of the open tag after whitespace as undecided', () => {
      expect(leadingThinkOpen(NOTHING_HELD, '  <thi')).toEqual({
        state: 'undecided',
        held: { whitespace: '  ', tag: '<thi' },
      });
    });

    it('opens on the tag after leading whitespace, handing back the rest', () => {
      expect(leadingThinkOpen(NOTHING_HELD, '\n <think>abc')).toEqual({
        state: 'open',
        rest: 'abc',
      });
    });

    it('opens on a tag completed by the delta after the held prefix', () => {
      expect(leadingThinkOpen({ whitespace: ' ', tag: '<th' }, 'ink>abc')).toEqual({
        state: 'open',
        rest: 'abc',
      });
    });

    it('extends held whitespace with the whitespace a later delta brings', () => {
      expect(leadingThinkOpen({ whitespace: ' ', tag: '' }, '\t<')).toEqual({
        state: 'undecided',
        held: { whitespace: ' \t', tag: '<' },
      });
    });

    it('is absent when the text starts with anything else, handing back everything held', () => {
      expect(leadingThinkOpen({ whitespace: ' ', tag: '' }, 'answer <think>')).toEqual({
        state: 'absent',
        text: ' answer <think>',
      });
    });

    it('is absent on a near miss of the open tag', () => {
      expect(leadingThinkOpen({ whitespace: '', tag: '<think' }, 'ing>')).toEqual({
        state: 'absent',
        text: '<thinking>',
      });
    });

    it('treats whitespace after a held prefix as a miss', () => {
      expect(leadingThinkOpen({ whitespace: '', tag: '<th' }, ' ink>')).toEqual({
        state: 'absent',
        text: '<th ink>',
      });
    });
  });

  describe('splitAtThinkClose', () => {
    it('splits at the first close tag', () => {
      expect(splitAtThinkClose('a</think>b</think>c')).toEqual({
        state: 'closed',
        reasoning: 'a',
        rest: 'b</think>c',
      });
    });

    it('holds back a trailing proper prefix of the close tag', () => {
      expect(splitAtThinkClose('abc</th')).toEqual({
        state: 'open',
        reasoning: 'abc',
        held: '</th',
      });
    });

    it('holds back nothing when no suffix could begin the close tag', () => {
      expect(splitAtThinkClose('abc')).toEqual({ state: 'open', reasoning: 'abc', held: '' });
    });
  });

  describe('afterThinkClose', () => {
    it('drops one separator directly after the close tag', () => {
      expect(afterThinkClose('\n\n\n\nanswer')).toEqual({ state: 'decided', answer: '\n\nanswer' });
    });

    it('keeps text that does not begin with the separator', () => {
      expect(afterThinkClose('answer')).toEqual({ state: 'decided', answer: 'answer' });
    });

    it('is undecided on a single newline, which may begin the separator', () => {
      expect(afterThinkClose('\n')).toEqual({ state: 'undecided' });
    });

    it('is undecided on nothing yet', () => {
      expect(afterThinkClose('')).toEqual({ state: 'undecided' });
    });
  });

  it('separates text by a blank line', () => {
    expect(SEGMENT_TEXT_SEPARATOR).toBe('\n\n');
  });
});

// The reducer's native think rules live here, beside the grammar that recognises
// the tags, because the delimiter lint rule lets the grammar's own tests write them.
describe('native think blocks through the stream reducer', () => {
  const text = (content: string): InferenceEvent => ({ kind: 'text-delta', index: 0, content });
  const reasoning = (content: string): InferenceEvent => ({
    kind: 'reasoning-delta',
    index: 0,
    content,
  });
  const reduceEvents = (events: readonly InferenceEvent[]): AssistantStreamState => {
    let state = createAssistantStream();
    for (const event of events) state = reduceAssistantStream(state, event);
    return state;
  };
  const liveText = (deltas: readonly string[]): string =>
    serializeAssistantStream(reduceEvents(deltas.map((delta) => text(delta)))).text;
  const stored = (events: readonly InferenceEvent[]): readonly Segment[] =>
    parseAssistantMessage(
      serializeAssistantStream(settleAssistantStream(reduceEvents(events))).text
    );
  const storedText = (deltas: readonly string[]): readonly Segment[] =>
    stored(deltas.map((delta) => text(delta)));

  it('reads a leading think block as reasoning and drops one separator after it', () => {
    expect(storedText(['<think>weighing</think>\n\nThe answer'])).toEqual([
      reasoningSegment(textSegment('weighing')),
      textSegment('The answer'),
    ]);
  });

  it('keeps a second blank line after the close tag as answer text', () => {
    expect(storedText(['<think>w</think>\n\n\n\nA'])).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment('\n\nA'),
    ]);
  });

  it('accepts leading whitespace before the open tag', () => {
    expect(storedText([' \n <think>w</think>A'])).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment('A'),
    ]);
  });

  it('reads an open tag split across two deltas as if it arrived whole', () => {
    expect(storedText(['<thi', 'nk>w</think>A'])).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment('A'),
    ]);
  });

  const OPEN_TAG = '<think>';
  const CLOSE_TAG = '</think>';

  it.each(Array.from({ length: OPEN_TAG.length - 1 }, (_value, index) => [index + 1]))(
    'reads an open tag split after %i characters as if it arrived whole',
    (at) => {
      expect(storedText([OPEN_TAG.slice(0, at), `${OPEN_TAG.slice(at)}w</think>A`])).toEqual([
        reasoningSegment(textSegment('w')),
        textSegment('A'),
      ]);
    }
  );

  it.each(Array.from({ length: CLOSE_TAG.length - 1 }, (_value, index) => [index + 1]))(
    'reads a close tag split after %i characters as if it arrived whole',
    (at) => {
      expect(storedText([`<think>w${CLOSE_TAG.slice(0, at)}`, `${CLOSE_TAG.slice(at)}A`])).toEqual([
        reasoningSegment(textSegment('w')),
        textSegment('A'),
      ]);
    }
  );

  it('reads a close tag split across two deltas as if it arrived whole', () => {
    expect(storedText(['<think>w</th', 'ink>A'])).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment('A'),
    ]);
  });

  it('reads a separator split across two deltas as if it arrived whole', () => {
    expect(storedText(['<think>w</think>\n', '\nA'])).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment('A'),
    ]);
  });

  it('holds back a possible open tag from live text until a later delta decides it', () => {
    expect(liveText(['  <thi'])).toBe('');
  });

  it('holds back a possible close tag from live text until a later delta decides it', () => {
    expect(parseAssistantMessage(liveText(['<think>w</th']))).toEqual([
      reasoningSegment(textSegment('w')),
    ]);
  });

  it('treats everything after an unclosed open tag as reasoning with an empty answer', () => {
    expect(storedText(['<think>still thinking</thi'])).toEqual([
      reasoningSegment(textSegment('still thinking</thi')),
    ]);
  });

  it('keeps a held-back prefix that never became the tag as answer text', () => {
    expect(storedText(['  <thi'])).toEqual([textSegment('  <thi')]);
  });

  it('keeps a lone newline after the close tag as answer text when the stream ends', () => {
    expect(storedText(['<think>w</think>\n'])).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment('\n'),
    ]);
  });

  it('reads a think tag after the answer has begun as ordinary answer text', () => {
    expect(storedText(['Answer ', '<think>not reasoning</think>'])).toEqual([
      textSegment('Answer <think>not reasoning</think>'),
    ]);
  });

  it('reads a think tag that does not open the first answer text as answer text', () => {
    expect(storedText(['x<think>y</think>'])).toEqual([textSegment('x<think>y</think>')]);
  });

  it('routes a native think block after streamed reasoning into the same span', () => {
    expect(stored([reasoning('streamed '), text('<think>native</think>A')])).toEqual([
      reasoningSegment(textSegment('streamed native')),
      textSegment('A'),
    ]);
  });

  const searchCall = (id: string): InferenceEvent => ({
    kind: 'tool-call',
    id,
    name: 'webSearch',
    args: { query: 'q' },
  });
  const searchResult = (id: string): InferenceEvent => ({
    kind: 'tool-result',
    id,
    name: 'webSearch',
    result: { results: [] },
  });
  const rootRow: Segment = {
    kind: 'webSearch',
    row: {
      v: 1,
      searches: [{ query: 'q', status: 'done', sources: [] }],
      notRun: { limit: 0, invalidQuery: 0 },
    },
  };
  const stepStart = (step: number): InferenceEvent => ({ kind: 'step-start', step });

  it('interrupts a running search that is the only child of a natively opened span', () => {
    expect(stored([text('<think>'), searchCall('c1')])).toEqual([
      {
        kind: 'reasoning',
        children: [
          {
            kind: 'webSearch',
            row: {
              v: 1,
              searches: [{ query: 'q', status: 'interrupted' }],
              notRun: { limit: 0, invalidQuery: 0 },
            },
          },
        ],
      },
    ]);
  });

  it('reads a text delta after settling as answer text after a closed think block', () => {
    const settled = settleAssistantStream(reduceEvents([text('<think>w')]));
    const more = reduceAssistantStream(settled, text('more'));
    expect(parseAssistantMessage(serializeAssistantStream(more).text)).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment('more'),
    ]);
  });

  it('opens the span at the open tag, so a search before any reasoning nests in it', () => {
    expect(
      stored([text('<think>'), searchCall('c1'), searchResult('c1'), text('w</think>Ans')])
    ).toEqual([{ kind: 'reasoning', children: [rootRow, textSegment('w')] }, textSegment('Ans')]);
  });

  it.each([
    ['the separator', '<think>w</think>\n\n'],
    ['nothing', '<think>w</think>'],
  ])(
    'closes the span at the close tag followed by %s, so a later search sits at the root',
    (_name, delta) => {
      expect(
        stored([text(delta), searchCall('c1'), searchResult('c1'), stepStart(1), text('Answer')])
      ).toEqual([reasoningSegment(textSegment('w')), rootRow, textSegment('Answer')]);
    }
  );

  it('resolves a lone newline held after the close tag as answer text before a search', () => {
    expect(
      stored([text('<think>w</think>\n'), searchCall('c1'), searchResult('c1'), text('Answer')])
    ).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment('\n'),
      rootRow,
      textSegment('Answer'),
    ]);
  });

  it.each([
    ['whitespace', '\n'],
    ['a prefix of the open tag', '<th'],
  ])('resolves held %s after streamed reasoning as answer text before a search', (_name, held) => {
    expect(
      stored([reasoning('w'), text(held), searchCall('c1'), searchResult('c1'), text('Answer')])
    ).toEqual([
      reasoningSegment(textSegment('w')),
      textSegment(held),
      rootRow,
      textSegment('Answer'),
    ]);
  });

  it('resolves held whitespace as answer text before later reasoning', () => {
    expect(stored([text(' '), reasoning('w'), text('<think>not native</think>')])).toEqual([
      textSegment(' '),
      reasoningSegment(textSegment('w')),
      textSegment('<think>not native</think>'),
    ]);
  });

  it('grows linearly over one large delta of native reasoning, like plain text does', () => {
    const SIZE = 20_000;
    const fastestMs = (deltas: readonly string[]): number => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run += 1) {
        const start = performance.now();
        reduceEvents(deltas.map((delta) => text(delta)));
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    const nativeN = fastestMs([`<think>${'x'.repeat(SIZE)}`]);
    const native4N = fastestMs([`<think>${'x'.repeat(4 * SIZE)}`]);
    const plain4N = fastestMs(['x'.repeat(4 * SIZE)]);
    // Linear growth makes 4N cost about four times N; a rescan makes it about sixteen.
    expect(native4N).toBeLessThan(8 * nativeN + 25);
    expect(native4N).toBeLessThan(20 * plain4N + 25);
  });

  it('applies the rule only once per message', () => {
    expect(storedText(['<think>a</think>B', '<think>c</think>'])).toEqual([
      reasoningSegment(textSegment('a')),
      textSegment('B<think>c</think>'),
    ]);
  });
});
