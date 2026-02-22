import { useCallback } from 'react';
import type { Model } from '@hushbox/shared';
import { useUIModalsStore } from '@/stores/ui-modals';

/**
 * Hook for handling premium model click actions.
 * Opens signup modal for unauthenticated users, payment modal for authenticated users.
 */
export function usePremiumModelClick(
  models: Model[],
  isAuthenticated: boolean
): (modelId: string) => void {
  const { openSignupModal, openPaymentModal } = useUIModalsStore();

  return useCallback(
    (modelId: string) => {
      const model = models.find((m) => m.id === modelId);
      const modelName = model?.name;

      if (isAuthenticated) {
        openPaymentModal(modelName);
      } else {
        openSignupModal(modelName);
      }
    },
    [models, isAuthenticated, openSignupModal, openPaymentModal]
  );
}
