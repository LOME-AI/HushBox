import { describe, it, expect } from 'vitest';
import { SECOND_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { groupSenderRuns, groupSiblingReplies } from './sibling-replies';
import type { Message } from '@/lib/api/api';

let sequence = 0;

function message(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  sequence += 1;
  return {
    conversationId: 'conv-1',
    content: overrides.id,
    createdAt: isoAt(TEST_DAY_START + sequence * SECOND_MS),
    ...overrides,
  };
}

const question = message({ id: 'u1', role: 'user', parentMessageId: null });
const first = message({ id: 'a1', role: 'assistant', parentMessageId: 'u1' });
const second = message({ id: 'a2', role: 'assistant', parentMessageId: 'u1' });
const third = message({ id: 'a3', role: 'assistant', parentMessageId: 'u1' });

describe('groupSiblingReplies', () => {
  it('keeps a lone reply as its own row', () => {
    expect(groupSiblingReplies([question, first])).toEqual([
      { kind: 'message', message: question },
      { kind: 'message', message: first },
    ]);
  });

  it('gathers the replies one question drew from several models into one row', () => {
    expect(groupSiblingReplies([question, first, second, third])).toEqual([
      { kind: 'message', message: question },
      { kind: 'compare', replies: [first, second, third] },
    ]);
  });

  it('keeps replies to different questions apart', () => {
    const followUp = message({ id: 'u2', role: 'user', parentMessageId: 'a2' });
    const answer = message({ id: 'a4', role: 'assistant', parentMessageId: 'u2' });

    expect(groupSiblingReplies([question, first, second, followUp, answer])).toEqual([
      { kind: 'message', message: question },
      { kind: 'compare', replies: [first, second] },
      { kind: 'message', message: followUp },
      { kind: 'message', message: answer },
    ]);
  });

  it('keeps adjacent replies to different parents apart', () => {
    const other = message({ id: 'b1', role: 'assistant', parentMessageId: 'u9' });

    expect(groupSiblingReplies([first, other])).toEqual([
      { kind: 'message', message: first },
      { kind: 'message', message: other },
    ]);
  });

  it('never gathers replies that name no parent', () => {
    const orphanA = message({ id: 'o1', role: 'assistant', parentMessageId: null });
    const orphanB = message({ id: 'o2', role: 'assistant' });

    expect(groupSiblingReplies([orphanA, orphanB])).toEqual([
      { kind: 'message', message: orphanA },
      { kind: 'message', message: orphanB },
    ]);
  });

  it('never gathers user messages that share a parent', () => {
    const editA = message({ id: 'e1', role: 'user', parentMessageId: 'a1' });
    const editB = message({ id: 'e2', role: 'user', parentMessageId: 'a1' });

    expect(groupSiblingReplies([editA, editB])).toEqual([
      { kind: 'message', message: editA },
      { kind: 'message', message: editB },
    ]);
  });

  it('keeps a failed reply in its turn', () => {
    const failed = message({
      id: 'a5',
      role: 'assistant',
      parentMessageId: 'u1',
      errorCode: 'STREAM_ERROR',
    });

    expect(groupSiblingReplies([question, first, failed])).toEqual([
      { kind: 'message', message: question },
      { kind: 'compare', replies: [first, failed] },
    ]);
  });

  it('returns no rows for no messages', () => {
    expect(groupSiblingReplies([])).toEqual([]);
  });
});

describe('groupSenderRuns', () => {
  const alice1 = message({ id: 'p1', role: 'user', senderId: 'alice', parentMessageId: null });
  const alice2 = message({ id: 'p2', role: 'user', senderId: 'alice', parentMessageId: 'p1' });
  const reply1 = message({ id: 'r1', role: 'assistant', parentMessageId: 'p2' });
  const reply2 = message({ id: 'r2', role: 'assistant', parentMessageId: 'p2' });
  const bob = message({ id: 'q1', role: 'user', senderId: 'bob', parentMessageId: 'r2' });

  it("groups one sender's consecutive messages as today", () => {
    expect(groupSenderRuns(groupSiblingReplies([alice1, alice2]))).toEqual([
      {
        kind: 'group',
        group: { id: 'p1', role: 'user', senderId: 'alice', messages: [alice1, alice2] },
      },
    ]);
  });

  it("keeps a compare turn whole between its senders' groups", () => {
    expect(groupSenderRuns(groupSiblingReplies([alice1, alice2, reply1, reply2, bob]))).toEqual([
      {
        kind: 'group',
        group: { id: 'p1', role: 'user', senderId: 'alice', messages: [alice1, alice2] },
      },
      { kind: 'compare', replies: [reply1, reply2] },
      { kind: 'group', group: { id: 'q1', role: 'user', senderId: 'bob', messages: [bob] } },
    ]);
  });

  it('keeps a lone reply as its own group', () => {
    expect(groupSenderRuns(groupSiblingReplies([alice2, reply1]))).toEqual([
      { kind: 'group', group: { id: 'p2', role: 'user', senderId: 'alice', messages: [alice2] } },
      { kind: 'group', group: { id: 'r1', role: 'assistant', messages: [reply1] } },
    ]);
  });
});
