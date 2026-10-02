import { describe, expect, it } from 'vitest';
import {
  WEB_SEARCH_ROW_MAX_CHARS,
  WEB_SEARCH_STORED_QUERY_MAX_CHARS,
} from '../web-search/web-search-row.ts';
import { TOOL_CALL_CAP_MAX } from '../affordability/tool-loop.ts';
import {
  ASSISTANT_FRAMING_MAX_CHARS,
  FRAME_HEADER_MAX_CHARS,
  MESSAGE_MARKER_CHARS,
  parseAssistantMessage,
} from './grammar.ts';
import { assistantAnswerText, assistantHistoryText, webSearchRowsInOrder } from './projection.ts';
import {
  ASSISTANT_FRAME_CEILING,
  ASSISTANT_FRAME_LIMIT,
  ASSISTANT_SEPARATOR_LIMIT,
  createAssistantStream,
  reduceAssistantStream,
  serializeAssistantStream,
  settleAssistantStream,
} from './reducer.ts';
import type { AssistantStreamState } from './reducer.ts';
import type { Segment } from './segments.ts';
import type { WebSearchRow } from '../web-search/web-search-row.ts';
import type { InferenceEvent } from '../workflow/inference.ts';

const reasoning = (content: string): InferenceEvent => ({
  kind: 'reasoning-delta',
  index: 0,
  content,
});
const text = (content: string): InferenceEvent => ({ kind: 'text-delta', index: 0, content });
const stepStart = (step: number): InferenceEvent => ({ kind: 'step-start', step });
const searchCall = (id: string, query: string): InferenceEvent => ({
  kind: 'tool-call',
  id,
  name: 'webSearch',
  args: { query },
});
const searchResult = (id: string, urls: readonly string[]): InferenceEvent => ({
  kind: 'tool-result',
  id,
  name: 'webSearch',
  result: {
    results: urls.map((url) => ({ title: `title of ${url}`, url, snippet: 'snippet' })),
  },
});

function reduceAll(events: readonly InferenceEvent[]): AssistantStreamState {
  let state = createAssistantStream();
  for (const event of events) state = reduceAssistantStream(state, event);
  return state;
}

function storedTree(events: readonly InferenceEvent[]): readonly Segment[] {
  return parseAssistantMessage(
    serializeAssistantStream(settleAssistantStream(reduceAll(events))).text
  );
}

const doneSearch = (query: string, urls: readonly string[]): Segment => ({
  kind: 'webSearch',
  row: {
    v: 1,
    searches: [
      {
        query,
        status: 'done',
        sources: urls.map((url) => ({ title: `title of ${url}`, url })),
      },
    ],
    notRun: { limit: 0, invalidQuery: 0 },
  },
});

describe('reduceAssistantStream placement', () => {
  it('nests a search made while reasoning inside the reasoning segment', () => {
    const tree = storedTree([
      stepStart(0),
      reasoning('think'),
      searchCall('c1', 'q'),
      searchResult('c1', ['https://a.example/1', 'https://b.example/2']),
      stepStart(1),
      reasoning('more'),
      text('Answer'),
    ]);
    expect(tree).toEqual([
      {
        kind: 'reasoning',
        children: [
          { kind: 'text', text: 'think' },
          doneSearch('q', ['https://a.example/1', 'https://b.example/2']),
          { kind: 'text', text: 'more' },
        ],
      },
      { kind: 'text', text: 'Answer' },
    ]);
  });

  it('keeps a search made after the answer started inline in the answer', () => {
    const tree = storedTree([
      text('A'),
      searchCall('c1', 'q'),
      searchResult('c1', ['https://a.example/1']),
      stepStart(1),
      text('B'),
    ]);
    expect(tree).toEqual([
      { kind: 'text', text: 'A' },
      doneSearch('q', ['https://a.example/1']),
      { kind: 'text', text: 'B' },
    ]);
  });
});

const searchError = (id: string, reason: 'failed' | 'limit' | 'invalid-input'): InferenceEvent => ({
  kind: 'tool-error',
  id,
  name: 'webSearch',
  reason,
});

const row = (searches: WebSearchRow['searches'], notRun?: WebSearchRow['notRun']): Segment => ({
  kind: 'webSearch',
  row: { v: 1, searches, notRun: notRun ?? { limit: 0, invalidQuery: 0 } },
});

describe('reduceAssistantStream layouts', () => {
  it('stores a plain answer bare, byte-identical to the model text', () => {
    const state = settleAssistantStream(reduceAll([stepStart(0), text('Hel'), text('lo')]));
    expect(serializeAssistantStream(state).text).toBe('Hello');
  });

  it('stores reasoning ahead of the answer', () => {
    expect(storedTree([reasoning('th'), reasoning('ink'), text('Answer')])).toEqual([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'think' }] },
      { kind: 'text', text: 'Answer' },
    ]);
  });

  it('opens a new reasoning span when reasoning resumes after the answer began', () => {
    expect(storedTree([reasoning('a'), text('B'), reasoning('c'), text('D')])).toEqual([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'a' }] },
      { kind: 'text', text: 'B' },
      { kind: 'reasoning', children: [{ kind: 'text', text: 'c' }] },
      { kind: 'text', text: 'D' },
    ]);
  });

  it('puts a search made before any content first at the root', () => {
    expect(
      storedTree([searchCall('c1', 'q'), searchResult('c1', []), stepStart(1), text('A')])
    ).toEqual([doneSearch('q', []), { kind: 'text', text: 'A' }]);
  });

  it('nests a search made while reasoning and keeps a later search inline in the answer', () => {
    expect(
      storedTree([
        stepStart(0),
        reasoning('t1'),
        searchCall('c1', 'q1'),
        searchResult('c1', ['https://a/']),
        stepStart(1),
        reasoning('t2'),
        text('A1'),
        searchCall('c2', 'q2'),
        searchResult('c2', ['https://b/']),
        stepStart(2),
        text('A2'),
      ])
    ).toEqual([
      {
        kind: 'reasoning',
        children: [
          { kind: 'text', text: 't1' },
          doneSearch('q1', ['https://a/']),
          { kind: 'text', text: 't2' },
        ],
      },
      { kind: 'text', text: 'A1' },
      doneSearch('q2', ['https://b/']),
      { kind: 'text', text: 'A2' },
    ]);
  });

  it('keeps a search made after reasoning and answer text in one step inline in the answer', () => {
    expect(
      storedTree([reasoning('r'), text('A'), searchCall('c1', 'q'), searchResult('c1', [])])
    ).toEqual([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'r' }] },
      { kind: 'text', text: 'A' },
      doneSearch('q', []),
    ]);
  });
});

