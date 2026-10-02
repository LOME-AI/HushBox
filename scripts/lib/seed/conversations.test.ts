import { describe, expect, it } from 'vitest';
import { DEV_EMAIL_DOMAIN } from '@hushbox/shared';
import { ADMIN_TARGET_PERSONA } from '../../seed.js';
import {
  buildDocumentShowcaseConversations,
  buildPersonaSampleConversations,
  personasWithSampleData,
  screenshotConversationTitle,
} from './conversations.js';
import { DOCUMENT_SHOWCASE_MESSAGES, DOCUMENT_SHOWCASE_TITLE } from './documents.js';
import { DEV_PERSONAS, seedUUID } from './personas.js';

describe('screenshotConversationTitle', () => {
  it('derives a "Screenshot: <name>" title from a screenshot seed key', () => {
    expect(screenshotConversationTitle('screenshot-conv-chat')).toBe('Screenshot: chat');
    expect(screenshotConversationTitle('screenshot-conv-group-chat')).toBe(
      'Screenshot: group-chat'
    );
  });
});

describe('buildPersonaSampleConversations (bulk per-persona sample data)', () => {
  it('produces one conversation per requested count (alice: 150)', () => {
    expect(buildPersonaSampleConversations('alice', 150)).toHaveLength(150);
  });

  it('scales with the requested count for a smaller roster', () => {
    expect(buildPersonaSampleConversations('bob', 3)).toHaveLength(3);
  });

  it('titles the third conversation as the search-tool demo, the rest per-persona', () => {
    const conversations = buildPersonaSampleConversations('alice', 5);
    expect(conversations[0]?.title).toBe('alice Conversation 1');
    expect(conversations[2]?.title).toBe('Quantum Computing Research');
    expect(conversations[4]?.title).toBe('alice Conversation 5');
  });

  it('gives generic conversations 3 + (index % 3) messages, alternating user/ai', () => {
    const conversations = buildPersonaSampleConversations('bob', 6);
    expect(conversations[0]?.messages).toHaveLength(3);
    expect(conversations[1]?.messages).toHaveLength(4);
    expect(conversations[3]?.messages).toHaveLength(3);
    expect(conversations[0]?.messages.map((message) => message.senderType)).toEqual([
      'user',
      'ai',
      'user',
    ]);
    expect(conversations[0]?.messages[0]?.content).toBe('bob message 1-1');
  });

  it('gives the search conversation the four canned search-tool messages', () => {
    const conversations = buildPersonaSampleConversations('alice', 3);
    expect(conversations[2]?.messages).toHaveLength(4);
    expect(conversations[2]?.messages.map((message) => message.senderType)).toEqual([
      'user',
      'ai',
      'user',
      'ai',
    ]);
  });

  it('assigns deterministic per-persona conversation ids', () => {
    const conversations = buildPersonaSampleConversations('alice', 3);
    expect(conversations[0]?.id).toBe(seedUUID('alice-conv-1'));
    expect(conversations[2]?.id).toBe(seedUUID('alice-conv-3'));
  });
});

describe('buildDocumentShowcaseConversations', () => {
  it('gives every dev persona a showcase conversation of their own', () => {
    const showcases = buildDocumentShowcaseConversations(DEV_PERSONAS);
    expect(showcases.map((showcase) => showcase.ownerEmail)).toEqual(
      DEV_PERSONAS.map((persona) => `${persona.name}@${DEV_EMAIL_DOMAIN}`)
    );
  });

  it('titles each one so it is obvious in the sidebar', () => {
    for (const showcase of buildDocumentShowcaseConversations(DEV_PERSONAS)) {
      expect(showcase.title).toBe(DOCUMENT_SHOWCASE_TITLE);
    }
  });

  it('carries the whole showcase transcript', () => {
    const [first] = buildDocumentShowcaseConversations(DEV_PERSONAS);
    expect(first?.messages).toEqual(DOCUMENT_SHOWCASE_MESSAGES);
  });

  it('addresses each conversation by a deterministic per-persona id', () => {
    const showcases = buildDocumentShowcaseConversations(DEV_PERSONAS);
    expect(showcases[0]?.id).toBe(seedUUID('alice-document-showcase'));
    expect(new Set(showcases.map((showcase) => showcase.id)).size).toBe(showcases.length);
  });

  it('produces the same conversations on a second run, so re-seeding adds nothing', () => {
    expect(buildDocumentShowcaseConversations(DEV_PERSONAS)).toEqual(
      buildDocumentShowcaseConversations(DEV_PERSONAS)
    );
  });
});

describe('personasWithSampleData (hasSampleData gate)', () => {
  it('selects only personas whose hasSampleData is set, with their conversation count', () => {
    const selected = personasWithSampleData([...DEV_PERSONAS, ADMIN_TARGET_PERSONA]);
    expect(selected.map((persona) => persona.name)).toEqual(['alice']);
    expect(selected[0]?.sampleConversationCount).toBe(150);
  });

  it('excludes non-hasSampleData personas (bob, charlie, mallory)', () => {
    const selected = personasWithSampleData([...DEV_PERSONAS, ADMIN_TARGET_PERSONA]);
    const names = selected.map((persona) => persona.name);
    expect(names).not.toContain('bob');
    expect(names).not.toContain('charlie');
    expect(names).not.toContain('mallory');
  });
});
