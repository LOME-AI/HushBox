import { describe, it, expect } from 'vitest';
import { memberFactory, messageFactory, conversationFactory } from './factories';

describe('memberFactory', () => {
  it('defaults id and userId to distinct values', () => {
    const member = memberFactory.build();
    expect(member.id).not.toBe(member.userId);
  });

  it('produces distinct id/userId across sequential builds', () => {
    const members = memberFactory.buildList(2);
    const ids = members.map((m) => m.id);
    const userIds = members.map((m) => m.userId);
    expect(new Set(ids).size).toBe(members.length);
    expect(new Set(userIds).size).toBe(members.length);
  });

  it('honors explicit overrides', () => {
    const member = memberFactory.build({ id: 'm-1', userId: 'u-1', privilege: 'owner' });
    expect(member.id).toBe('m-1');
    expect(member.userId).toBe('u-1');
    expect(member.privilege).toBe('owner');
  });
});

describe('messageFactory', () => {
  it('defaults id and senderId to distinct values', () => {
    const message = messageFactory.build();
    expect(message.id).not.toBe(message.senderId);
  });

  it('builds a valid display message with required fields', () => {
    const message = messageFactory.build();
    expect(typeof message.id).toBe('string');
    expect(typeof message.conversationId).toBe('string');
    expect(['user', 'assistant']).toContain(message.role);
    expect(typeof message.content).toBe('string');
    expect(typeof message.createdAt).toBe('string');
  });
});

describe('conversationFactory', () => {
  it('defaults id and userId to distinct values', () => {
    const conversation = conversationFactory.build();
    expect(conversation.id).not.toBe(conversation.userId);
  });
});