describe('reduceAssistantStream rows', () => {
  it('joins parallel searches in one step into one row', () => {
    expect(
      storedTree([
        searchCall('c1', 'a'),
        searchCall('c2', 'b'),
        searchResult('c2', ['https://b/']),
        searchResult('c1', ['https://a/']),
      ])
    ).toEqual([
      row([
        {
          query: 'a',
          status: 'done',
          sources: [{ title: 'title of https://a/', url: 'https://a/' }],
        },
        {
          query: 'b',
          status: 'done',
          sources: [{ title: 'title of https://b/', url: 'https://b/' }],
        },
      ]),
    ]);
  });

  it('joins back-to-back searches across steps into one row when nothing lies between', () => {
    const tree = storedTree([
      stepStart(0),
      searchCall('c1', 'a'),
      searchResult('c1', []),
      stepStart(1),
      searchCall('c2', 'b'),
      searchResult('c2', []),
      stepStart(2),
      text('A'),
    ]);
    expect(tree).toEqual([
      row([
        { query: 'a', status: 'done', sources: [] },
        { query: 'b', status: 'done', sources: [] },
      ]),
      { kind: 'text', text: 'A' },
    ]);
  });

  it('marks a search whose tool failed as failed', () => {
    expect(storedTree([searchCall('c1', 'q'), searchError('c1', 'failed')])).toEqual([
      row([{ query: 'q', status: 'failed' }]),
    ]);
  });

  it('counts a call the dispatch cap refused instead of listing it', () => {
    expect(
      storedTree([
        searchCall('c1', 'a'),
        searchCall('c2', 'b'),
        searchError('c1', 'limit'),
        searchResult('c2', []),
      ])
    ).toEqual([row([{ query: 'b', status: 'done', sources: [] }], { limit: 1, invalidQuery: 0 })]);
  });

  it('counts a call with rejected input instead of listing it', () => {
    expect(storedTree([searchCall('c1', ''), searchError('c1', 'invalid-input')])).toEqual([
      row([], { limit: 0, invalidQuery: 1 }),
    ]);
  });

  it('stores a search still running inside reasoning at the end as interrupted', () => {
    expect(storedTree([reasoning('r'), searchCall('c1', 'q')])).toEqual([
      {
        kind: 'reasoning',
        children: [{ kind: 'text', text: 'r' }, row([{ query: 'q', status: 'interrupted' }])],
      },
    ]);
  });

  it('stores a search still running at the end as interrupted', () => {
    expect(storedTree([searchCall('c1', 'q')])).toEqual([
      row([{ query: 'q', status: 'interrupted' }]),
    ]);
  });

  it('shows a running search as searching in live text', () => {
    const live = serializeAssistantStream(reduceAll([searchCall('c1', 'q')])).text;
    expect(parseAssistantMessage(live)).toEqual([row([{ query: 'q', status: 'searching' }])]);
  });

  it('stores only the title and url of each http(s) page a search found', () => {
    const result: InferenceEvent = {
      kind: 'tool-result',
      id: 'c1',
      name: 'webSearch',
      result: {
        results: [
          { title: 'Kept', url: 'https://kept.example/', snippet: 'not stored', age: '1 day' },
          { title: 'Dropped', url: 'javascript:alert(1)', snippet: '' },
        ],
      },
    };
    expect(storedTree([searchCall('c1', 'q'), result])).toEqual([
      row([
        { query: 'q', status: 'done', sources: [{ title: 'Kept', url: 'https://kept.example/' }] },
      ]),
    ]);
  });

  it('stores a result of an unexpected shape as a search with no sources', () => {
    const result: InferenceEvent = {
      kind: 'tool-result',
      id: 'c1',
      name: 'webSearch',
      result: 'x',
    };
    expect(storedTree([searchCall('c1', 'q'), result])).toEqual([
      row([{ query: 'q', status: 'done', sources: [] }]),
    ]);
  });

  it('cuts a long query to the stored limit', () => {
    expect(storedTree([searchCall('c1', 'x'.repeat(300))])).toEqual([
      row([{ query: 'x'.repeat(WEB_SEARCH_STORED_QUERY_MAX_CHARS), status: 'interrupted' }]),
    ]);
  });

  it('stores an empty query when the call carries none', () => {
    const call: InferenceEvent = { kind: 'tool-call', id: 'c1', name: 'webSearch', args: 3 };
    expect(storedTree([call])).toEqual([row([{ query: '', status: 'interrupted' }])]);
  });

  it('ignores a call to another tool', () => {
    const call: InferenceEvent = { kind: 'tool-call', id: 'c1', name: 'otherTool', args: {} };
    expect(storedTree([call, text('A')])).toEqual([{ kind: 'text', text: 'A' }]);
  });

  it('ignores a result or error for an unknown call', () => {
    expect(
      storedTree([text('A'), searchResult('nope', []), searchError('nope', 'failed')])
    ).toEqual([{ kind: 'text', text: 'A' }]);
  });

  it('ignores a second result for a search that already finished', () => {
    expect(
      storedTree([
        searchCall('c1', 'q'),
        searchResult('c1', ['https://a/']),
        searchResult('c1', ['https://b/']),
      ])
    ).toEqual([doneSearch('q', ['https://a/'])]);
  });

  it('ignores a result for a call a cap refusal already removed', () => {
    expect(
      storedTree([
        searchCall('a', 'first'),
        searchCall('b', 'second'),
        searchError('a', 'limit'),
        searchResult('a', ['https://a/']),
      ])
    ).toEqual([row([{ query: 'second', status: 'interrupted' }], { limit: 1, invalidQuery: 0 })]);
  });

  it('shifts only the entries after the one that left the row', () => {
    expect(
      storedTree([
        searchCall('c1', 'a'),
        searchCall('c2', 'b'),
        searchCall('c3', 'c'),
        searchError('c2', 'limit'),
        searchResult('c1', []),
      ])
    ).toEqual([
      row(
        [
          { query: 'a', status: 'done', sources: [] },
          { query: 'c', status: 'interrupted' },
        ],
        { limit: 1, invalidQuery: 0 }
      ),
    ]);
  });

  it('keeps entries of a root row apart from a nested row whose path digits match', () => {
    // A row nested at root 1, child 1 and a root row at index 11: their paths
    // must not share a key.
    const tree = storedTree([
      text('lead'),
      reasoning('r'),
      searchCall('c0', 'q'),
      searchCall('c1', 'q'),
      ...Array.from({ length: 4 }, (_value, index) => [
        text(`a${String(index)}`),
        searchCall(`s${String(index)}`, 'q'),
      ]).flat(),
      text('a10'),
      searchCall('d0', 'first'),
      searchCall('d1', 'second'),
      searchError('c0', 'limit'),
      searchResult('d1', []),
    ]);
    expect(tree[11]).toEqual(
      row([
        { query: 'first', status: 'interrupted' },
        { query: 'second', status: 'done', sources: [] },
      ])
    );
  });

  it('shifts entries only within the row an entry left', () => {
    expect(
      storedTree([
        searchCall('a', 'first'),
        searchCall('a2', 'second'),
        text('t'),
        searchCall('b', 'third'),
        searchCall('c', 'fourth'),
        searchError('b', 'invalid-input'),
        searchResult('a2', []),
        searchResult('c', []),
      ])
    ).toEqual([
      row([
        { query: 'first', status: 'interrupted' },
        { query: 'second', status: 'done', sources: [] },
      ]),
      { kind: 'text', text: 't' },
      row([{ query: 'fourth', status: 'done', sources: [] }], { limit: 0, invalidQuery: 1 }),
    ]);
  });

  it('attaches a later result to the right entry after an earlier entry left the row', () => {
    expect(
      storedTree([
        searchCall('c1', 'a'),
        searchCall('c2', 'b'),
        searchCall('c3', 'c'),
        searchError('c1', 'limit'),
        searchResult('c3', []),
        searchError('c2', 'failed'),
      ])
    ).toEqual([
      row(
        [
          { query: 'b', status: 'failed' },
          { query: 'c', status: 'done', sources: [] },
        ],
        { limit: 1, invalidQuery: 0 }
      ),
    ]);
  });

  it('counts only done entries as billed searches', () => {
    const tree = storedTree([
      searchCall('c1', 'a'),
      searchCall('c2', 'b'),
      searchCall('c3', 'c'),
      searchResult('c1', []),
      searchError('c2', 'failed'),
    ]);
    const [first] = tree;
    const searches = first?.kind === 'webSearch' ? first.row.searches : [];
    expect(searches.filter((entry) => entry.status === 'done')).toHaveLength(1);
  });
});

