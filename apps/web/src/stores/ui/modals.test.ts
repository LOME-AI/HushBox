import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useUIModalsStore } from './modals';

const STORAGE_KEY = 'hushbox-ui-modals-storage';

describe('useUIModalsStore', () => {
  beforeEach(() => {
    useUIModalsStore.setState({
      signupModalOpen: false,
      paymentModalOpen: false,
      premiumModelName: undefined,
      premiumModelId: undefined,
      refusalReason: undefined,
      recoveryPhraseModalOpen: false,
      memberSidebarOpen: false,
      mobileMemberSidebarOpen: false,
      addMemberModalOpen: false,
      budgetSettingsModalOpen: false,
      inviteLinkModalOpen: false,
      shareMessageModalOpen: false,
      shareMessageId: null,
      feedbackOpen: false,
    });
  });

  describe('feedback dialog', () => {
    it('starts closed', () => {
      expect(useUIModalsStore.getInitialState().feedbackOpen).toBe(false);
    });

    it('opens the feedback dialog', () => {
      useUIModalsStore.getState().setFeedbackOpen(true);

      expect(useUIModalsStore.getState().feedbackOpen).toBe(true);
    });

    it('closes the feedback dialog', () => {
      useUIModalsStore.getState().setFeedbackOpen(true);
      useUIModalsStore.getState().setFeedbackOpen(false);

      expect(useUIModalsStore.getState().feedbackOpen).toBe(false);
    });
  });

  describe('signup modal', () => {
    it('opens signup modal', () => {
      useUIModalsStore.getState().openSignupModal();

      expect(useUIModalsStore.getState().signupModalOpen).toBe(true);
    });

    it('opens signup modal with model name', () => {
      useUIModalsStore.getState().openSignupModal('Claude 3 Opus');

      expect(useUIModalsStore.getState().signupModalOpen).toBe(true);
      expect(useUIModalsStore.getState().premiumModelName).toBe('Claude 3 Opus');
    });

    it('closes signup modal', () => {
      useUIModalsStore.getState().openSignupModal();
      useUIModalsStore.getState().closeSignupModal();

      expect(useUIModalsStore.getState().signupModalOpen).toBe(false);
    });

    it('opens signup modal with the reason the row was refused', () => {
      useUIModalsStore.getState().openSignupModal('Claude 3 Opus', 'prompt_too_long');

      expect(useUIModalsStore.getState().refusalReason).toBe('prompt_too_long');
    });

    it('clears the refusal reason when closing signup modal', () => {
      useUIModalsStore.getState().openSignupModal('Claude 3 Opus', 'prompt_too_long');
      useUIModalsStore.getState().closeSignupModal();

      expect(useUIModalsStore.getState().refusalReason).toBeUndefined();
    });

    it('clears the refusal reason when the signup modal is set closed', () => {
      useUIModalsStore.getState().openSignupModal('Claude 3 Opus', 'prompt_too_long');
      useUIModalsStore.getState().setSignupModalOpen(false);

      expect(useUIModalsStore.getState().refusalReason).toBeUndefined();
    });

    it('clears model name when closing signup modal', () => {
      useUIModalsStore.getState().openSignupModal('Claude 3 Opus');
      useUIModalsStore.getState().closeSignupModal();

      expect(useUIModalsStore.getState().premiumModelName).toBeUndefined();
    });

    it('opens signup modal with the refused model id', () => {
      useUIModalsStore
        .getState()
        .openSignupModal('Claude 3 Opus', 'premium_requires_account', 'anthropic/claude-3-opus');

      expect(useUIModalsStore.getState().premiumModelId).toBe('anthropic/claude-3-opus');
    });

    it('clears the refused model id when a later opening names no model', () => {
      useUIModalsStore
        .getState()
        .openSignupModal('Claude 3 Opus', 'premium_requires_account', 'anthropic/claude-3-opus');
      useUIModalsStore.getState().openSignupModal();

      expect(useUIModalsStore.getState().premiumModelId).toBeUndefined();
    });

    it('clears the refused model id when closing signup modal', () => {
      useUIModalsStore
        .getState()
        .openSignupModal('Claude 3 Opus', 'premium_requires_account', 'anthropic/claude-3-opus');
      useUIModalsStore.getState().closeSignupModal();

      expect(useUIModalsStore.getState().premiumModelId).toBeUndefined();
    });

    it('clears the refused model id when the signup modal is set closed', () => {
      useUIModalsStore
        .getState()
        .openSignupModal('Claude 3 Opus', 'premium_requires_account', 'anthropic/claude-3-opus');
      useUIModalsStore.getState().setSignupModalOpen(false);

      expect(useUIModalsStore.getState().premiumModelId).toBeUndefined();
    });

    it('keeps the refused model id when the signup modal is set open', () => {
      useUIModalsStore
        .getState()
        .openSignupModal('Claude 3 Opus', 'premium_requires_account', 'anthropic/claude-3-opus');
      useUIModalsStore.getState().setSignupModalOpen(true);

      expect(useUIModalsStore.getState().premiumModelId).toBe('anthropic/claude-3-opus');
    });
  });

  describe('payment modal', () => {
    it('opens payment modal', () => {
      useUIModalsStore.getState().openPaymentModal();

      expect(useUIModalsStore.getState().paymentModalOpen).toBe(true);
    });

    it('opens payment modal with model name', () => {
      useUIModalsStore.getState().openPaymentModal('GPT-4 Turbo');

      expect(useUIModalsStore.getState().paymentModalOpen).toBe(true);
      expect(useUIModalsStore.getState().premiumModelName).toBe('GPT-4 Turbo');
    });

    it('closes payment modal', () => {
      useUIModalsStore.getState().openPaymentModal();
      useUIModalsStore.getState().closePaymentModal();

      expect(useUIModalsStore.getState().paymentModalOpen).toBe(false);
    });

    it('clears model name when closing payment modal', () => {
      useUIModalsStore.getState().openPaymentModal('GPT-4 Turbo');
      useUIModalsStore.getState().closePaymentModal();

      expect(useUIModalsStore.getState().premiumModelName).toBeUndefined();
    });

    it('opens payment modal with the reason the row was refused', () => {
      useUIModalsStore.getState().openPaymentModal('GPT-4 Turbo', 'insufficient_funds');

      expect(useUIModalsStore.getState().refusalReason).toBe('insufficient_funds');
    });

    it('clears the refusal reason when closing payment modal', () => {
      useUIModalsStore.getState().openPaymentModal('GPT-4 Turbo', 'insufficient_funds');
      useUIModalsStore.getState().closePaymentModal();

      expect(useUIModalsStore.getState().refusalReason).toBeUndefined();
    });

    it('clears the refusal reason when the payment modal is set closed', () => {
      useUIModalsStore.getState().openPaymentModal('GPT-4 Turbo', 'insufficient_funds');
      useUIModalsStore.getState().setPaymentModalOpen(false);

      expect(useUIModalsStore.getState().refusalReason).toBeUndefined();
    });

    it('opens payment modal with the refused model id', () => {
      useUIModalsStore
        .getState()
        .openPaymentModal('GPT-4 Turbo', 'insufficient_funds', 'openai/gpt-4-turbo');

      expect(useUIModalsStore.getState().premiumModelId).toBe('openai/gpt-4-turbo');
    });

    it('clears the refused model id when closing payment modal', () => {
      useUIModalsStore
        .getState()
        .openPaymentModal('GPT-4 Turbo', 'insufficient_funds', 'openai/gpt-4-turbo');
      useUIModalsStore.getState().closePaymentModal();

      expect(useUIModalsStore.getState().premiumModelId).toBeUndefined();
    });

    it('clears the refused model id when the payment modal is set closed', () => {
      useUIModalsStore
        .getState()
        .openPaymentModal('GPT-4 Turbo', 'insufficient_funds', 'openai/gpt-4-turbo');
      useUIModalsStore.getState().setPaymentModalOpen(false);

      expect(useUIModalsStore.getState().premiumModelId).toBeUndefined();
    });

    it('keeps the refused model id when the payment modal is set open', () => {
      useUIModalsStore
        .getState()
        .openPaymentModal('GPT-4 Turbo', 'insufficient_funds', 'openai/gpt-4-turbo');
      useUIModalsStore.getState().setPaymentModalOpen(true);

      expect(useUIModalsStore.getState().premiumModelId).toBe('openai/gpt-4-turbo');
    });
  });

  describe('setSignupModalOpen', () => {
    it('sets modal state directly', () => {
      useUIModalsStore.getState().setSignupModalOpen(true);
      expect(useUIModalsStore.getState().signupModalOpen).toBe(true);

      useUIModalsStore.getState().setSignupModalOpen(false);
      expect(useUIModalsStore.getState().signupModalOpen).toBe(false);
    });
  });

  describe('setPaymentModalOpen', () => {
    it('sets modal state directly', () => {
      useUIModalsStore.getState().setPaymentModalOpen(true);
      expect(useUIModalsStore.getState().paymentModalOpen).toBe(true);

      useUIModalsStore.getState().setPaymentModalOpen(false);
      expect(useUIModalsStore.getState().paymentModalOpen).toBe(false);
    });
  });

  describe('recovery phrase modal', () => {
    it('opens recovery phrase modal', () => {
      useUIModalsStore.getState().openRecoveryPhraseModal();

      expect(useUIModalsStore.getState().recoveryPhraseModalOpen).toBe(true);
    });

    it('closes recovery phrase modal', () => {
      useUIModalsStore.getState().openRecoveryPhraseModal();
      useUIModalsStore.getState().closeRecoveryPhraseModal();

      expect(useUIModalsStore.getState().recoveryPhraseModalOpen).toBe(false);
    });

    it('closes recovery phrase modal on success', () => {
      useUIModalsStore.getState().openRecoveryPhraseModal();
      useUIModalsStore.getState().onRecoveryPhraseSuccess();

      expect(useUIModalsStore.getState().recoveryPhraseModalOpen).toBe(false);
    });
  });

  describe('multi-model modal', () => {
    it('opens and closes via setMultiModelModalOpen', () => {
      useUIModalsStore.getState().setMultiModelModalOpen(true);
      expect(useUIModalsStore.getState().multiModelModalOpen).toBe(true);

      useUIModalsStore.getState().setMultiModelModalOpen(false);
      expect(useUIModalsStore.getState().multiModelModalOpen).toBe(false);
    });
  });

  describe('member sidebar', () => {
    it('opens member sidebar', () => {
      useUIModalsStore.getState().openMemberSidebar();

      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(true);
    });

    it('closes member sidebar', () => {
      useUIModalsStore.getState().openMemberSidebar();
      useUIModalsStore.getState().closeMemberSidebar();

      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(false);
    });

    it('sets member sidebar open state directly', () => {
      useUIModalsStore.getState().setMemberSidebarOpen(true);
      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(true);

      useUIModalsStore.getState().setMemberSidebarOpen(false);
      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(false);
    });

    it('toggles member sidebar from closed to open', () => {
      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(false);

      useUIModalsStore.getState().toggleMemberSidebar();

      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(true);
    });

    it('toggles member sidebar from open to closed', () => {
      useUIModalsStore.getState().openMemberSidebar();
      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(true);

      useUIModalsStore.getState().toggleMemberSidebar();

      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(false);
    });

    it('defaults mobileMemberSidebarOpen to false', () => {
      expect(useUIModalsStore.getState().mobileMemberSidebarOpen).toBe(false);
    });

    it('sets mobileMemberSidebarOpen to true and syncs memberSidebarOpen', () => {
      useUIModalsStore.getState().setMobileMemberSidebarOpen(true);

      expect(useUIModalsStore.getState().mobileMemberSidebarOpen).toBe(true);
      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(true);
    });

    it('sets mobileMemberSidebarOpen to false without changing memberSidebarOpen', () => {
      useUIModalsStore.getState().openMemberSidebar();
      useUIModalsStore.getState().setMobileMemberSidebarOpen(true);
      useUIModalsStore.getState().setMobileMemberSidebarOpen(false);

      expect(useUIModalsStore.getState().mobileMemberSidebarOpen).toBe(false);
      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(true);
    });
  });

  describe('add member modal', () => {
    it('opens add member modal', () => {
      useUIModalsStore.getState().openAddMemberModal();

      expect(useUIModalsStore.getState().addMemberModalOpen).toBe(true);
    });

    it('closes add member modal', () => {
      useUIModalsStore.getState().openAddMemberModal();
      useUIModalsStore.getState().closeAddMemberModal();

      expect(useUIModalsStore.getState().addMemberModalOpen).toBe(false);
    });
  });

  describe('budget settings modal', () => {
    it('opens budget settings modal', () => {
      useUIModalsStore.getState().openBudgetSettingsModal();

      expect(useUIModalsStore.getState().budgetSettingsModalOpen).toBe(true);
    });

    it('closes budget settings modal', () => {
      useUIModalsStore.getState().openBudgetSettingsModal();
      useUIModalsStore.getState().closeBudgetSettingsModal();

      expect(useUIModalsStore.getState().budgetSettingsModalOpen).toBe(false);
    });
  });

  describe('invite link modal', () => {
    it('opens invite link modal', () => {
      useUIModalsStore.getState().openInviteLinkModal();

      expect(useUIModalsStore.getState().inviteLinkModalOpen).toBe(true);
    });

    it('closes invite link modal', () => {
      useUIModalsStore.getState().openInviteLinkModal();
      useUIModalsStore.getState().closeInviteLinkModal();

      expect(useUIModalsStore.getState().inviteLinkModalOpen).toBe(false);
    });
  });

  describe('share message modal', () => {
    it('opens share message modal with message ID', () => {
      useUIModalsStore.getState().openShareMessageModal('msg-123');

      expect(useUIModalsStore.getState().shareMessageModalOpen).toBe(true);
      expect(useUIModalsStore.getState().shareMessageId).toBe('msg-123');
    });

    it('closes share message modal and clears message ID', () => {
      useUIModalsStore.getState().openShareMessageModal('msg-123');
      useUIModalsStore.getState().closeShareMessageModal();

      expect(useUIModalsStore.getState().shareMessageModalOpen).toBe(false);
      expect(useUIModalsStore.getState().shareMessageId).toBeNull();
    });
  });

  describe('persistence', () => {
    const setItemMock = vi.spyOn(localStorage, 'setItem');
    const getItemMock = vi.spyOn(localStorage, 'getItem');

    beforeEach(() => {
      setItemMock.mockClear();
    });

    it('persists memberSidebarOpen to localStorage', async () => {
      useUIModalsStore.getState().openMemberSidebar();

      // Zustand persist writes asynchronously via microtask
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      const call = setItemMock.mock.calls.find(([key]) => key === STORAGE_KEY);
      expect(call).toBeDefined();
      const stored = JSON.parse(call![1]);
      expect(stored.state.memberSidebarOpen).toBe(true);
    });

    it('does not persist other modal states to localStorage', async () => {
      setItemMock.mockClear();
      useUIModalsStore.getState().openSignupModal();
      useUIModalsStore.getState().openPaymentModal();
      useUIModalsStore.getState().openAddMemberModal();
      useUIModalsStore.getState().openBudgetSettingsModal();
      useUIModalsStore.getState().openInviteLinkModal();
      useUIModalsStore.getState().openShareMessageModal('msg-1');
      useUIModalsStore.getState().setMobileMemberSidebarOpen(true);

      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

      const calls = setItemMock.mock.calls.filter(([key]) => key === STORAGE_KEY);
      for (const [, value] of calls) {
        const stored = JSON.parse(value);
        expect(Object.keys(stored.state)).toStrictEqual(['memberSidebarOpen']);
      }
    });

    it('restores memberSidebarOpen from localStorage on rehydration', async () => {
      getItemMock.mockImplementation((key) =>
        key === STORAGE_KEY
          ? JSON.stringify({ state: { memberSidebarOpen: true }, version: 0 })
          : null
      );

      await useUIModalsStore.persist.rehydrate();

      expect(useUIModalsStore.getState().memberSidebarOpen).toBe(true);

      getItemMock.mockImplementation(() => null);
    });
  });
});
