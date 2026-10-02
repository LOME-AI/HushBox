import { describe, it, expect } from 'vitest';
import { TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { replyingToOf } from './replying-to';
import type { Message } from '@/lib/api/api';
import type { LinkInfo } from './sender';

type Identity = Parameters<typeof replyingToOf>[2];

const VIEWER_ID = 'user-alice';
const BOB_ID = 'user-bob';
const LINK_NAMED_ID = 'link-luisa';
const LINK_UNNAMED_ID = 'link-unnamed';

const members: Identity['members'] = [
  { userId: VIEWER_ID, username: 'Alice' },
  { userId: BOB_ID, username: 'Bob' },
];

const links: readonly LinkInfo[] = [
  { id: LINK_NAMED_ID, displayName: 'Luísa' },
  { id: LINK_UNNAMED_ID, displayName: null },
];

const groupIdentity: Identity = {
  currentUserId: VIEWER_ID,
  isGroupChat: true,
  members,
  links,
};

function createMessage(overrides: Partial<Message> & Pick<Message, 'id' | 'role'>): Message {
  return {
    conversationId: 'conv-1',
    content: 'message body',
    createdAt: isoAt(TEST_DAY_START),
    ...overrides,
  };
}

function userMessage(id: string, senderId: string): Message {
  return createMessage({ id, role: 'user', senderId });
}

function replyTo(parentId: string, id = `reply-to-${parentId}`): Message {
  return createMessage({ id, role: 'assistant', parentMessageId: parentId });
}

function indexById(messages: readonly Message[]): ReadonlyMap<string, Message> {
  return new Map(messages.map((m) => [m.id, m]));
}

function nameFor(senderId: string, identity: Identity = groupIdentity): string | undefined {
  const parent = userMessage('parent', senderId);
  const reply = replyTo(parent.id);
  return replyingToOf(reply, indexById([parent, reply]), identity);
}

describe('replyingToOf', () => {
  it("names another member by that member's display name", () => {
    expect(nameFor(BOB_ID)).toBe('Bob');
  });

  it('says "you" when the parent is the viewer\'s own message', () => {
    expect(nameFor(VIEWER_ID)).toBe('you');
  });

  it("names a link guest by the link's name", () => {
    expect(nameFor(LINK_NAMED_ID)).toBe('Luísa');
  });

  it('names an unnamed link guest "Guest"', () => {
    expect(nameFor(LINK_UNNAMED_ID)).toBe('Guest');
  });

  it('gives nothing when the parent sender has left the conversation', () => {
    expect(nameFor('user-departed')).toBeUndefined();
  });

  it('gives nothing when the parent carries no sender', () => {
    const parent = createMessage({ id: 'parent', role: 'user' });
    const reply = replyTo(parent.id);
    expect(replyingToOf(reply, indexById([parent, reply]), groupIdentity)).toBeUndefined();
  });

  it('gives nothing when the parent is not in the loaded messages', () => {
    const reply = replyTo('parent-not-loaded');
    expect(replyingToOf(reply, indexById([reply]), groupIdentity)).toBeUndefined();
  });

  it('gives nothing when the reply has no parent', () => {
    const reply = createMessage({ id: 'orphan', role: 'assistant', parentMessageId: null });
    expect(replyingToOf(reply, indexById([reply]), groupIdentity)).toBeUndefined();
  });

  it('gives nothing outside a group conversation', () => {
    expect(nameFor(BOB_ID, { ...groupIdentity, isGroupChat: false })).toBeUndefined();
  });

  it('gives nothing for a user message', () => {
    const parent = userMessage('parent', BOB_ID);
    const child = createMessage({
      id: 'child',
      role: 'user',
      senderId: VIEWER_ID,
      parentMessageId: parent.id,
    });
    expect(replyingToOf(child, indexById([parent, child]), groupIdentity)).toBeUndefined();
  });

  it('gives nothing when the parent is an assistant message', () => {
    const parent = createMessage({ id: 'parent', role: 'assistant', senderId: BOB_ID });
    const reply = replyTo(parent.id);
    expect(replyingToOf(reply, indexById([parent, reply]), groupIdentity)).toBeUndefined();
  });

  it('resolves multi-model siblings to the same parent sender', () => {
    const parent = userMessage('parent', BOB_ID);
    const first = replyTo(parent.id, 'sibling-a');
    const second = replyTo(parent.id, 'sibling-b');
    const byId = indexById([parent, first, second]);

    expect([
      replyingToOf(first, byId, groupIdentity),
      replyingToOf(second, byId, groupIdentity),
    ]).toEqual(['Bob', 'Bob']);
  });
});
