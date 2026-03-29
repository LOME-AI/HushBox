import { describe, it, expect, beforeAll } from 'vitest';
import { createOpenRouterClient } from './openrouter.js';
import { getPaidTestModel, clearTestModelCache } from './test-utilities.js';
import type { OpenRouterClient } from './types.js';
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

  describe('getGenerationStats', () => {
    it('retrieves exact cost from /generation endpoint', async () => {
      // Make a real API call
      const response = await client.chatCompletion({
        model: paidModel,
        messages: [{ role: 'user', content: 'Say hello' }],
        max_tokens: 10,
      });

      // The response id is the generation id
      const generationId = response.id;
      expect(generationId).toBeDefined();

      const stats = await client.getGenerationStats(generationId);

      // Verify stats structure
      expect(stats.id).toBe(generationId);
      expect(stats.native_tokens_prompt).toBeGreaterThan(0);
      expect(stats.native_tokens_completion).toBeGreaterThan(0);
      expect(stats.total_cost).toBeGreaterThan(0);
    }, 60_000);

    it('calculates our charge as exactly 15% higher than OpenRouter cost', async () => {
      // Make a real API call
      const response = await client.chatCompletion({
        model: paidModel,
        messages: [{ role: 'user', content: 'Count to three' }],
        max_tokens: 20,
      });

      const stats = await client.getGenerationStats(response.id);

      // Calculate what we would charge the user
      const openRouterCost = stats.total_cost;
      const ourCharge = applyFees(openRouterCost);

      // Verify our fee is exactly 15%
      const expectedCharge = openRouterCost * (1 + TOTAL_FEE_RATE);
      expect(ourCharge).toBeCloseTo(expectedCharge, 10);

      // Verify we charge more than OpenRouter
      expect(ourCharge).toBeGreaterThan(openRouterCost);

      // Verify the ratio is exactly 1.15
      const ratio = ourCharge / openRouterCost;
      expect(ratio).toBeCloseTo(1.15, 10);

      console.log(`OpenRouter cost: $${openRouterCost.toFixed(10)}`);
      console.log(`Our charge: $${ourCharge.toFixed(10)}`);
      console.log(`Fee ratio: ${ratio.toFixed(4)}x (expected 1.15x)`);
    }, 60_000);

    it('returns native token counts (not normalized)', async () => {
      // Make a real API call
      const response = await client.chatCompletion({
        model: paidModel,
        messages: [{ role: 'user', content: 'Hello' }],
        max_tokens: 10,
      });

      const stats = await client.getGenerationStats(response.id);

      // Native tokens should be positive integers
      expect(Number.isInteger(stats.native_tokens_prompt)).toBe(true);
      expect(Number.isInteger(stats.native_tokens_completion)).toBe(true);
      expect(stats.native_tokens_prompt).toBeGreaterThan(0);
      expect(stats.native_tokens_completion).toBeGreaterThan(0);

      // The immediate response uses normalized tokens (GPT-4o tokenizer)
      // These may differ from native tokens
      console.log(
        `Normalized tokens (immediate): prompt=${String(response.usage.prompt_tokens)}, completion=${String(response.usage.completion_tokens)}`
      );
      console.log(
        `Native tokens (generation): prompt=${String(stats.native_tokens_prompt)}, completion=${String(stats.native_tokens_completion)}`
      );
    }, 60_000);
  });
});
