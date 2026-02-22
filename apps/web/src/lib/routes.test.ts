import { describe, it, expect } from 'vitest';
import { ROUTES } from '@hushbox/shared';
import { chatConversationRoute, shareConversationRoute, shareMessageRoute } from './routes.js';

describe('routes', () => {
  describe('chatConversationRoute', () => {
    it('returns correct route with conversation ID', () => {
      expect(chatConversationRoute('abc-123')).toBe('/chat/abc-123');
    });

    it('handles UUID-style conversation IDs', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(chatConversationRoute(uuid)).toBe(`/chat/${uuid}`);
    });

    it('uses ROUTES.CHAT as base path', () => {
      const result = chatConversationRoute('test-id');
      expect(result.startsWith(ROUTES.CHAT)).toBe(true);
    });
  });

  describe('shareConversationRoute', () => {
    it('returns URL with conversationId and key in fragment', () => {
      expect(shareConversationRoute('conv-abc', 'key123')).toBe('/share/c/conv-abc#key123');
    });

    it('handles UUID-style conversation IDs', () => {
      const uuid = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
      expect(shareConversationRoute(uuid, 'secretKey')).toBe(`/share/c/${uuid}#secretKey`);
    });
  });

  describe('shareMessageRoute', () => {
    it('returns URL with shareId and key in fragment', () => {
      expect(shareMessageRoute('share-xyz', 'msgKey456')).toBe('/share/m/share-xyz#msgKey456');
    });

    it('handles UUID-style share IDs', () => {
      const uuid = 'f1e2d3c4-b5a6-0987-fedc-ba0987654321';
      expect(shareMessageRoute(uuid, 'anotherKey')).toBe(`/share/m/${uuid}#anotherKey`);
    });
  });
});