describe('reduceAssistantStream step separator', () => {
  it('separates two steps of answer text with a blank line when nothing lies between', () => {
    expect(storedTree([stepStart(0), text('A'), stepStart(1), text('B')])).toEqual([
      { kind: 'text', text: 'A\n\nB' },
    ]);
  });

  it('separates two steps of reasoning with a blank line inside one span', () => {
    expect(
      storedTree([stepStart(0), reasoning('a'), stepStart(1), reasoning('b'), text('C')])
    ).toEqual([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'a\n\nb' }] },
      { kind: 'text', text: 'C' },
    ]);
  });

  it('adds no separator between tokens of one step', () => {
    expect(storedTree([stepStart(3), text('A'), text('B')])).toEqual([
      { kind: 'text', text: 'AB' },
    ]);
  });

  it('adds no separator when a row lies between the steps', () => {
    expect(
      storedTree([
        text('A'),
        searchCall('c1', 'q'),
        searchResult('c1', []),
        stepStart(1),
        text('B'),
      ])
    ).toEqual([{ kind: 'text', text: 'A' }, doneSearch('q', []), { kind: 'text', text: 'B' }]);
  });

  it('adds no separator to the first text of a step with nothing before it', () => {
    expect(storedTree([stepStart(0), stepStart(1), text('A')])).toEqual([
      { kind: 'text', text: 'A' },
    ]);
  });
});

describe('reduceAssistantStream exhaustiveness', () => {
  it('refuses an event kind outside the inference event union', () => {
    // A cast is the only way to reach the exhaustiveness guard: the union is closed.
    const unknownEvent = { kind: 'unknown-kind' } as unknown as InferenceEvent;
    expect(() => reduceAssistantStream(createAssistantStream(), unknownEvent)).toThrow(
      'Exhaustiveness check failed'
    );
  });

  it('refuses a native think phase this module never writes', () => {
    // A cast is the only way to reach the exhaustiveness guard: the phases are closed.
    const forged = {
      ...createAssistantStream(),
      native: { phase: 'unknown-phase' },
    } as unknown as AssistantStreamState;
    expect(() => reduceAssistantStream(forged, text('x'))).toThrow('Exhaustiveness check failed');
  });
});

describe('reduceAssistantStream events that carry no content', () => {
  it('leaves the state unchanged on stream, finish and media events', () => {
    const start = reduceAll([text('A')]);
    const events: InferenceEvent[] = [
      { kind: 'stream-start', modelId: 'm' },
      { kind: 'step-finish', step: 0, generationId: 'g' },
      { kind: 'media-start', index: 0, modality: 'image', mimeType: 'image/png' },
      { kind: 'media-progress', index: 0, percent: 5 },
      {
        kind: 'media-done',
        index: 0,
        value: { ref: 'r', mimeType: 'image/png', modality: 'image', byteLength: 1, metadata: {} },
      },
      {
        kind: 'finish',
        metadata: { usage: { inputTokens: 1, outputTokens: 1 }, finishReason: 'stop' },
      },
    ];
    for (const event of events) expect(reduceAssistantStream(start, event)).toBe(start);
  });

  it('ignores empty deltas', () => {
    expect(storedTree([reasoning(''), text(''), text('A')])).toEqual([{ kind: 'text', text: 'A' }]);
  });

  it('serializes an empty stream as the empty string', () => {
    expect(serializeAssistantStream(settleAssistantStream(createAssistantStream())).text).toBe('');
  });
});

