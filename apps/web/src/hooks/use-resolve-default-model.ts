import * as React from 'react';
import { useSession } from '@/lib/auth';
import { useModelStore } from '@/stores/model';
import { useBalance } from './billing.js';
import { useModels } from './models.js';
import type { Model, Modality } from '@hushbox/shared';
import type { SelectedModelEntry } from '@/stores/model';

interface ResolveParams {
  modality: Modality;
  currentSelection: SelectedModelEntry[];
  models: Model[];
  premiumIds: Set<string>;
  canAccessPremium: boolean;
}

/**
 * Computes the default selection for a non-text modality, or `undefined` if no
 * work is needed. Returning `undefined` lets the caller skip a `setState` call.
 */
function resolveDefault(params: ResolveParams): SelectedModelEntry[] | undefined {
  const { modality, currentSelection, models, premiumIds, canAccessPremium } = params;
  if (modality === 'text') return undefined;
  if (currentSelection.length > 0) return undefined;

  const candidate = models.find(
    (model) => model.modality === modality && (canAccessPremium || !premiumIds.has(model.id))
  );
  if (!candidate) return undefined;

  return [{ id: candidate.id, name: candidate.name }];
}

/**
 * Lazily populates `selections[modality]` with a default model the first time a
 * non-text modality is activated. Text is a no-op because the store's subscriber
 * guard always keeps a Smart Model entry in `selections.text`.
 *
 * The default is the first eligible model for that modality after premium filtering.
 */
export function useResolveDefaultModel(modality: Modality): void {
  const { data: session, isPending: isSessionPending } = useSession();
  const { data: balanceData } = useBalance();
  const { data: modelsData } = useModels();
  const currentSelection = useModelStore((state) => state.selections[modality]);
  const setSelectedModels = useModelStore((state) => state.setSelectedModels);

  React.useEffect(() => {
    if (isSessionPending || !modelsData) return;
    const isAuthenticated = Boolean(session?.user);
    if (isAuthenticated && !balanceData) return;

    const balance = Number.parseFloat(balanceData?.balance ?? '0');
    const canAccessPremium = isAuthenticated && balance > 0;

    const next = resolveDefault({
      modality,
      currentSelection,
      models: modelsData.models,
      premiumIds: modelsData.premiumIds,
      canAccessPremium,
    });
    if (next) setSelectedModels(modality, next);
  }, [
    modality,
    session?.user,
    isSessionPending,
    balanceData,
    modelsData,
    currentSelection,
    setSelectedModels,
  ]);
}
