import { describe, it, expect, beforeEach } from 'vitest';
import { usePendingChatStore } from './pending-chat';

describe('usePendingChatStore', () => {
  beforeEach(() => {
    usePendingChatStore.setState({ pendingMessage: null, pendingFundingSource: null });
  });

  describe('initial state', () => {
    it('has null pending message by default', () => {
      const { pendingMessage } = usePendingChatStore.getState();
      expect(pendingMessage).toBeNull();
    });

    it('has null pending funding source by default', () => {
      const { pendingFundingSource } = usePendingChatStore.getState();
      expect(pendingFundingSource).toBeNull();
    });
  });

  describe('setPendingMessage', () => {
    it('sets the pending message and funding source', () => {
      usePendingChatStore.getState().setPendingMessage('Hello, world!', 'personal_balance');

      const { pendingMessage, pendingFundingSource } = usePendingChatStore.getState();
      expect(pendingMessage).toBe('Hello, world!');
      expect(pendingFundingSource).toBe('personal_balance');
    });

    it('overwrites existing message and funding source', () => {
      usePendingChatStore.getState().setPendingMessage('First message', 'personal_balance');
      usePendingChatStore.getState().setPendingMessage('Second message', 'free_allowance');

      const { pendingMessage, pendingFundingSource } = usePendingChatStore.getState();
      expect(pendingMessage).toBe('Second message');
      expect(pendingFundingSource).toBe('free_allowance');
    });
  });

  describe('clearPendingMessage', () => {
    it('clears the pending message and funding source', () => {
      usePendingChatStore.setState({
        pendingMessage: 'Message to clear',
        pendingFundingSource: 'personal_balance',
      });

      usePendingChatStore.getState().clearPendingMessage();

      const { pendingMessage, pendingFundingSource } = usePendingChatStore.getState();
      expect(pendingMessage).toBeNull();
      expect(pendingFundingSource).toBeNull();
    });

    it('is idempotent when already null', () => {
      usePendingChatStore.getState().clearPendingMessage();

      const { pendingMessage, pendingFundingSource } = usePendingChatStore.getState();
      expect(pendingMessage).toBeNull();
      expect(pendingFundingSource).toBeNull();
    });
  });
});
