/**
 * Catalog admission composed with the classifier engine. Each half is pinned on
 * its own — admission excludes a zero-priced row (`normalize.test.ts`), and the
 * engine is the cheapest member of whatever pool it is handed
 * (`classifier-engine.test.ts`) — but the property the classifier reserve rests
 * on lives only in their composition: the pool the engine ranks is the ADMITTED
 * catalog, so a free model can never become the engine and collapse the reserve
 * to zero. The money layer imposes no floor of its own (a declared-zero rate is
 * a price, not an absence — `pool-projection.test.ts`), which is what makes
 * admission the only thing standing between the classifier and a free engine.
 */

import { describe, expect, it } from 'vitest';

import { ModelDescriptor, classifierEngineOf, modelId } from '@hushbox/shared';
import { DAY_MS, secondsAt } from '@hushbox/shared/test-time';

import { normalizeCatalog } from './catalog/normalize.js';
import { smartModelPool } from './smart-model/candidates.js';

import type { LanguageMetadata } from './catalog/gateway-metadata.js';

/** The refresh clock the fixtures are dated against. */
const NOW_MS = Date.UTC(2024, 0, 1);

/**
 * Every fixture's release date, derived from {@link NOW_MS} so the two cannot
 * drift apart: seven weeks back keeps each row inside the catalog's model-age
 * cutoff, and a row dated past it would be excluded before the engine ever
 * ranked the pool this file is about.
 */
const FIXTURE_RELEASE_SECONDS = secondsAt(NOW_MS - 48 * DAY_MS);

function languageModel(id: string, prompt: string, completion: string): LanguageMetadata {
  return {
    source: 'language',
    id,
    provider: 'vendor',
    inputModalities: ['text'],
    outputModalities: ['text'],
    supportedParameters: ['temperature', 'max_tokens'],
    contextLength: 128_000,
    pricing: { prompt, completion },
    releasedAt: FIXTURE_RELEASE_SECONDS,
    deprecated: false,
  };
}

/** Free at the gateway, and the cheapest row in the fixture by a wide margin. */
const FREE = languageModel('vendor/free', '0', '0');
/** Exactly at the price floor: the cheapest row admission actually admits. */
const AT_FLOOR = languageModel('vendor/at-floor', '0.0000001', '0.0000001');
const DEARER = languageModel('vendor/dearer', '0.0000025', '0.00001');

function admittedDescriptors(models: readonly LanguageMetadata[]): readonly ModelDescriptor[] {
  const zdr = new Set(models.map((model) => model.id));
  return normalizeCatalog([...models], zdr, NOW_MS).flatMap((entry) =>
    entry.kind === 'normalized' ? [ModelDescriptor.parse({ ...entry.content, fetchedAt: 0 })] : []
  );
}

describe('the classifier engine over an admitted catalog', () => {
  it('never resolves to a model the gateway prices at zero', () => {
    // Every fixture shares one context length, so the top-context exemption
    // covers the whole pool and the price floor is bypassed — the zero-price
    // rule is ordered ahead of it and admits no exemption, which is the only
    // reason the free row is absent from the pool the engine ranks.
    const engine = classifierEngineOf(
      smartModelPool(admittedDescriptors([FREE, AT_FLOOR, DEARER]))
    );

    expect(engine?.modelId).toBe(modelId('vendor/at-floor'));
  });
});