describe('reduceAssistantStream frame limit', () => {
  function alternating(pairs: number): InferenceEvent[] {
    return Array.from({ length: pairs }, (_value, index) => [
      reasoning(`r${String(index)}`),
      text(`a${String(index)}`),
    ]).flat();
  }

  it('opens no frame past the limit once every kind has a frame to join', () => {
    const state = settleAssistantStream(reduceAll(alternating(200)));
    expect(state.frameCount).toBeLessThanOrEqual(ASSISTANT_FRAME_LIMIT);
  });

  it('keeps every character of content past the limit', () => {
    const state = settleAssistantStream(reduceAll(alternating(200)));
    const tree = parseAssistantMessage(serializeAssistantStream(state).text);
    const allText = JSON.stringify(tree);
    expect(allText).toContain('r199');
    expect(allText).toContain('a199');
  });

  it('keeps reasoning inside reasoning past the frame limit', () => {
    const events = Array.from({ length: 40 }, (_value, index) => [
      reasoning(`R${String(index)};`),
      text(`A${String(index)};`),
    ]).flat();
    const stored = serializeAssistantStream(settleAssistantStream(reduceAll(events))).text;
    expect(assistantAnswerText(stored)).not.toContain('R');
    expect(assistantHistoryText(stored)).not.toContain('R');
    const reasoningText = parseAssistantMessage(stored)
      .flatMap((node) => (node.kind === 'reasoning' ? node.children : []))
      .map((child) => (child.kind === 'text' ? child.text : ''))
      .join('');
    expect(reasoningText).toContain('R39;');
  });

  it('joins a search in open reasoning to the latest row at any depth past the limit', () => {
    // Five frames, then three per pair, lands exactly on the limit before the
    // second search, so it has no room of its own.
    const events = [
      text('lead'),
      reasoning('r'),
      searchCall('c0', 'first'),
      reasoning('r'),
      ...Array.from({ length: 30 }, () => [text('a'), reasoning('r')]).flat(),
      searchCall('c1', 'second'),
    ];
    const tree = parseAssistantMessage(
      serializeAssistantStream(settleAssistantStream(reduceAll(events))).text
    );
    expect(webSearchRowsInOrder(tree)).toHaveLength(1);
    const firstSpan = tree[1];
    const nested = firstSpan?.kind === 'reasoning' ? firstSpan.children[1] : undefined;
    expect(nested).toEqual(
      row([
        { query: 'first', status: 'interrupted' },
        { query: 'second', status: 'interrupted' },
      ])
    );
  });

  it('opens frames up to exactly the frame limit', () => {
    const state = reduceAll(
      Array.from({ length: ASSISTANT_FRAME_LIMIT / 3 }, (_value, index) => [
        reasoning(`r${String(index)}`),
        text(`a${String(index)}`),
      ]).flat()
    );
    expect(state.frameCount).toBe(ASSISTANT_FRAME_LIMIT);
    expect(state.tree).toHaveLength((ASSISTANT_FRAME_LIMIT / 3) * 2);
  });

  it('joins the latest span rather than open a span whose text would pass the limit', () => {
    const pairs = ASSISTANT_FRAME_LIMIT / 3 - 1;
    const state = reduceAll([
      ...Array.from({ length: pairs }, (_value, index) => [
        reasoning(`r${String(index)}`),
        text(`a${String(index)}`),
      ]).flat(),
      searchCall('c1', 'q'),
      text('b'),
      reasoning('late'),
    ]);
    expect(state.frameCount).toBe(ASSISTANT_FRAME_LIMIT - 1);
    const latestSpan = state.tree[(pairs - 1) * 2];
    expect(latestSpan).toEqual({
      kind: 'reasoning',
      children: [{ kind: 'text', text: `r${String(pairs - 1)}late` }],
    });
  });

  const fullPairs = (): InferenceEvent[] =>
    Array.from({ length: ASSISTANT_FRAME_LIMIT / 3 }, (_value, index) => [
      reasoning(`r${String(index)}`),
      text(`a${String(index)}`),
    ]).flat();

  it('joins a search past the limit to a row that is the last child of the last span', () => {
    const pairs = ASSISTANT_FRAME_LIMIT / 3 - 1;
    const tree = storedTree([
      ...Array.from({ length: pairs }, (_value, index) => [
        reasoning(`r${String(index)}`),
        text(`a${String(index)}`),
      ]).flat(),
      reasoning('r'),
      searchCall('c1', 'first'),
      text('A'),
      searchCall('c2', 'second'),
    ]);
    expect(webSearchRowsInOrder(tree)).toHaveLength(1);
    expect(tree.at(-1)).toEqual({
      kind: 'reasoning',
      children: [
        { kind: 'text', text: 'r' },
        row([
          { query: 'first', status: 'interrupted' },
          { query: 'second', status: 'interrupted' },
        ]),
      ],
    });
  });

  it('opens a row past the limit when the message has none yet', () => {
    const tree = storedTree([...fullPairs(), searchCall('c1', 'q')]);
    expect(tree.at(-1)).toEqual(row([{ query: 'q', status: 'interrupted' }]));
  });

  it('joins the latest answer text past the limit, not an earlier one', () => {
    const tree = storedTree([...fullPairs(), searchCall('c1', 'q'), text('Z')]);
    const last = ASSISTANT_FRAME_LIMIT / 3 - 1;
    expect(tree[last * 2 + 1]).toEqual({ kind: 'text', text: `a${String(last)}Z` });
    expect(tree[1]).toEqual({ kind: 'text', text: 'a0' });
  });

  it('joins the only answer text past the limit when it is the first root frame', () => {
    // One text, one span of two frames, then a search and a thought per two frames.
    const events = [
      text('lead'),
      reasoning('r'),
      ...Array.from({ length: (ASSISTANT_FRAME_LIMIT - 4) / 2 }, (_value, index) => [
        searchCall(`c${String(index)}`, 'q'),
        reasoning('r'),
      ]).flat(),
      searchCall('last', 'q'),
      text('Z'),
    ];
    const state = reduceAll(events);
    expect(state.frameCount).toBe(ASSISTANT_FRAME_LIMIT);
    expect(state.tree[0]).toEqual({ kind: 'text', text: 'leadZ' });
    expect(state.tree).toHaveLength(2);
  });

  it('joins a search past the limit to a root row that is the first root frame', () => {
    // One row, then a span and an answer text per three frames, then a span
    // whose two frames reach the limit exactly.
    const events = [
      searchCall('c0', 'first'),
      ...Array.from({ length: (ASSISTANT_FRAME_LIMIT - 3) / 3 }, (_value, index) => [
        reasoning(`r${String(index)}`),
        text(`a${String(index)}`),
      ]).flat(),
      reasoning('r'),
      text('b'),
      searchCall('c1', 'second'),
    ];
    const state = reduceAll(events);
    expect(state.frameCount).toBe(ASSISTANT_FRAME_LIMIT);
    const tree = settleAssistantStream(state).tree;
    expect(webSearchRowsInOrder(tree)).toHaveLength(1);
    expect(tree[0]).toEqual(
      row([
        { query: 'first', status: 'interrupted' },
        { query: 'second', status: 'interrupted' },
      ])
    );
  });

  it('opens a frame past the limit when its kind has none to join', () => {
    const events = [
      ...Array.from({ length: 60 }, (_value, index) => [
        reasoning(`r${String(index)}`),
        searchCall(`c${String(index)}`, 'q'),
        searchError(`c${String(index)}`, 'failed'),
      ]).flat(),
      text('A'),
    ];
    const tree = parseAssistantMessage(
      serializeAssistantStream(settleAssistantStream(reduceAll(events))).text
    );
    expect(tree.at(-1)).toEqual({ kind: 'text', text: 'A' });
  });

  it('derives the most separators the framing allowance holds at the frame ceiling', () => {
    const worstCase = (separators: number): number =>
      MESSAGE_MARKER_CHARS +
      ASSISTANT_FRAME_CEILING * FRAME_HEADER_MAX_CHARS +
      separators * '\n\n'.length;
    expect(worstCase(ASSISTANT_SEPARATOR_LIMIT)).toBeLessThanOrEqual(ASSISTANT_FRAMING_MAX_CHARS);
    expect(worstCase(ASSISTANT_SEPARATOR_LIMIT + 1)).toBeGreaterThan(ASSISTANT_FRAMING_MAX_CHARS);
  });

  it('writes sixty-seven separators when every step brings answer text', () => {
    const text400 = serializeAssistantStream(
      settleAssistantStream(
        reduceAll(
          Array.from({ length: 400 }, (_value, index) => [stepStart(index), text('x')]).flat()
        )
      )
    ).text;
    expect(text400.split('\n\n')).toHaveLength(68);
  });

  it('keeps the derived framing bound within the framing allowance', () => {
    expect(ASSISTANT_SEPARATOR_LIMIT).toBeGreaterThan(0);
    const state = settleAssistantStream(
      reduceAll(
        Array.from({ length: 400 }, (_value, index) => [stepStart(index), text('x')]).flat()
      )
    );
    expect(state.separatorCount).toBe(ASSISTANT_SEPARATOR_LIMIT);
    const serialized = serializeAssistantStream(state).text;
    expect(serialized.split('\n\n')).toHaveLength(ASSISTANT_SEPARATOR_LIMIT + 1);
    expect(serialized.length - 400).toBeLessThanOrEqual(ASSISTANT_FRAMING_MAX_CHARS);
  });

  it('reaches the frame ceiling when a span and its text open past the limit', () => {
    // Answer text and a search per two frames leave no span to join.
    const state = reduceAll([
      ...Array.from({ length: ASSISTANT_FRAME_LIMIT / 2 }, (_value, index) => [
        text(`a${String(index)}`),
        searchCall(`c${String(index)}`, 'q'),
      ]).flat(),
      reasoning('r'),
    ]);
    expect(state.frameCount).toBe(ASSISTANT_FRAME_CEILING);
    expect(state.tree.at(-1)).toEqual({
      kind: 'reasoning',
      children: [{ kind: 'text', text: 'r' }],
    });
  });
});

