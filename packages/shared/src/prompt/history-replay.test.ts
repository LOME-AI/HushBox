import { describe, expect, it } from 'vitest';
import { MESSAGE_MARKER_CHARS, serializeSegments } from '../assistant-text/grammar.ts';
import { stripReplayHistory } from './history-replay.ts';
import type { Segment } from '../assistant-text/segments.ts';
import type { ChatHistoryMessage } from '../workflow/inference.ts';

/**
 * History replay: resent assistant turns carry the whole stored segment tree
 * (reasoning, search rows, answer text), and both client history sources
 * resend it verbatim. Only the root answer text may reach a provider. Every
 * fixture is built through the shared serializer, so no delimiter is written
 * here.
 */

const user = (content: string): ChatHistoryMessage => ({ role: 'user', content });
const assistant = (content: string): ChatHistoryMessage => ({ role: 'assistant', content });

const textSegment = (value: string): Segment => ({ kind: 'text', text: value });
const reasoningSegment = (...children: Segment[]): Segment => ({ kind: 'reasoning', children });
const searchRow = (query: string): Segment => ({
  kind: 'webSearch',
  row: {
    v: 1,
    searches: [
      { query, status: 'done', sources: [{ title: 'A page', url: 'https://a.example/' }] },
    ],
    notRun: { limit: 0, invalidQuery: 0 },
  },
});

describe('stripReplayHistory', () => {
  it('sends only root answer text from a framed turn, dropping reasoning with its nested searches', () => {
    const stored = serializeSegments([
      reasoningSegment(textSegment('think'), searchRow('q'), textSegment('more')),
      textSegment('the final answer'),
    ]);
    const stripped = stripReplayHistory([user('question'), assistant(stored)]);
    expect(stripped).toEqual([user('question'), assistant('the final answer')]);
  });

  it('joins the answer text of several steps with a blank line', () => {
    const stored = serializeSegments([textSegment('first'), searchRow('q'), textSegment('second')]);
    expect(stripReplayHistory([assistant(stored)])).toEqual([assistant('first\n\nsecond')]);
  });

  it('strips every framed assistant turn in a multi-turn history', () => {
    const first = serializeSegments([reasoningSegment(textSegment('t1')), textSegment('one')]);
    const second = serializeSegments([reasoningSegment(textSegment('t2')), textSegment('two')]);
    expect(
      stripReplayHistory([user('q1'), assistant(first), user('q2'), assistant(second)])
    ).toEqual([user('q1'), assistant('one'), user('q2'), assistant('two')]);
  });

  it('leaves a user turn verbatim even when its text is framed', () => {
    const framed = serializeSegments([reasoningSegment(textSegment('t')), textSegment('prose')]);
    expect(stripReplayHistory([user(framed), assistant('plain answer')])[0]).toEqual(user(framed));
  });

  it('returns the very same array when no assistant turn carries anything to strip', () => {
    const history = [user('question'), assistant('plain answer')];
    expect(stripReplayHistory(history)).toBe(history);
  });

  it('drops an assistant turn with no answer text (a reasoning-only aborted partial)', () => {
    const reasoningOnly = serializeSegments([reasoningSegment(textSegment('thoughts'))]);
    expect(stripReplayHistory([user('question'), assistant(reasoningOnly)])).toEqual([
      user('question'),
    ]);
  });

  it('sends malformed framed history as one text that no longer reads as framed', () => {
    const framed = serializeSegments([reasoningSegment(textSegment('t')), textSegment('answer')]);
    const truncated = framed.slice(0, -2);
    const [cleaned] = stripReplayHistory([assistant(truncated)]);
    expect(cleaned?.content).toBe(truncated.slice(MESSAGE_MARKER_CHARS));
    expect(stripReplayHistory([assistant(cleaned?.content ?? '')])).toEqual([cleaned]);
  });

  it('cleans a model-authored framed answer to the same text once or twice', () => {
    // The answer text is itself a serialized message, so it begins with the
    // frame marker; cleaned history must not be read as framed a second time.
    const authored = serializeSegments([
      reasoningSegment(textSegment('reasoning-looking text')),
      textSegment('visible'),
    ]);
    const stored = serializeSegments([
      reasoningSegment(textSegment('real thought')),
      textSegment(authored),
    ]);
    const once = stripReplayHistory([assistant(stored)]);
    expect(stripReplayHistory(once)).toEqual(once);
    expect(once[0]?.content).toContain('reasoning-looking text');
    expect(once[0]?.content).not.toContain('real thought');
  });

  it('handles an empty history without inventing entries', () => {
    const history: ChatHistoryMessage[] = [];
    expect(stripReplayHistory(history)).toBe(history);
  });
});
