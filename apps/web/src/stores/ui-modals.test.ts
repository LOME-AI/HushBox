import { describe, it, expect, beforeEach } from 'vitest';
import { useUIModalsStore } from './ui-modals';

describe('useUIModalsStore', () => {
  beforeEach(() => {
    // Reset store between tests
    useUIModalsStore.setState({
      signupModalOpen: false,
      paymentModalOpen: false,
      premiumModelName: undefined,
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

    it('clears model name when closing signup modal', () => {
      useUIModalsStore.getState().openSignupModal('Claude 3 Opus');
      useUIModalsStore.getState().closeSignupModal();

      expect(useUIModalsStore.getState().premiumModelName).toBeUndefined();
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
});