describe('reduceAssistantStream search cap', () => {
  const calls = (count: number, from = 0): InferenceEvent[] =>
    Array.from({ length: count }, (_value, index) => searchCall(`c${String(from + index)}`, 'q'));

  it('creates no entry for a search past the per-message cap and counts it as not run', () => {
    const [only] = storedTree(calls(TOOL_CALL_CAP_MAX + 1));
    const searches = only?.kind === 'webSearch' ? only.row : undefined;
    expect(searches?.searches).toHaveLength(TOOL_CALL_CAP_MAX);
    expect(searches?.notRun).toEqual({ limit: 1, invalidQuery: 0 });
  });

  it('ignores a later result or error for a search past the cap', () => {
    const pastCap = `c${String(TOOL_CALL_CAP_MAX)}`;
    const [only] = storedTree([
      ...calls(TOOL_CALL_CAP_MAX + 1),
      searchResult(pastCap, ['https://a/']),
      searchError(pastCap, 'limit'),
    ]);
    const counted = only?.kind === 'webSearch' ? only.row : undefined;
    expect(counted?.notRun).toEqual({ limit: 1, invalidQuery: 0 });
    expect(counted?.searches.every((entry) => entry.status === 'interrupted')).toBe(true);
  });

  it('ignores results for a call id reused by a search past the cap', () => {
    const [only] = storedTree([
      ...calls(TOOL_CALL_CAP_MAX),
      searchCall('c0', 'again'),
      searchResult('c0', ['https://a/']),
    ]);
    const counted = only?.kind === 'webSearch' ? only.row : undefined;
    expect(counted?.notRun).toEqual({ limit: 1, invalidQuery: 0 });
    expect(counted?.searches[0]).toEqual({ query: 'q', status: 'interrupted' });
  });

  it('counts a search past the cap on the row it would have joined', () => {
    const tree = storedTree([...calls(TOOL_CALL_CAP_MAX), text('A'), searchCall('late', 'q')]);
    expect(tree.at(-1)).toEqual(row([], { limit: 1, invalidQuery: 0 }));
  });

  it('holds exactly the cap of entries after a removal and more calls than the cap', () => {
    const tree = storedTree([
      searchCall('refused', 'q'),
      searchError('refused', 'invalid-input'),
      ...calls(TOOL_CALL_CAP_MAX + 1),
    ]);
    const [only] = tree;
    const counted = only?.kind === 'webSearch' ? only.row : undefined;
    expect(counted?.searches).toHaveLength(TOOL_CALL_CAP_MAX);
    expect(counted?.notRun).toEqual({ limit: 1, invalidQuery: 1 });
  });

  it('counts the cap on entries the message still holds, not on calls ever made', () => {
    const tree = storedTree([
      searchCall('refused', 'q'),
      searchError('refused', 'invalid-input'),
      ...calls(TOOL_CALL_CAP_MAX),
    ]);
    const [only] = tree;
    const counted = only?.kind === 'webSearch' ? only.row : undefined;
    expect(counted?.searches).toHaveLength(TOOL_CALL_CAP_MAX);
    expect(counted?.notRun).toEqual({ limit: 0, invalidQuery: 1 });
  });

  // JSON escapes a control character to six characters, the most any character grows.
  const escapedQuery = String.fromCodePoint(1).repeat(WEB_SEARCH_STORED_QUERY_MAX_CHARS);

  function storedRowChars(events: readonly InferenceEvent[]): { chars: number; dropped: number } {
    const serialized = serializeAssistantStream(settleAssistantStream(reduceAll(events)));
    let chars = 0;
    for (const stored of webSearchRowsInOrder(parseAssistantMessage(serialized.text))) {
      chars += JSON.stringify(stored).length;
    }
    return { chars, dropped: serialized.droppedSourceCount };
  }

  it('fits the cap of unresolved maximally escaped searches in one row within the row allowance', () => {
    const events = Array.from({ length: TOOL_CALL_CAP_MAX + 5 }, (_value, index) =>
      searchCall(`c${String(index)}`, escapedQuery)
    );
    const { chars, dropped } = storedRowChars(events);
    expect(dropped).toBe(0);
    expect(chars).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
  });

  it('fits the cap of unresolved maximally escaped searches in separate rows within the row allowance', () => {
    const events = Array.from({ length: TOOL_CALL_CAP_MAX + 5 }, (_value, index) => [
      searchCall(`c${String(index)}`, escapedQuery),
      text('t'),
    ]).flat();
    const { chars, dropped } = storedRowChars(events);
    expect(dropped).toBe(0);
    expect(chars).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
  });

  it('fits the cap of unresolved maximally escaped searches nested in reasoning within the row allowance', () => {
    const events = [
      reasoning('r'),
      ...Array.from({ length: TOOL_CALL_CAP_MAX + 5 }, (_value, index) => [
        searchCall(`c${String(index)}`, escapedQuery),
        reasoning('r'),
      ]).flat(),
    ];
    const { chars, dropped } = storedRowChars(events);
    expect(dropped).toBe(0);
    expect(chars).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
    const tree = storedTree(events);
    expect(tree.filter((node) => node.kind === 'webSearch')).toEqual([]);
  });
});

