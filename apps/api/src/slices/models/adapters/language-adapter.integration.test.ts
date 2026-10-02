import { describe, expect, it } from 'vitest';
import {
  SHOULD_RUN,
  consume,
  finishMetadata,
  languageDescriptor,
  languageRequest,
  reasoningBudgetDescriptor,
  reasoningBudgetRequest,
  reasoningEffortDescriptor,
  reasoningEffortRequest,
  reasoningOffRequest,
  useIntegrationProvider,
} from './integration.setup.js';
import { createCassetteStore } from './cassette/cassette-store.js';
import { recordedStreamCostUsd } from './cassette/recorded-cost.js';
import { CASSETTE_ROOT } from './resolve-model-provider.js';
import type { InferenceEvent } from '@hushbox/shared';

const TEXT_TIMEOUT_MS = 30_000;
/** Reasoning turns generate thinking tokens ahead of the answer — slower. */
const REASONING_TIMEOUT_MS = 60_000;

function reasoningTextOf(events: readonly InferenceEvent[]): string {
  return events
    .filter((event) => event.kind === 'reasoning-delta')
    .map((event) => event.content)
    .join('');
}

function answerTextOf(events: readonly InferenceEvent[]): string {
  return events
    .filter((event) => event.kind === 'text-delta')
    .map((event) => event.content)
    .join('');
}

/**
 * Language inference through the {@link useIntegrationProvider} env
 * derivation: the deterministic mock locally, real OpenRouter with
 * record-on-miss cassettes in CI-vitest (where the factory's evidence wrapper
 * records `openrouter-inference` service-evidence on the first event, so
 * `verify:evidence --require=openrouter-inference` has a row to assert). The
 * assertions are provider-agnostic and run everywhere, except the one comparing
 * the billed cost against the recording that carried it, which has nothing to
 * read where no real response was recorded.
 */
describe('language adapter — provider inference', () => {
  const provider = useIntegrationProvider();

  it(
    'streams text content and a terminal finish carrying a generation id',
    { timeout: TEXT_TIMEOUT_MS },
    async () => {
      const events = await consume(provider().infer(languageRequest(), languageDescriptor()));

      const text = events
        .filter((event) => event.kind === 'text-delta')
        .map((event) => event.content)
        .join('');
      expect(text.length).toBeGreaterThan(0);

      const metadata = finishMetadata(events);
      expect(metadata.generationId).toBeDefined();
      expect(metadata.generationId?.length ?? 0).toBeGreaterThan(0);
      expect(metadata.usage.outputTokens).toBeGreaterThan(0);
    }
  );

  it(
    'streams reasoning deltas and bills reasoning tokens for an effort-native reasoning config',
    { timeout: REASONING_TIMEOUT_MS },
    async () => {
      const events = await consume(
        provider().infer(reasoningEffortRequest(), reasoningEffortDescriptor())
      );

      expect(reasoningTextOf(events).length).toBeGreaterThan(0);
      expect(answerTextOf(events).length).toBeGreaterThan(0);

      const metadata = finishMetadata(events);
      expect(metadata.usage.reasoningTokens ?? 0).toBeGreaterThan(0);
      expect(metadata.providerCostUsd ?? 0).toBeGreaterThan(0);
    }
  );

  it(
    'streams reasoning deltas and bills reasoning tokens for a budget-native reasoning config',
    { timeout: REASONING_TIMEOUT_MS },
    async () => {
      const events = await consume(
        provider().infer(reasoningBudgetRequest(), reasoningBudgetDescriptor())
      );

      expect(reasoningTextOf(events).length).toBeGreaterThan(0);
      expect(answerTextOf(events).length).toBeGreaterThan(0);

      const metadata = finishMetadata(events);
      expect(metadata.usage.reasoningTokens ?? 0).toBeGreaterThan(0);
      expect(metadata.providerCostUsd ?? 0).toBeGreaterThan(0);
    }
  );

  /**
   * What this system bills is what the provider sent. The comparison spans the
   * seam no other test crosses: the extractor reads the SDK's constructed
   * `providerMetadata`, the recording holds the bytes the provider sent, and
   * only the credentialled run has a recording — hence the gate, which is the
   * shared {@link SHOULD_RUN} the live catalog suite hangs its own skip on
   * (`apps/api/src/slices/models/domain/catalog/gateway-metadata.integration.test.ts`).
   *
   * Both halves are load-bearing. Defined is what fails when the metadata field
   * moves: the extractor yields `undefined`, settlement silently degrades to
   * the catalog estimate, and without this half a vanished field would compare
   * `undefined` to `undefined` and pass. Equality is what fails on a value that
   * is present but is not the charged cost.
   */
  it.skipIf(!SHOULD_RUN)(
    'bills exactly the inline cost the recorded provider response carried',
    { timeout: REASONING_TIMEOUT_MS },
    async () => {
      const events = await consume(
        provider().infer(reasoningEffortRequest(), reasoningEffortDescriptor())
      );

      const metadata = finishMetadata(events);
      const generationId = metadata.generationId;
      if (generationId === undefined) {
        throw new Error('expected a generation id to locate the recording by');
      }
      const recorded = await recordedStreamCostUsd(
        createCassetteStore({ rootDir: CASSETTE_ROOT }),
        generationId
      );

      expect(recorded).toBeDefined();
      expect(metadata.providerCostUsd).toBeDefined();
      expect(metadata.providerCostUsd).toBe(recorded);
    }
  );

  it(
    'suppresses reasoning under the explicit hard-off wire on a reasoning-capable model',
    { timeout: REASONING_TIMEOUT_MS },
    async () => {
      const events = await consume(
        provider().infer(reasoningOffRequest(), reasoningEffortDescriptor())
      );

      expect(reasoningTextOf(events)).toBe('');
      expect(answerTextOf(events).length).toBeGreaterThan(0);

      const metadata = finishMetadata(events);
      expect(metadata.usage.reasoningTokens ?? 0).toBe(0);
    }
  );
});
