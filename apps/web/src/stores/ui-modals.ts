import { create } from 'zustand';

type SignupModalVariant = 'premium' | 'rate-limit';

interface UIModalsState {
  signupModalOpen: boolean;
  signupModalVariant: SignupModalVariant;
  paymentModalOpen: boolean;
  premiumModelName: string | undefined;

  openSignupModal: (modelName?: string, variant?: SignupModalVariant) => void;
  closeSignupModal: () => void;
  setSignupModalOpen: (open: boolean) => void;

  openPaymentModal: (modelName?: string) => void;
  closePaymentModal: () => void;
  setPaymentModalOpen: (open: boolean) => void;
}

export const useUIModalsStore = create<UIModalsState>()((set) => ({
  signupModalOpen: false,
  signupModalVariant: 'premium',
  paymentModalOpen: false,
  premiumModelName: undefined,

  openSignupModal: (modelName, variant = 'premium') => {
    set({ signupModalOpen: true, premiumModelName: modelName, signupModalVariant: variant });
  },

  closeSignupModal: () => {
    set({ signupModalOpen: false, premiumModelName: undefined, signupModalVariant: 'premium' });
  },

  setSignupModalOpen: (open) => {
    set((state) => ({
      signupModalOpen: open,
      premiumModelName: open ? state.premiumModelName : undefined,
      signupModalVariant: open ? state.signupModalVariant : 'premium',
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
