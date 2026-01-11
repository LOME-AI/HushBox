import * as React from 'react';
import { useModels, getAccessibleModelIds } from './models.js';
import { useSession } from '@/lib/auth';
import { useBalance } from './billing.js';
import { useModelStore } from '@/stores/model';

/**
 * Hook that validates the currently selected model against user tier.
 *
 * If a user has a premium model selected but can no longer access premium
 * (e.g., balance depleted, logged out), this hook automatically resets
 * to the strongest accessible model.
 *
 * Should be called once at a high level (e.g., AppShell) to cover all routes.
 */
export function useModelValidation(): void {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: balanceData } = useBalance();
  const { data: modelsData } = useModels();
  const { selectedModelId, setSelectedModel } = useModelStore();

  React.useEffect(() => {
    if (!modelsData) return;

    // Wait for session to finish loading before making any decisions.
    // Without this, we'd incorrectly treat a loading authenticated user as a guest.
    if (isSessionPending) return;

    const isAuthenticated = Boolean(session?.user);

    // For authenticated users, wait for balance data before validating.
    // This prevents incorrectly resetting a premium model on page refresh
    // before the balance has loaded.
    if (isAuthenticated && !balanceData) return;

    // Now we have definitive tier info
    const balance = parseFloat(balanceData?.balance ?? '0');
    const canAccessPremium = isAuthenticated && balance > 0;

    const { premiumIds, models } = modelsData;
    const isSelectedModelPremium = premiumIds.has(selectedModelId);

    if (!canAccessPremium && isSelectedModelPremium) {
      const { strongestId } = getAccessibleModelIds(models, premiumIds, false);
      const strongestModel = models.find((m) => m.id === strongestId);
      if (strongestModel) {
        setSelectedModel(strongestId, strongestModel.name);
      }
    }
  }, [modelsData, session?.user, isSessionPending, balanceData, selectedModelId, setSelectedModel]);
}
