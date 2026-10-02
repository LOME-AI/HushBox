import { modelsListResponseSchema } from '@hushbox/shared';
import { calculateMonthlyCost } from '../../lib/calculate-cost';
import { catalogModels } from '../../lib/catalog-models';
import { extractProviders } from '../../lib/extract-providers';
import { usePublicQuery } from '../../lib/use-public-query';

export type WelcomeCatalog =
  | { status: 'loading' }
  | { status: 'unavailable' }
  | { status: 'ready'; monthlyCost: number; modelCount: number; providers: string[] };

/**
 * The cost section's figures, read once per page from the live catalog and shared by its islands,
 * so the figures and the provider strip settle on the same answer. A catalog that prices no text
 * model is unavailable: the section never shows a count beside a missing price.
 */
export function useWelcomeCatalog(): WelcomeCatalog {
  const { data, isLoading } = usePublicQuery('/models', modelsListResponseSchema, 'catalog');
  if (isLoading) return { status: 'loading' };
  if (data === null) return { status: 'unavailable' };
  const models = catalogModels(data.models);
  const { monthlyCost } = calculateMonthlyCost(models);
  if (monthlyCost <= 0) return { status: 'unavailable' };
  return {
    status: 'ready',
    monthlyCost,
    modelCount: models.length,
    providers: extractProviders(models),
  };
}
