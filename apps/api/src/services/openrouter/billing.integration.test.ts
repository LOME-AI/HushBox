import { describe, it, expect, beforeAll } from 'vitest';
import { createOpenRouterClient } from './openrouter.js';
import { getPaidTestModel, clearTestModelCache } from './test-utilities.js';
import type { OpenRouterClient, StreamToken } from './types.js';
import { applyFees, TOTAL_FEE_RATE } from '@hushbox/shared';

/**
 * Billing integration tests for OpenRouter API.
 * These tests verify that we can retrieve exact costs from OpenRouter's /generation endpoint
 * and apply our 15% fee correctly.
 *
 * - Local dev: Tests skip gracefully (no API key needed)
 * - CI: Tests fail if API key is missing (ensures real API calls are tested)
 */

const hasApiKey = Boolean(process.env['OPENROUTER_API_KEY']);
const isCI = Boolean(process.env['CI']);

if (isCI && !hasApiKey) {
  throw new Error(
    'OPENROUTER_API_KEY is required in CI. Ensure the secret is set in GitHub Actions.'
  );
}

describe.skipIf(!hasApiKey)('Billing Integration', () => {
  let client: OpenRouterClient;
  let paidModel: string;

  beforeAll(async () => {
    clearTestModelCache();

    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required - this should not happen due to skipIf');
    }
    client = createOpenRouterClient(apiKey);

    // Get a cheap paid model for testing
    paidModel = await getPaidTestModel(client);
    console.log(`Using paid test model: ${paidModel}`);
  }, 30_000);

  describe('streaming cost', () => {
    it('yields inlineCost > 0 on the final token of a streaming request', async () => {
      const tokens: StreamToken[] = [];

      for await (const token of client.chatCompletionStreamWithMetadata({
        model: paidModel,
        messages: [{ role: 'user', content: 'Say hello' }],
        max_tokens: 10,
      })) {
        tokens.push(token);
      }

      expect(tokens.length).toBeGreaterThanOrEqual(2);

      const lastToken = tokens.at(-1);
      expect(lastToken).toBeDefined();
      expect(lastToken!.content).toBe('');
      expect(lastToken!.inlineCost).toBeGreaterThan(0);
      expect(lastToken!.inlineCost).toBeLessThan(0.01); // sanity: should be well under a cent
    }, 60_000);

    it('calculates fee ratio of ~1.15 from inlineCost', async () => {
      const tokens: StreamToken[] = [];

      for await (const token of client.chatCompletionStreamWithMetadata({
        model: paidModel,
        messages: [{ role: 'user', content: 'Count to three' }],
        max_tokens: 20,
      })) {
        tokens.push(token);
      }

      const lastToken = tokens.at(-1);
      expect(lastToken).toBeDefined();
      const openRouterCost = lastToken!.inlineCost!;
      expect(openRouterCost).toBeGreaterThan(0);

      const ourCharge = applyFees(openRouterCost);

      // Verify our fee is exactly 15%
      const expectedCharge = openRouterCost * (1 + TOTAL_FEE_RATE);
      expect(ourCharge).toBeCloseTo(expectedCharge, 10);

      // Verify the ratio is exactly 1.15
      const ratio = ourCharge / openRouterCost;
      expect(ratio).toBeCloseTo(1.15, 10);

      console.log(`OpenRouter cost: $${openRouterCost.toFixed(10)}`);
      console.log(`Our charge: $${ourCharge.toFixed(10)}`);
      console.log(`Fee ratio: ${ratio.toFixed(4)}x (expected 1.15x)`);
    }, 60_000);
  });
});
