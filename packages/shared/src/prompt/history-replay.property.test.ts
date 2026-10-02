import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { serializeSegments } from '../assistant-text/grammar.ts';
import { assistantHistoryText } from '../assistant-text/projection.ts';
import { stripReplayHistory } from './history-replay.ts';
import type { Segment } from '../assistant-text/segments.ts';
import type { ChatHistoryMessage } from '../workflow/inference.ts';

const SEARCH_ROW: Segment = {
  kind: 'webSearch',
  row: { v: 1, searches: [], notRun: { limit: 0, invalidQuery: 1 } },
};

/** `plainTexts`: arbitrary code points, empty included. */
const plainTexts = fc.string({ unit: 'binary', maxLength: 12 });

/** `framedTrees`: small trees of reasoning, answer text and search rows over plain text. */
const framedTrees: fc.Arbitrary<readonly Segment[]> = fc.array(
  fc.oneof(
    plainTexts.map((text): Segment => ({ kind: 'text', text })),
    fc.constant(SEARCH_ROW),
    fc.array(plainTexts, { maxLength: 3 }).map(
      (texts): Segment => ({
        kind: 'reasoning',
        children: texts.map((text): Segment => ({ kind: 'text', text })),
      })
    )
  ),
  { maxLength: 4 }
);

/**
 * `modelTexts`: what a model may write as answer text, including text that is
 * itself a serialized message (it begins with the frame marker and carries
 * frames), a cut-off prefix of one (malformed), and either joined to plain text.
 * Serializing a tree is how these are built, so no delimiter is written here.
 */
const modelTexts: fc.Arbitrary<string> = fc.oneof(
  plainTexts,
  framedTrees.map((tree) => serializeSegments(tree)),
  fc.tuple(framedTrees, fc.nat()).map(([tree, cut]) => {
    const text = serializeSegments(tree);
    return text.slice(0, cut % (text.length + 1));
  }),
  fc.tuple(framedTrees, plainTexts).map(([tree, tail]) => `${serializeSegments(tree)}${tail}`)
);

/**
 * `assistantContents`: stored assistant messages whose answer and reasoning
 * text are drawn from `modelTexts`, and raw `modelTexts` as a client may send
 * them.
 */
const assistantContents: fc.Arbitrary<string> = fc.oneof(
  modelTexts,
  fc
    .array(
      fc.oneof(
        modelTexts.map((text): Segment => ({ kind: 'text', text })),
        fc.constant(SEARCH_ROW),
        fc.array(modelTexts, { maxLength: 2 }).map(
          (texts): Segment => ({
            kind: 'reasoning',
            children: texts.map((text): Segment => ({ kind: 'text', text })),
          })
        )
      ),
      { maxLength: 4 }
    )
    .map((tree) => serializeSegments(tree))
);

/** `histories`: user and assistant turns in any order. */
const histories: fc.Arbitrary<ChatHistoryMessage[]> = fc.array(
  fc.oneof(
    assistantContents.map((content): ChatHistoryMessage => ({ role: 'assistant', content })),
    modelTexts.map((content): ChatHistoryMessage => ({ role: 'user', content }))
  ),
  { maxLength: 5 }
);

describe('history replay idempotence', () => {
  it('cleans an assistant turn twice to exactly what cleaning it once gives (generator: assistantContents)', () => {
    fc.assert(
      fc.property(assistantContents, (content) => {
        const once = assistantHistoryText(content);
        expect(assistantHistoryText(once)).toBe(once);
      })
    );
  });

  it('strips a history twice to exactly what stripping it once gives (generator: histories)', () => {
    fc.assert(
      fc.property(histories, (history) => {
        const once = stripReplayHistory(history);
        expect(stripReplayHistory(once)).toEqual(once);
      })
    );
  });
});
