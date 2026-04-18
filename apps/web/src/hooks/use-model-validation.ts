import * as React from 'react';
import { useSession } from '@/lib/auth';
import { useModelStore } from '@/stores/model';
import { useBalance } from './billing.js';
import { useModels, getAccessibleModelIds } from './models.js';
import type { Model, Modality } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';
import type { ModelsData } from './models.js';

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

interface ValidateModalityParams {
  modality: Modality;
  current: SelectedModelEntry[];
  models: Model[];
  premiumIds: Set<string>;
  canAccessPremium: boolean;
  textFallback: SelectedModelEntry | undefined;
}

/**
 * Returns the next selection list for a modality, or `undefined` if no change is needed.
 *
 * Drops entries that no longer exist in the API or that the user can't access (premium).
 * For the text modality, empties after filtering are replaced with the strongest
 * accessible text model so the UI always has a primary model to render.
 */
function validateModality(params: ValidateModalityParams): SelectedModelEntry[] | undefined {
  const { modality, current, models, premiumIds, canAccessPremium, textFallback } = params;
  // Empty text is impossible at runtime (subscriber guard + merge restore it);
  // empty image/audio/video is legitimate and is repopulated by useResolveDefaultModel.
  if (current.length === 0) return undefined;

  const validIds = new Set(models.map((m) => m.id));
  const filtered = current.filter(
    (entry) => validIds.has(entry.id) && (canAccessPremium || !premiumIds.has(entry.id))
  );

  if (filtered.length === current.length) return undefined;

  if (modality === 'text' && filtered.length === 0) {
    if (!textFallback) return undefined;
    return [textFallback];
  }
  return filtered;
}

const MODALITIES: readonly Modality[] = ['text', 'image', 'audio', 'video'];

export function useModelValidation(): void {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: balanceData } = useBalance();
  const { data: modelsData } = useModels();
  const selections = useModelStore((state) => state.selections);
  const setSelectedModels = useModelStore((state) => state.setSelectedModels);

  React.useEffect(() => {
    const isAuthenticated = Boolean(session?.user);
    const state = getValidationState({
      modelsData,
      isSessionPending,
      isAuthenticated,
      balanceData,
    });

    if (!state.isReady || !modelsData) return;

    const { models, premiumIds } = modelsData;
    const { canAccessPremium } = state;

    const { strongestId } = getAccessibleModelIds(models, premiumIds, canAccessPremium);
    const strongestModel = models.find((m) => m.id === strongestId);
    const textFallback: SelectedModelEntry | undefined = strongestModel
      ? { id: strongestModel.id, name: strongestModel.name }
      : undefined;

    for (const modality of MODALITIES) {
      const modalityModels = models.filter((m) => m.modality === modality);
      const next = validateModality({
        modality,
        current: selections[modality],
        models: modalityModels,
        premiumIds,
        canAccessPremium,
        textFallback,
      });
      if (next !== undefined) {
        setSelectedModels(modality, next);
      }
    }
  }, [modelsData, session?.user, isSessionPending, balanceData, selections, setSelectedModels]);
}