describe('serializeAssistantStream', () => {
  const longUrl = (n: number): string => `https://example.com/${'p'.repeat(400)}/${String(n)}`;

  function storedSources(text: string): number {
    let count = 0;
    for (const stored of webSearchRowsInOrder(parseAssistantMessage(text))) {
      for (const entry of stored.searches) count += entry.sources?.length ?? 0;
    }
    return count;
  }

  it('reports no dropped sources when the rows fit', () => {
    expect(
      serializeAssistantStream(reduceAll([searchCall('c1', 'q'), searchResult('c1', [longUrl(1)])]))
        .droppedSourceCount
    ).toBe(0);
  });

  it('drops sources from the last row backwards until the rows fit, and reports how many', () => {
    const urls = (from: number): string[] =>
      Array.from({ length: 5 }, (_value, index) => longUrl(from + index));
    const events: InferenceEvent[] = [];
    for (let call = 0; call < 10; call += 1) {
      events.push(
        searchCall(`c${String(call)}`, 'q'),
        searchResult(`c${String(call)}`, urls(call * 5)),
        text('t')
      );
    }
    const serialized = serializeAssistantStream(reduceAll(events));
    expect(serialized.droppedSourceCount).toBeGreaterThan(0);
    expect(serialized.droppedSourceCount).toBe(50 - storedSources(serialized.text));
    const rows = parseAssistantMessage(serialized.text).flatMap((node) =>
      node.kind === 'webSearch' ? [node.row] : []
    );
    const rowChars = rows.reduce((sum, r) => sum + JSON.stringify(r).length, 0);
    expect(rowChars).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
    expect(rows[0]?.searches[0]?.sources).toHaveLength(5);
    expect(rows.at(-1)?.searches[0]?.sources).toHaveLength(0);
  });

  it('keeps rows that fill the allowance exactly without dropping a source', () => {
    const emptyTitle: WebSearchRow = {
      v: 1,
      searches: [
        {
          query: 'q',
          status: 'done',
          sources: [
            { title: 'a', url: 'https://a/' },
            { title: '', url: 'https://b/' },
          ],
        },
      ],
      notRun: { limit: 0, invalidQuery: 0 },
    };
    const padding = WEB_SEARCH_ROW_MAX_CHARS - JSON.stringify(emptyTitle).length;
    const result: InferenceEvent = {
      kind: 'tool-result',
      id: 'c1',
      name: 'webSearch',
      result: {
        results: [
          { title: 'a', url: 'https://a/', snippet: '' },
          { title: 'x'.repeat(padding), url: 'https://b/', snippet: '' },
        ],
      },
    };
    const serialized = serializeAssistantStream(reduceAll([searchCall('c1', 'q'), result]));
    expect(serialized.droppedSourceCount).toBe(0);
    const [stored] = webSearchRowsInOrder(parseAssistantMessage(serialized.text));
    expect(JSON.stringify(stored).length).toBe(WEB_SEARCH_ROW_MAX_CHARS);
  });

  function paddedResult(id: string, sources: { title: string; url: string }[]): InferenceEvent {
    return {
      kind: 'tool-result',
      id,
      name: 'webSearch',
      result: { results: sources.map((source) => ({ ...source, snippet: '' })) },
    };
  }

  it('drops a single source and its comma, landing exactly on the allowance', () => {
    const b = { title: 'b', url: 'https://b/' };
    const bare: WebSearchRow = {
      v: 1,
      searches: [{ query: 'q', status: 'done', sources: [{ title: '', url: 'https://a/' }, b] }],
      notRun: { limit: 0, invalidQuery: 0 },
    };
    const target = WEB_SEARCH_ROW_MAX_CHARS + JSON.stringify(b).length + 1;
    const padding = target - JSON.stringify(bare).length;
    const serialized = serializeAssistantStream(
      reduceAll([
        searchCall('c1', 'q'),
        paddedResult('c1', [{ title: 'x'.repeat(padding), url: 'https://a/' }, b]),
      ])
    );
    expect(serialized.droppedSourceCount).toBe(1);
    const [stored] = webSearchRowsInOrder(parseAssistantMessage(serialized.text));
    expect(JSON.stringify(stored).length).toBe(WEB_SEARCH_ROW_MAX_CHARS);
  });

  it("drops a search's only source without a comma, so a second drop is still needed", () => {
    const b = { title: 'b', url: 'https://b/' };
    const bare: WebSearchRow = {
      v: 1,
      searches: [
        { query: 'q', status: 'done', sources: [{ title: '', url: 'https://a/' }] },
        { query: 'q', status: 'done', sources: [b] },
      ],
      notRun: { limit: 0, invalidQuery: 0 },
    };
    const target = WEB_SEARCH_ROW_MAX_CHARS + JSON.stringify(b).length + 1;
    const padding = target - JSON.stringify(bare).length;
    const serialized = serializeAssistantStream(
      reduceAll([
        searchCall('c1', 'q'),
        searchCall('c2', 'q'),
        paddedResult('c1', [{ title: 'x'.repeat(padding), url: 'https://a/' }]),
        paddedResult('c2', [b]),
      ])
    );
    expect(serialized.droppedSourceCount).toBe(2);
    const [stored] = webSearchRowsInOrder(parseAssistantMessage(serialized.text));
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
  });

  it('drops exactly one source when the rows are one character over the allowance', () => {
    const emptyTitle: WebSearchRow = {
      v: 1,
      searches: [
        {
          query: 'q',
          status: 'done',
          sources: [
            { title: '', url: 'https://a/' },
            { title: 'b', url: 'https://b/' },
          ],
        },
      ],
      notRun: { limit: 0, invalidQuery: 0 },
    };
    const padding = WEB_SEARCH_ROW_MAX_CHARS + 1 - JSON.stringify(emptyTitle).length;
    const result: InferenceEvent = {
      kind: 'tool-result',
      id: 'c1',
      name: 'webSearch',
      result: {
        results: [
          { title: 'x'.repeat(padding), url: 'https://a/', snippet: '' },
          { title: 'b', url: 'https://b/', snippet: '' },
        ],
      },
    };
    const serialized = serializeAssistantStream(reduceAll([searchCall('c1', 'q'), result]));
    expect(serialized.droppedSourceCount).toBe(1);
    const [stored] = webSearchRowsInOrder(parseAssistantMessage(serialized.text));
    expect(stored?.searches[0]?.sources?.map((source) => source.url)).toEqual(['https://a/']);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
  });

  it('drops from an earlier search when the last search of the row failed', () => {
    const urls = Array.from({ length: 40 }, (_value, index) => longUrl(index));
    const serialized = serializeAssistantStream(
      reduceAll([
        searchCall('c1', 'q'),
        searchCall('c2', 'q'),
        searchResult('c1', urls),
        searchError('c2', 'failed'),
      ])
    );
    const [stored] = webSearchRowsInOrder(parseAssistantMessage(serialized.text));
    const kept = stored?.searches[0]?.sources?.length ?? 0;
    expect(kept).toBeGreaterThan(0);
    expect(serialized.droppedSourceCount).toBe(urls.length - kept);
    expect(JSON.stringify(stored).length).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
  });

  it('drops from the later of two searches first, past a failed one', () => {
    const early = Array.from({ length: 5 }, (_value, index) => longUrl(index));
    const late = Array.from({ length: 40 }, (_value, index) => longUrl(100 + index));
    const serialized = serializeAssistantStream(
      reduceAll([
        searchCall('c1', 'q'),
        searchCall('c2', 'q'),
        searchCall('c3', 'q'),
        searchResult('c1', early),
        searchResult('c2', late),
        searchError('c3', 'failed'),
      ])
    );
    const [stored] = webSearchRowsInOrder(parseAssistantMessage(serialized.text));
    expect(stored?.searches[0]?.sources).toHaveLength(early.length);
    const keptLate = stored?.searches[1]?.sources?.length ?? 0;
    expect(keptLate).toBeLessThan(late.length);
    expect(serialized.droppedSourceCount).toBe(late.length - keptLate);
  });

  it('drops the last sources of a search first, keeping its first ones', () => {
    const urls = Array.from({ length: 40 }, (_value, index) => longUrl(index));
    const serialized = serializeAssistantStream(
      reduceAll([searchCall('c1', 'q'), searchResult('c1', urls)])
    );
    const [stored] = webSearchRowsInOrder(parseAssistantMessage(serialized.text));
    const kept = (stored?.searches[0]?.sources ?? []).map((source) => source.url);
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.length).toBeLessThan(urls.length);
    expect(kept).toEqual(urls.slice(0, kept.length));
  });

  it('drops sources from the last nested row backwards, and reports how many', () => {
    const urls = (from: number): string[] =>
      Array.from({ length: 5 }, (_value, index) => longUrl(from + index));
    const events: InferenceEvent[] = [reasoning('r')];
    for (let call = 0; call < 10; call += 1) {
      events.push(
        searchCall(`c${String(call)}`, 'q'),
        searchResult(`c${String(call)}`, urls(call * 5)),
        reasoning('r')
      );
    }
    const serialized = serializeAssistantStream(reduceAll(events));
    expect(serialized.droppedSourceCount).toBeGreaterThan(0);
    expect(serialized.droppedSourceCount).toBe(50 - storedSources(serialized.text));
    const tree = parseAssistantMessage(serialized.text);
    expect(tree.filter((node) => node.kind === 'webSearch')).toEqual([]);
    const rows = webSearchRowsInOrder(tree);
    expect(rows).toHaveLength(10);
    let rowChars = 0;
    for (const nested of rows) rowChars += JSON.stringify(nested).length;
    expect(rowChars).toBeLessThanOrEqual(WEB_SEARCH_ROW_MAX_CHARS);
    expect(rows[0]?.searches[0]?.sources).toHaveLength(5);
    expect(rows.at(-1)?.searches[0]?.sources).toHaveLength(0);
  });

  it('leaves the state itself untouched when it drops sources', () => {
    const events: InferenceEvent[] = [];
    for (let call = 0; call < 10; call += 1) {
      events.push(
        searchCall(`c${String(call)}`, 'q'),
        searchResult(
          `c${String(call)}`,
          Array.from({ length: 5 }, (_value, index) => longUrl(call * 5 + index))
        )
      );
    }
    const state = reduceAll(events);
    const before = JSON.stringify(state.tree);
    serializeAssistantStream(state);
    expect(JSON.stringify(state.tree)).toBe(before);
  });
});

