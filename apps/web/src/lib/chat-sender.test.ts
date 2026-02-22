import { describe, it, expect } from 'vitest';
import { getSenderLabel, isOwnMessage, groupConsecutiveMessages } from './chat-sender';
import type { Message } from '@/lib/api';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: crypto.randomUUID(),
    conversationId: 'conv-1',
    role: 'user',
    content: 'test message',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

const members = [
  { id: 'member-1', userId: 'user-1', username: 'alice', privilege: 'owner' },
  { id: 'member-2', userId: 'user-2', username: 'bob', privilege: 'admin' },
];

// ---------------------------------------------------------------------------
// getSenderLabel
// ---------------------------------------------------------------------------

describe('getSenderLabel', () => {
  it('returns undefined when not in group chat', () => {
    const label = getSenderLabel('user-1', 'user-1', members, false);

    expect(label).toBeUndefined();
  });

  it('returns undefined when senderId is undefined', () => {
    const label = getSenderLabel(undefined, 'user-1', members, true);

    expect(label).toBeUndefined();
  });

  it('returns "You" when senderId matches currentUserId', () => {
    const label = getSenderLabel('user-1', 'user-1', members, true);

    expect(label).toBe('You');
  });

  it('returns username when senderId matches a member', () => {
    const label = getSenderLabel('user-2', 'user-1', members, true);

    expect(label).toBe('bob');
  });

  it('returns left user message when senderId is not found in members', () => {
    const label = getSenderLabel('user-deleted', 'user-1', members, true);

    expect(label).toBe('This user has left the conversation');
  });
});

// ---------------------------------------------------------------------------
// isOwnMessage
// ---------------------------------------------------------------------------

describe('isOwnMessage', () => {
  it('returns true when senderId matches currentUserId', () => {
    expect(isOwnMessage('user-1', 'user-1')).toBe(true);
  });

  it('returns false when senderId does not match', () => {
    expect(isOwnMessage('user-2', 'user-1')).toBe(false);
  });

  it('returns false when senderId is undefined', () => {
    expect(isOwnMessage(undefined, 'user-1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// groupConsecutiveMessages
// ---------------------------------------------------------------------------

describe('groupConsecutiveMessages', () => {
  it('returns empty array for empty input', () => {
    const groups = groupConsecutiveMessages([]);

    expect(groups).toEqual([]);
  });

  it('groups consecutive user messages with same senderId', () => {
    const msg1 = createMessage({ id: 'msg-1', senderId: 'user-1' });
    const msg2 = createMessage({ id: 'msg-2', senderId: 'user-1' });

    const groups = groupConsecutiveMessages([msg1, msg2]);

    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.id).toBe('msg-1');
    expect(group.role).toBe('user');
    expect(group.senderId).toBe('user-1');
    expect(group.messages).toHaveLength(2);
    expect(group.messages[0]!.id).toBe('msg-1');
    expect(group.messages[1]!.id).toBe('msg-2');
  });

  it('splits groups when senderId changes', () => {
    const msg1 = createMessage({ id: 'msg-1', senderId: 'user-1' });
    const msg2 = createMessage({ id: 'msg-2', senderId: 'user-2' });

    const groups = groupConsecutiveMessages([msg1, msg2]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.senderId).toBe('user-1');
    expect(groups[1]!.senderId).toBe('user-2');
  });

  it('never groups AI messages', () => {
    const ai1 = createMessage({ id: 'ai-1', role: 'assistant' });
    const ai2 = createMessage({ id: 'ai-2', role: 'assistant' });

    const groups = groupConsecutiveMessages([ai1, ai2]);

    expect(groups).toHaveLength(2);
    expect(groups[0]!.messages).toHaveLength(1);
    expect(groups[1]!.messages).toHaveLength(1);
  });

  it('never groups user messages without senderId', () => {
    const msg1 = createMessage({ id: 'msg-1' });
    const msg2 = createMessage({ id: 'msg-2' });

    const groups = groupConsecutiveMessages([msg1, msg2]);

    expect(groups).toHaveLength(2);
  });

  it('handles mixed sequence: alice×2, AI, bob×1, alice×3, AI', () => {
    const messages = [
      createMessage({ id: 'a1', senderId: 'alice' }),
      createMessage({ id: 'a2', senderId: 'alice' }),
      createMessage({ id: 'ai1', role: 'assistant' }),
      createMessage({ id: 'b1', senderId: 'bob' }),
      createMessage({ id: 'a3', senderId: 'alice' }),
      createMessage({ id: 'a4', senderId: 'alice' }),
      createMessage({ id: 'a5', senderId: 'alice' }),
      createMessage({ id: 'ai2', role: 'assistant' }),
    ];

    const groups = groupConsecutiveMessages(messages);

    expect(groups).toHaveLength(5);

    // Group 1: alice×2
    const g1 = groups[0]!;
    expect(g1.id).toBe('a1');
    expect(g1.senderId).toBe('alice');
    expect(g1.messages).toHaveLength(2);

    // Group 2: AI (standalone)
    const g2 = groups[1]!;
    expect(g2.id).toBe('ai1');
    expect(g2.role).toBe('assistant');
    expect(g2.messages).toHaveLength(1);

    // Group 3: bob×1
    const g3 = groups[2]!;
    expect(g3.id).toBe('b1');
    expect(g3.senderId).toBe('bob');
    expect(g3.messages).toHaveLength(1);

    // Group 4: alice×3
    const g4 = groups[3]!;
    expect(g4.id).toBe('a3');
    expect(g4.senderId).toBe('alice');
    expect(g4.messages).toHaveLength(3);

    // Group 5: AI (standalone)
    const g5 = groups[4]!;
    expect(g5.id).toBe('ai2');
    expect(g5.role).toBe('assistant');
    expect(g5.messages).toHaveLength(1);
  });

  it('uses first message id as group id', () => {
    const msg1 = createMessage({ id: 'first-id', senderId: 'user-1' });
    const msg2 = createMessage({ id: 'second-id', senderId: 'user-1' });

    const groups = groupConsecutiveMessages([msg1, msg2]);

    expect(groups[0]!.id).toBe('first-id');
  });

  it('preserves role in each group', () => {
    const user = createMessage({ id: 'u1', role: 'user', senderId: 'user-1' });
    const ai = createMessage({ id: 'a1', role: 'assistant' });

    const groups = groupConsecutiveMessages([user, ai]);

    expect(groups[0]!.role).toBe('user');
    expect(groups[1]!.role).toBe('assistant');
  });

  it('handles single message', () => {
    const msg = createMessage({ id: 'solo', senderId: 'user-1' });

    const groups = groupConsecutiveMessages([msg]);

    expect(groups).toHaveLength(1);
    expect(groups[0]!.messages).toHaveLength(1);
  });

  it('does not group user message followed by AI then same user', () => {
    const u1 = createMessage({ id: 'u1', senderId: 'user-1' });
    const ai = createMessage({ id: 'ai', role: 'assistant' });
    const u2 = createMessage({ id: 'u2', senderId: 'user-1' });

    const groups = groupConsecutiveMessages([u1, ai, u2]);

    expect(groups).toHaveLength(3);
    expect(groups[0]!.senderId).toBe('user-1');
    expect(groups[1]!.role).toBe('assistant');
    expect(groups[2]!.senderId).toBe('user-1');
  });
});
