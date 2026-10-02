import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { RefusalCode } from '@hushbox/shared';

interface UIModalsState {
  signupModalOpen: boolean;
  paymentModalOpen: boolean;
  premiumModelName: string | undefined;
  /** The id of the model {@link UIModalsState.premiumModelName} names, so the door can draw its swatch. */
  premiumModelId: string | undefined;
  /**
   * Why the row that opened the signup or payment modal was refused. The door is
   * picked by the session, so only this says what the door is about.
   */
  refusalReason: RefusalCode | undefined;
  recoveryPhraseModalOpen: boolean;
  memberSidebarOpen: boolean;
  mobileMemberSidebarOpen: boolean;
  addMemberModalOpen: boolean;
  budgetSettingsModalOpen: boolean;
  inviteLinkModalOpen: boolean;
  shareMessageModalOpen: boolean;
  shareMessageId: string | null;
  multiModelModalOpen: boolean;
  feedbackOpen: boolean;

  openSignupModal: (modelName?: string, reason?: RefusalCode, modelId?: string) => void;
  closeSignupModal: () => void;
  setSignupModalOpen: (open: boolean) => void;

  openPaymentModal: (modelName?: string, reason?: RefusalCode, modelId?: string) => void;
  closePaymentModal: () => void;
  setPaymentModalOpen: (open: boolean) => void;

  openRecoveryPhraseModal: () => void;
  closeRecoveryPhraseModal: () => void;
  onRecoveryPhraseSuccess: () => void;

  openMemberSidebar: () => void;
  closeMemberSidebar: () => void;
  toggleMemberSidebar: () => void;
  setMemberSidebarOpen: (open: boolean) => void;
  setMobileMemberSidebarOpen: (open: boolean) => void;

  openAddMemberModal: () => void;
  closeAddMemberModal: () => void;

  openBudgetSettingsModal: () => void;
  closeBudgetSettingsModal: () => void;

  openInviteLinkModal: () => void;
  closeInviteLinkModal: () => void;

  openShareMessageModal: (messageId: string) => void;
  closeShareMessageModal: () => void;

  setMultiModelModalOpen: (open: boolean) => void;

  setFeedbackOpen: (open: boolean) => void;
}

export const useUIModalsStore = create<UIModalsState>()(
  persist(
    (set) => ({
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
      multiModelModalOpen: false,
      feedbackOpen: false,

      openSignupModal: (modelName, reason, modelId) => {
        set({
          signupModalOpen: true,
          premiumModelName: modelName,
          premiumModelId: modelId,
          refusalReason: reason,
        });
      },

      closeSignupModal: () => {
        set({
          signupModalOpen: false,
          premiumModelName: undefined,
          premiumModelId: undefined,
          refusalReason: undefined,
        });
      },

      setSignupModalOpen: (open) => {
        set((state) => ({
          signupModalOpen: open,
          premiumModelName: open ? state.premiumModelName : undefined,
          premiumModelId: open ? state.premiumModelId : undefined,
          refusalReason: open ? state.refusalReason : undefined,
        }));
      },

      openPaymentModal: (modelName, reason, modelId) => {
        set({
          paymentModalOpen: true,
          premiumModelName: modelName,
          premiumModelId: modelId,
          refusalReason: reason,
        });
      },

      closePaymentModal: () => {
        set({
          paymentModalOpen: false,
          premiumModelName: undefined,
          premiumModelId: undefined,
          refusalReason: undefined,
        });
      },

      setPaymentModalOpen: (open) => {
        set((state) => ({
          paymentModalOpen: open,
          premiumModelName: open ? state.premiumModelName : undefined,
          premiumModelId: open ? state.premiumModelId : undefined,
          refusalReason: open ? state.refusalReason : undefined,
        }));
      },

      openRecoveryPhraseModal: () => {
        set({ recoveryPhraseModalOpen: true });
      },

      closeRecoveryPhraseModal: () => {
        set({ recoveryPhraseModalOpen: false });
      },

      onRecoveryPhraseSuccess: () => {
        set({ recoveryPhraseModalOpen: false });
      },

      openMemberSidebar: () => {
        set({ memberSidebarOpen: true });
      },

      closeMemberSidebar: () => {
        set({ memberSidebarOpen: false });
      },

      toggleMemberSidebar: () => {
        set((state) => ({ memberSidebarOpen: !state.memberSidebarOpen }));
      },

      setMemberSidebarOpen: (open) => {
        set({ memberSidebarOpen: open });
      },

      setMobileMemberSidebarOpen: (open) =>
        set(
          open
            ? { mobileMemberSidebarOpen: true, memberSidebarOpen: true }
            : { mobileMemberSidebarOpen: false }
        ),

      openAddMemberModal: () => {
        set({ addMemberModalOpen: true });
      },

      closeAddMemberModal: () => {
        set({ addMemberModalOpen: false });
      },

      openBudgetSettingsModal: () => {
        set({ budgetSettingsModalOpen: true });
      },

      closeBudgetSettingsModal: () => {
        set({ budgetSettingsModalOpen: false });
      },

      openInviteLinkModal: () => {
        set({ inviteLinkModalOpen: true });
      },

      closeInviteLinkModal: () => {
        set({ inviteLinkModalOpen: false });
      },

      openShareMessageModal: (messageId) => {
        set({ shareMessageModalOpen: true, shareMessageId: messageId });
      },

      closeShareMessageModal: () => {
        set({ shareMessageModalOpen: false, shareMessageId: null });
      },

      setMultiModelModalOpen: (open) => {
        set({ multiModelModalOpen: open });
      },

      setFeedbackOpen: (open) => {
        set({ feedbackOpen: open });
      },
    }),
    {
      name: 'hushbox-ui-modals-storage',
      partialize: (state) => ({ memberSidebarOpen: state.memberSidebarOpen }),
    }
  )
);
