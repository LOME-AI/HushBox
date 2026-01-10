import { create } from 'zustand';

interface UIModalsState {
  signupModalOpen: boolean;
  paymentModalOpen: boolean;
  premiumModelName: string | undefined;

  openSignupModal: (modelName?: string) => void;
  closeSignupModal: () => void;
  setSignupModalOpen: (open: boolean) => void;

  openPaymentModal: (modelName?: string) => void;
  closePaymentModal: () => void;
  setPaymentModalOpen: (open: boolean) => void;
}

export const useUIModalsStore = create<UIModalsState>()((set) => ({
  signupModalOpen: false,
  paymentModalOpen: false,
  premiumModelName: undefined,

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
}));
