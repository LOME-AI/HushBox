import { describe, it, expect } from 'vitest';
import { ROUTES, chatConversationRoute } from './routes.js';

describe('routes', () => {
  describe('ROUTES constants', () => {
    it('defines CHAT route', () => {
      expect(ROUTES.CHAT).toBe('/chat');
    });

    it('defines CHAT_CONVERSATION route with parameter placeholder', () => {
      expect(ROUTES.CHAT_CONVERSATION).toBe('/chat/$conversationId');
    });

    it('defines PROJECTS route', () => {
      expect(ROUTES.PROJECTS).toBe('/projects');
    });

    it('defines BILLING route', () => {
      expect(ROUTES.BILLING).toBe('/billing');
    });

    it('defines LOGIN route', () => {
      expect(ROUTES.LOGIN).toBe('/login');
    });

    it('defines SIGNUP route', () => {
      expect(ROUTES.SIGNUP).toBe('/signup');
    });

    it('defines VERIFY route', () => {
      expect(ROUTES.VERIFY).toBe('/verify');
    });

    it('defines DEV_PERSONAS route', () => {
      expect(ROUTES.DEV_PERSONAS).toBe('/dev/personas');
    });
  });

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
});
