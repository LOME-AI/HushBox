import { fixtureCatalog } from '../usage-fixture/usage-fixture';
import type { ModelsData } from '@/hooks/models/models';

/** The catalog names the fixture's page shows; one model is left out so it reads by its id. */
const FIXTURE_MODEL_NAMES: readonly (readonly [string, string])[] = [
  ['fictional/opus', 'Fictional Opus 4.6'],
  ['fictional/sonnet', 'Fictional Sonnet 4.5'],
  ['fictional/nano-30b', 'Fictional Nemotron 3 Nano 30B A3B'],
  ['fictional/mini', 'Fictional Mini'],
  ['fictional/flash', 'Fictional MiMo-V2.6-Flash'],
  ['fictional/ministral', 'Fictional Ministral 3 3B 2512'],
];

/**
 * The catalog query's result, read by the usage page's labels without a network. The browser
 * test's `resolve.alias` swaps this file in for the catalog module by path, so no module
 * imports it.
 * @toolContract
 */
export function useModels(): { data: ModelsData } {
  return fixtureCatalog(FIXTURE_MODEL_NAMES);
}
