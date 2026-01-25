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

      const { pendingMessage } = usePendingChatStore.getState();
      expect(pendingMessage).toBe('Hello, world!');
    });

    it('overwrites existing message', () => {
      usePendingChatStore.getState().setPendingMessage('First message');
      usePendingChatStore.getState().setPendingMessage('Second message');

      const { pendingMessage } = usePendingChatStore.getState();
      expect(pendingMessage).toBe('Second message');
    });

    it('can set message to null', () => {
      usePendingChatStore.getState().setPendingMessage('Test');
      usePendingChatStore.getState().setPendingMessage(null);

      const { pendingMessage } = usePendingChatStore.getState();
      expect(pendingMessage).toBeNull();
    });
  });

  describe('clearPendingMessage', () => {
    it('clears the pending message', () => {
      usePendingChatStore.setState({ pendingMessage: 'Message to clear' });

      usePendingChatStore.getState().clearPendingMessage();

      const { pendingMessage } = usePendingChatStore.getState();
      expect(pendingMessage).toBeNull();
    });

    it('is idempotent when already null', () => {
      usePendingChatStore.getState().clearPendingMessage();

      const { pendingMessage } = usePendingChatStore.getState();
      expect(pendingMessage).toBeNull();
    });
  });
});
