import { fixtureCatalog } from '../usage-fixture/usage-fixture';
import type { ModelsData } from '@/hooks/models/models';

/** The model names the fixture's page shows; served in place of the catalog query. */
export const FIXTURE_MODEL_NAMES: readonly (readonly [string, string])[] = Array.from(
  { length: 14 },
  (_, index) => [
    `fictional/model-${String(index)}`,
    `Fictional Reasoning Model ${String(index)} Extended`,
  ]
);

/**
 * The catalog query's result, read by the usage page's labels without a network. The browser
 * test's `resolve.alias` swaps this file in for the catalog module by path, so no module
 * imports it.
 * @toolContract
 */
export function useModels(): { data: ModelsData } {
  return fixtureCatalog(FIXTURE_MODEL_NAMES);
}
