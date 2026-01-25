import * as React from 'react';
import { useModels, getAccessibleModelIds, type ModelsData } from './models.js';
import { useSession } from '@/lib/auth';
import { useBalance } from './billing.js';
import { useModelStore } from '@/stores/model';

interface ValidationStateParams {
  modelsData: ModelsData | undefined;
  isSessionPending: boolean;
  isAuthenticated: boolean;
  balanceData: { balance: string } | undefined;
}

type ValidationState = { isReady: false } | { isReady: true; canAccessPremium: boolean };

function getValidationState(params: ValidationStateParams): ValidationState {
  const { modelsData, isSessionPending, isAuthenticated, balanceData } = params;

  if (!modelsData) return { isReady: false };
  if (isSessionPending) return { isReady: false };
  if (isAuthenticated && !balanceData) return { isReady: false };

  const balance = Number.parseFloat(balanceData?.balance ?? '0');
  const canAccessPremium = isAuthenticated && balance > 0;

  return { isReady: true, canAccessPremium };
}

export function useModelValidation(): void {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: balanceData } = useBalance();
  const { data: modelsData } = useModels();
  const { selectedModelId, setSelectedModel } = useModelStore();

  React.useEffect(() => {
    const isAuthenticated = Boolean(session?.user);
    const state = getValidationState({
      modelsData,
      isSessionPending,
      isAuthenticated,
      balanceData,
    });

    if (!state.isReady || !modelsData) return;

    const { premiumIds, models } = modelsData;
    const isSelectedModelPremium = premiumIds.has(selectedModelId);

    if (!state.canAccessPremium && isSelectedModelPremium) {
      const { strongestId } = getAccessibleModelIds(models, premiumIds, false);
      const strongestModel = models.find((m) => m.id === strongestId);
      if (strongestModel) {
        setSelectedModel(strongestId, strongestModel.name);
      }
    }
  }, [modelsData, session?.user, isSessionPending, balanceData, selectedModelId, setSelectedModel]);
}
