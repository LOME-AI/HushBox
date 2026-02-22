import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface UIModalsState {
  signupModalOpen: boolean;
  paymentModalOpen: boolean;
  premiumModelName: string | undefined;
  recoveryPhraseModalOpen: boolean;
  fromPaymentGate: boolean;
  memberSidebarOpen: boolean;
  mobileMemberSidebarOpen: boolean;
  addMemberModalOpen: boolean;
  budgetSettingsModalOpen: boolean;
  inviteLinkModalOpen: boolean;
  shareMessageModalOpen: boolean;
  shareMessageId: string | null;

  openSignupModal: (modelName?: string) => void;
  closeSignupModal: () => void;
  setSignupModalOpen: (open: boolean) => void;

  openPaymentModal: (modelName?: string) => void;
  closePaymentModal: () => void;
  setPaymentModalOpen: (open: boolean) => void;

  openRecoveryPhraseModal: (fromPaymentGate?: boolean) => void;
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
}

export const useUIModalsStore = create<UIModalsState>()(
  persist(
    (set, get) => ({
      signupModalOpen: false,
      paymentModalOpen: false,
      premiumModelName: undefined,
      recoveryPhraseModalOpen: false,
      fromPaymentGate: false,
      memberSidebarOpen: false,
      mobileMemberSidebarOpen: false,
      addMemberModalOpen: false,
      budgetSettingsModalOpen: false,
      inviteLinkModalOpen: false,
      shareMessageModalOpen: false,
      shareMessageId: null,

      openSignupModal: (modelName) => {
        set({ signupModalOpen: true, premiumModelName: modelName });
      },

      closeSignupModal: () => {
        set({ signupModalOpen: false, premiumModelName: undefined });
      },

      setSignupModalOpen: (open) => {
        set((state) => ({
          signupModalOpen: open,
          premiumModelName: open ? state.premiumModelName : undefined,
        }));
      },

      openPaymentModal: (modelName) => {
        set({ paymentModalOpen: true, premiumModelName: modelName });
      },

      closePaymentModal: () => {
        set({ paymentModalOpen: false, premiumModelName: undefined });
      },

      setPaymentModalOpen: (open) => {
        set((state) => ({
          paymentModalOpen: open,
          premiumModelName: open ? state.premiumModelName : undefined,
        }));
      },

      openRecoveryPhraseModal: (fromPaymentGate = false) => {
        set({ recoveryPhraseModalOpen: true, fromPaymentGate });
      },

      closeRecoveryPhraseModal: () => {
        set({ recoveryPhraseModalOpen: false, fromPaymentGate: false });
      },

      onRecoveryPhraseSuccess: () => {
        const { fromPaymentGate } = get();
        set({ recoveryPhraseModalOpen: false, fromPaymentGate: false });
        if (fromPaymentGate) {
          set({ paymentModalOpen: true });
        }
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
    }),
    {
      name: 'hushbox-ui-modals-storage',
      partialize: (state) => ({ memberSidebarOpen: state.memberSidebarOpen }),
    }
  )
);
