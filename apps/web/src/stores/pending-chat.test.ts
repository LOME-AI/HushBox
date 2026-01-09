import { describe, it, expect, beforeEach } from 'vitest';
import { usePendingChatStore } from './pending-chat';

describe('usePendingChatStore', () => {
  beforeEach(() => {
    usePendingChatStore.setState({ pendingMessage: null });
  });

  describe('initial state', () => {
    it('has null pending message by default', () => {
      const { pendingMessage } = usePendingChatStore.getState();
      expect(pendingMessage).toBeNull();
    });
  });

  describe('setPendingMessage', () => {
    it('sets the pending message', () => {
      usePendingChatStore.getState().setPendingMessage('Hello, world!');
      expect(usePendingChatStore.getState().pendingMessage).toBe('Hello, world!');
    });

    it('can set message to null', () => {
      usePendingChatStore.setState({ pendingMessage: 'Some message' });
      usePendingChatStore.getState().setPendingMessage(null);
      expect(usePendingChatStore.getState().pendingMessage).toBeNull();
    });

    it('overwrites existing message', () => {
      usePendingChatStore.getState().setPendingMessage('First message');
      usePendingChatStore.getState().setPendingMessage('Second message');
      expect(usePendingChatStore.getState().pendingMessage).toBe('Second message');
    });
  });

  describe('clearPendingMessage', () => {
    it('clears the pending message', () => {
      usePendingChatStore.setState({ pendingMessage: 'Message to clear' });
      usePendingChatStore.getState().clearPendingMessage();
      expect(usePendingChatStore.getState().pendingMessage).toBeNull();
    });

    it('is idempotent when already null', () => {
      usePendingChatStore.getState().clearPendingMessage();
      expect(usePendingChatStore.getState().pendingMessage).toBeNull();
    });
  });
});