describe('reduceAssistantStream cost', () => {
  const N = 10_000;

  /** The fastest of several runs, so a pause elsewhere cannot inflate a sample. */
  function fastestMs(events: readonly InferenceEvent[]): number {
    let fastest = Number.POSITIVE_INFINITY;
    for (let run = 0; run < 5; run += 1) {
      const start = performance.now();
      reduceAll(events);
      fastest = Math.min(fastest, performance.now() - start);
    }
    return fastest;
  }

  const leadingWhitespace = (deltas: number): InferenceEvent[] => [
    ...Array.from({ length: deltas }, () => text('        ')),
    text('x'),
  ];
  const plainText = (deltas: number): InferenceEvent[] =>
    Array.from({ length: deltas + 1 }, () => text('xxxxxxxx'));

  it('grows linearly while it holds back leading whitespace, like plain text does', () => {
    const whitespaceN = fastestMs(leadingWhitespace(N));
    const whitespace4N = fastestMs(leadingWhitespace(4 * N));
    const plain4N = fastestMs(plainText(4 * N));
    // Linear growth makes 4N cost about four times N; a rescan of the held text
    // makes it about sixteen. The additive slack absorbs timer noise at small scale.
    expect(whitespace4N).toBeLessThan(8 * whitespaceN + 25);
    expect(whitespace4N).toBeLessThan(20 * plain4N + 25);
  });

  const CALLS = 2000;
  const searchCalls = (count: number): InferenceEvent[] =>
    Array.from({ length: count }, (_value, index) => searchCall(`c${String(index)}`, 'q'));
  const resolvedSearchCalls = (count: number): InferenceEvent[] =>
    Array.from({ length: count }, (_value, index) => {
      const id = `c${String(index)}`;
      const outcome =
        index % 2 === 0 ? searchResult(id, ['https://a/']) : searchError(id, 'failed');
      return [searchCall(id, 'q'), outcome];
    }).flat();

  it('grows linearly over web-search calls, like plain text does', () => {
    const callsN = fastestMs(searchCalls(CALLS));
    const calls4N = fastestMs(searchCalls(4 * CALLS));
    const plain4N = fastestMs(plainText(4 * CALLS));
    expect(calls4N).toBeLessThan(8 * callsN + 25);
    expect(calls4N).toBeLessThan(20 * plain4N + 25);
  });

  it('grows linearly over web-search calls with their results and errors, like plain text does', () => {
    const resolvedN = fastestMs(resolvedSearchCalls(CALLS));
    const resolved4N = fastestMs(resolvedSearchCalls(4 * CALLS));
    const plain4N = fastestMs(plainText(8 * CALLS));
    expect(resolved4N).toBeLessThan(8 * resolvedN + 25);
    expect(resolved4N).toBeLessThan(20 * plain4N + 25);
  });

  const SOURCES = 250;

  it('trims an oversized row in time linear in the sources it drops', () => {
    const sourceUrl = (index: number): string =>
      `https://example.com/${'p'.repeat(400)}/${String(index)}`;
    const oversized = (count: number): AssistantStreamState =>
      reduceAll([
        searchCall('c1', 'q'),
        searchResult(
          'c1',
          Array.from({ length: count }, (_value, index) => sourceUrl(index))
        ),
      ]);
    const fastestSerializeMs = (state: AssistantStreamState): number => {
      let fastest = Number.POSITIVE_INFINITY;
      for (let run = 0; run < 5; run += 1) {
        const start = performance.now();
        serializeAssistantStream(state);
        fastest = Math.min(fastest, performance.now() - start);
      }
      return fastest;
    };
    const trimN = fastestSerializeMs(oversized(SOURCES));
    const trim4N = fastestSerializeMs(oversized(4 * SOURCES));
    expect(trim4N).toBeLessThan(8 * trimN + 25);
  });
});
