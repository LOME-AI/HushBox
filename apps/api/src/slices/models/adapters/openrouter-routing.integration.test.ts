import { describe, expect, it } from 'vitest';
import { modelPriceDisplay } from '@hushbox/shared';
import { billableRatesToMaxPrice } from '../../billing/public/routing-cap.js';
import { buildModelsListResponse } from '../domain/catalog/list-models.js';
import { InferenceError } from './inference-error.js';
import {
  ROUTING_CATALOG_NOW_MS,
  ROUTING_SUBJECTS,
  SHOULD_RUN,
  cheapestServingEndpoints,
  consume,
  finishMetadata,
  routingRequest,
  useIntegrationProvider,
  useRoutingCatalog,
} from './integration.setup.js';
import type { MaxPrice, ModelDescriptor, ProviderMetadata } from '@hushbox/shared';

const ROUTING_TIMEOUT_MS = 60_000;

/** What a leg records when no exposed model carries the behaviour it proves. */
const NO_SUBJECT = 'no subject: no exposed model satisfies this proof’s predicate';

/** The cap the gateway compares an endpoint's listed price with: the anchor's own rates, un-baked. */
function anchorMaxPrice(subject: ModelDescriptor): MaxPrice {
  const row = buildModelsListResponse([subject], ROUTING_CATALOG_NOW_MS).response.models.find(
    (model) => model.id === subject.id
  );
  const display = row === undefined ? undefined : modelPriceDisplay(row);
  if (display?.inputNanoUsd === undefined || display.outputNanoUsd === undefined) {
    throw new Error(`the catalog serves no token price for ${subject.id}`);
  }
  return billableRatesToMaxPrice({ input: display.inputNanoUsd, output: display.outputNanoUsd });
}

/** A cap below every endpoint's price: one nano-USD a token on each rate, un-baked. */
const BELOW_EVERY_ENDPOINT = billableRatesToMaxPrice({ input: 1n, output: 1n });

function expectServedAndBilled(metadata: ProviderMetadata): void {
  expect(metadata.servedBy?.length ?? 0).toBeGreaterThan(0);
  expect(Number.isFinite(metadata.providerCostUsd)).toBe(true);
  expect(metadata.providerCostUsd ?? 0).toBeGreaterThan(0);
}

/**
 * The vendor facts the routing design rests on, proven through the
 * {@link useIntegrationProvider} derivation: the mock locally, which answers
 * `max_price` the way the gateway documents, and the real gateway over
 * record-on-miss cassettes in CI. Each subject is derived from the catalog the
 * suite normalizes at run time — the recorded live listing in CI, the fixture
 * listing locally — so no proof names a model. A refusal is a 4xx, which the
 * cassette never records, so the refusal legs reach the vendor on every CI run.
 */
describe('OpenRouter routing — max_price and cheapest-first', () => {
  const provider = useIntegrationProvider();
  const catalog = useRoutingCatalog();

  it(
    'serves a call at its derived ceiling',
    { timeout: ROUTING_TIMEOUT_MS },
    async ({ annotate }) => {
      const subject = ROUTING_SUBJECTS.ceiling(await catalog());
      if (subject === undefined) {
        await annotate(NO_SUBJECT);
        return;
      }

      const events = await consume(provider().infer(routingRequest(subject), subject));

      expectServedAndBilled(finishMetadata(events));
    }
  );

  it(
    'serves a call capped at the anchor’s own rates',
    { timeout: ROUTING_TIMEOUT_MS },
    async ({ annotate }) => {
      const subject = ROUTING_SUBJECTS.ceiling(await catalog());
      if (subject === undefined) {
        await annotate(NO_SUBJECT);
        return;
      }

      const events = await consume(
        provider().infer(routingRequest(subject, anchorMaxPrice(subject)), subject)
      );

      expectServedAndBilled(finishMetadata(events));
    }
  );

  it(
    'refuses a call capped below every endpoint as no_providers_available',
    { timeout: ROUTING_TIMEOUT_MS },
    async ({ annotate }) => {
      const subject = ROUTING_SUBJECTS.ceiling(await catalog());
      if (subject === undefined) {
        await annotate(NO_SUBJECT);
        return;
      }

      const refusal = consume(
        provider().infer(routingRequest(subject, BELOW_EVERY_ENDPOINT), subject)
      );

      await expect(refusal).rejects.toBeInstanceOf(InferenceError);
      await expect(refusal).rejects.toMatchObject({ code: 'no_providers_available' });
    }
  );

  /**
   * Real only: the mock names one endpoint for every call, so only the gateway
   * can show which endpoint a cheapest-first route served from.
   */
  it.skipIf(!SHOULD_RUN)(
    'serves from the cheapest endpoint the listing names, at that endpoint’s rates',
    { timeout: ROUTING_TIMEOUT_MS },
    async ({ annotate }) => {
      const routing = await catalog();
      const subject = ROUTING_SUBJECTS.sortCheapest(routing);
      if (subject === undefined) {
        await annotate(NO_SUBJECT);
        return;
      }
      const cheapest = cheapestServingEndpoints(routing, subject);

      const metadata = finishMetadata(
        await consume(provider().infer(routingRequest(subject), subject))
      );

      expectServedAndBilled(metadata);
      expect(cheapest.map((endpoint) => endpoint.providerName)).toContain(metadata.servedBy);
      const served = cheapest.find((endpoint) => endpoint.providerName === metadata.servedBy);
      if (served === undefined) throw new Error('the serving endpoint is not among the cheapest');
      const listedCostUsd =
        metadata.usage.inputTokens * Number(served.prompt) +
        metadata.usage.outputTokens * Number(served.completion);
      expect(Math.abs((metadata.providerCostUsd ?? 0) - listedCostUsd)).toBeLessThanOrEqual(
        listedCostUsd / 100
      );
    }
  );
});
