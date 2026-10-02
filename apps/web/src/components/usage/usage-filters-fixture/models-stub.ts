import type { ModelsData } from '@/hooks/models/models';

/**
 * The catalog query before it answers, served without a network: options read as model ids.
 * The browser test's `resolve.alias` swaps this file in for the catalog module by path, so no
 * module imports it.
 * @toolContract
 */
export function useModels(): { data: ModelsData | undefined } {
  return { data: undefined };
}
