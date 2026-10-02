import { describe, expect, it } from 'vitest';
import { serializeSegments } from '@hushbox/shared';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { branchSummaries, type BranchFork } from '@/lib/chat/branch-summary';
import type { Message } from '@/lib/api/api';

function message(
  id: string,
  role: Message['role'],
  parentMessageId: string | null,
  content = `${id} text`
): Message {
  return {
    id,
    conversationId: 'conv-1',
    role,
    content,
    createdAt: isoAt(TEST_DAY_START),
    parentMessageId,
  };
}

function fork(id: string, name: string, tipMessageId: string | null): BranchFork {
  return { id, name, tipMessageId };
}

// u1 → a1 → u2 → a2 → u3 → a3 on Main; a Fork 1 asks its own u2 after a1.
const MAIN_THREAD: readonly Message[] = [
  message('u1', 'user', null),
  message('a1', 'assistant', 'u1'),
  message('u2', 'user', 'a1', 'Show me the Python for that.'),
  message('a2', 'assistant', 'u2'),
  message('u3', 'user', 'a2', 'Now in Rust.'),
  message('a3', 'assistant', 'u3'),
];

describe('branchSummaries', () => {
  it('returns nothing when there are no forks', () => {
    expect(branchSummaries(MAIN_THREAD, [])).toEqual([]);
  });

  it('gives each branch the first message after the point where it parts from the others', () => {
    const messages = [
      ...MAIN_THREAD,
      message('f1-u2', 'user', 'a1', 'Same thing without pandas.'),
      message('f1-a2', 'assistant', 'f1-u2'),
    ];
    const summaries = branchSummaries(messages, [
      fork('main', 'Main', 'a3'),
      fork('f1', 'Fork 1', 'f1-a2'),
    ]);
    expect(summaries).toEqual([
      {
        forkId: 'main',
        name: 'Main',
        firstMessage: 'Show me the Python for that.',
        forkPointOrdinal: 2,
        forkPointId: 'a1',
      },
      {
        forkId: 'f1',
        name: 'Fork 1',
        firstMessage: 'Same thing without pandas.',
        forkPointOrdinal: 2,
        forkPointId: 'a1',
      },
    ]);
  });

  it('numbers a fork point after a reply by the question at which the branches part', () => {
    const messages = [...MAIN_THREAD, message('f1-u3', 'user', 'a2', 'Now in Go.')];
    const summaries = branchSummaries(messages, [
      fork('main', 'Main', 'a3'),
      fork('f1', 'Fork 1', 'f1-u3'),
    ]);
    expect(summaries.map((s) => s.forkPointOrdinal)).toEqual([3, 3]);
  });

  it('numbers a fork point at a question by that question, when its replies part', () => {
    const messages = [
      message('u1', 'user', null),
      message('a1', 'assistant', 'u1'),
      message('a1-peer', 'assistant', 'u1'),
    ];
    const summaries = branchSummaries(messages, [
      fork('main', 'Main', 'a1'),
      fork('f1', 'Fork 1', 'a1-peer'),
    ]);
    expect(summaries.map((s) => s.forkPointOrdinal)).toEqual([1, 1]);
  });

  it('gives an assistant first message as its answer text, without its reasoning', () => {
    const framed = serializeSegments([
      { kind: 'reasoning', children: [{ kind: 'text', text: 'Thinking it over.' }] },
      { kind: 'text', text: 'Here is the second take.' },
    ]);
    const messages = [
      message('u1', 'user', null),
      message('a1', 'assistant', 'u1'),
      message('a1-peer', 'assistant', 'u1', framed),
    ];
    const summaries = branchSummaries(messages, [
      fork('main', 'Main', 'a1'),
      fork('f1', 'Fork 1', 'a1-peer'),
    ]);
    expect(summaries.find((s) => s.forkId === 'f1')?.firstMessage).toBe('Here is the second take.');
  });

  it('gives a branch that has nothing past its fork point an empty first message', () => {
    const summaries = branchSummaries(MAIN_THREAD, [
      fork('main', 'Main', 'a3'),
      fork('f1', 'Fork 1', 'a1'),
    ]);
    expect(summaries.find((s) => s.forkId === 'f1')?.firstMessage).toBe('');
  });

  it('lists every branch that parts at a fork point under it, when the thread forks twice', () => {
    const messages = [
      ...MAIN_THREAD,
      message('f1-u2', 'user', 'a1', 'Fork 1 asks.'),
      message('f2-u3', 'user', 'a2', 'Fork 2 asks.'),
    ];
    const summaries = branchSummaries(messages, [
      fork('main', 'Main', 'a3'),
      fork('f1', 'Fork 1', 'f1-u2'),
      fork('f2', 'Fork 2', 'f2-u3'),
    ]);
    expect(
      summaries.map((s) => [s.forkPointId, s.forkId, s.forkPointOrdinal, s.firstMessage])
    ).toEqual([
      ['a1', 'main', 2, 'Show me the Python for that.'],
      ['a1', 'f1', 2, 'Fork 1 asks.'],
      ['a1', 'f2', 2, 'Show me the Python for that.'],
      ['a2', 'main', 3, 'Now in Rust.'],
      ['a2', 'f2', 3, 'Fork 2 asks.'],
    ]);
  });

  it('keeps the forks in their given order within one fork point', () => {
    const messages = [
      ...MAIN_THREAD,
      message('f1-u2', 'user', 'a1'),
      message('f2-u2', 'user', 'a1'),
    ];
    const summaries = branchSummaries(messages, [
      fork('f2', 'Fork 2', 'f2-u2'),
      fork('main', 'Main', 'a3'),
      fork('f1', 'Fork 1', 'f1-u2'),
    ]);
    expect(summaries.map((s) => s.forkId)).toEqual(['f2', 'main', 'f1']);
  });

  it('lists a fork whose tip is not loaded yet with no fork point and no first message', () => {
    const summaries = branchSummaries(MAIN_THREAD, [
      fork('main', 'Main', 'a3'),
      fork('f1', 'Fork 1', 'not-loaded'),
    ]);
    expect(summaries.find((s) => s.forkId === 'f1')).toEqual({
      forkId: 'f1',
      name: 'Fork 1',
      firstMessage: '',
      forkPointOrdinal: 0,
      forkPointId: null,
    });
  });

  it('lists a fork with no tip with no fork point', () => {
    const summaries = branchSummaries(MAIN_THREAD, [
      fork('main', 'Main', 'a3'),
      fork('f1', 'Fork 1', null),
    ]);
    expect(summaries.find((s) => s.forkId === 'f1')?.forkPointOrdinal).toBe(0);
  });

  it('stops walking at a parent loop rather than hanging', () => {
    const messages = [message('x', 'user', 'y'), message('y', 'assistant', 'x')];
    const summaries = branchSummaries(messages, [
      fork('main', 'Main', 'y'),
      fork('f1', 'Fork 1', 'x'),
    ]);
    expect(summaries).toHaveLength(2);
  });
});
