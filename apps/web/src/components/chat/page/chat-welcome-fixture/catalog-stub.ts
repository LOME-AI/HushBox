import * as React from 'react';
import { SMART_MODEL_ID, type Model } from '@hushbox/shared';
import type { ModelsData } from '@/hooks/models/models';

/** The Smart Model as the catalog serves it, with its rate range in billable nano-USD. */
const FIXTURE_SMART_MODEL: Model = {
  id: SMART_MODEL_ID,
  name: 'Smart Model',
  provider: 'HushBox',
  description: 'Picks a model for each message.',
  modality: 'text',
  contextLength: 200_000,
  supportedParameters: [],
  isSmartModel: true,
  pricing: {},
  minPricing: { inputPerToken: '35', outputPerToken: '115' },
  maxPricing: { inputPerToken: '34500', outputPerToken: '207000' },
};

let catalog: ModelsData | undefined;
const listeners = new Set<() => void>();

/** Answers the catalog query, as the network does once the page has painted. */
export function resolveCatalog(): void {
  catalog = { models: [FIXTURE_SMART_MODEL], premiumIds: new Set() };
  for (const listener of listeners) listener();
}

/** Puts the catalog query back in flight, for a fresh mount. */
export function resetCatalog(): void {
  catalog = undefined;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Stands in for the catalog query inside `chat-welcome.browser.test.ts`'s fixture: in flight
 * until the test resolves it, then holding the Smart Model alone.
 * @toolContract
 */
export function useModels(): { data: ModelsData | undefined } {
  const data = React.useSyncExternalStore(subscribe, () => catalog);
  return { data };
}
