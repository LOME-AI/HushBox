import { requireEnv } from './env.js';
import { expectOkResponse } from './ok-response.js';
import { withRequestRetry } from './resilient-request.js';
import type { ModelsListResponse } from '@hushbox/shared';
import type { APIRequestContext } from '@playwright/test';

const API_BASE = requireEnv('VITE_API_URL');

/** The identity a spec needs to select a catalog row and read its nametag back. */
interface CatalogModelRef {
  readonly id: string;
  readonly name: string;
}

async function readCatalog(request: APIRequestContext): Promise<ModelsListResponse> {
  const response = await withRequestRetry(request).get(`${API_BASE}/models`);
  await expectOkResponse(response, 'catalog read');
  return (await response.json()) as ModelsListResponse;
}

/**
 * A text model the served catalog carries NO `reasoning` metadata for — the
 * ladderless model the effort story is about. Discovered rather than pinned to an
 * id: the catalog is the live OpenRouter snapshot, `E2E_MODELS` pins only
 * reasoning-capable text ids, and adding a ladderless id there would put a second
 * catalog contract under the refresh-time assertion for one spec's benefit.
 *
 * Premium rows are excluded so the pick stays reachable on a seeded wallet, and
 * the most popular remaining row is taken so repeated runs against one catalog
 * snapshot choose the same model.
 */
/** Unranked rows sort last; the catalog leaves `popularityRank` off media and unranked models. */
function rankOf(rank: number | undefined): number {
  return rank ?? Number.MAX_SAFE_INTEGER;
}

export async function findLadderlessTextModel(
  request: APIRequestContext
): Promise<CatalogModelRef> {
  const { models, premiumModelIds } = await readCatalog(request);
  const premium = new Set(premiumModelIds);
  const chosen = models
    .filter(
      (model) =>
        model.modality === 'text' && model.reasoning === undefined && !premium.has(model.id)
    )
    .toSorted((left, right) => rankOf(left.popularityRank) - rankOf(right.popularityRank))[0];
  if (chosen === undefined) {
    throw new Error('no non-premium text model without reasoning metadata in the served catalog');
  }
  return { id: chosen.id, name: chosen.name };
}
