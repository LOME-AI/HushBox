import { useCallback } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useUIModalsStore } from '@/stores/ui/modals';
import type { Model, RefusalCode } from '@hushbox/shared';

/**
 * Hook for handling clicks on a row the user cannot send to.
 * Opens signup modal for unauthenticated users, payment modal for authenticated users.
 *
 * The session picks the door; the reason travels with the click so the door can
 * say something true of the row, since every refusal — not only the premium
 * pair — arrives here.
 */
export function usePremiumModelClick(
  models: Model[],
  isAuthenticated: boolean
): (modelId: string, reason: RefusalCode) => void {
  const { openSignupModal, openPaymentModal } = useUIModalsStore(
    useShallow((s) => ({
      openSignupModal: s.openSignupModal,
      openPaymentModal: s.openPaymentModal,
    }))
  );

  return useCallback(
    (modelId: string, reason: RefusalCode) => {
      const model = models.find((m) => m.id === modelId);

      if (isAuthenticated) {
        openPaymentModal(model?.name, reason, model?.id);
      } else {
        openSignupModal(model?.name, reason, model?.id);
      }
    },
    [models, isAuthenticated, openSignupModal, openPaymentModal]
  );
}
