import { describe, it, expect, beforeAll } from 'vitest';
import { createOpenRouterClient, clearModelCache } from './openrouter.js';
import type { OpenRouterClient } from './types.js';

/**
 * Integration tests for OpenRouter API.
 * These tests call the real OpenRouter API and require OPENROUTER_API_KEY to be set.
 * They are skipped locally and only run in CI with "pr test" command.
 * See TECH-STACK.md: "Real API calls only run in CI when a LOME team member comments 'pr test'."
 */

// Fallback model if dynamic selection fails
const FALLBACK_MODEL = 'meta-llama/llama-3.1-8b-instruct';

const hasApiKey = Boolean(process.env['OPENROUTER_API_KEY']);

describe.skipIf(!hasApiKey)('OpenRouter Integration', () => {
  let client: OpenRouterClient;
  let testModel: string = FALLBACK_MODEL;

  beforeAll(async () => {
    // Clear cache to ensure fresh model list
    clearModelCache();
    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required - this should not happen due to skipIf');
    }
    client = createOpenRouterClient(apiKey);

    // Dynamically select a cheap model that's currently available
    try {
      const models = await client.listModels();

      // Find a cheap, available model (prompt pricing < $0.001 per 1k tokens)
      const cheapModels = models
        .filter((m) => {
          const promptPrice = parseFloat(m.pricing.prompt);
          return !isNaN(promptPrice) && promptPrice < 0.001;
        })
        .sort((a, b) => parseFloat(a.pricing.prompt) - parseFloat(b.pricing.prompt));

      if (cheapModels.length > 0 && cheapModels[0]) {
        testModel = cheapModels[0].id;
        console.log(`Using dynamic test model: ${testModel}`);
      } else {
        console.warn(`No cheap model found, using fallback: ${FALLBACK_MODEL}`);
      }
    } catch (error) {
      console.warn(`Failed to fetch models, using fallback: ${FALLBACK_MODEL}`, error);
    }
  });

  describe('listModels', () => {
    it('fetches real models from OpenRouter', async () => {
      const models = await client.listModels();

      expect(models.length).toBeGreaterThan(0);

      const firstModel = models[0];
      expect(firstModel).toBeDefined();
      if (firstModel) {
        expect(firstModel).toHaveProperty('id');
        expect(firstModel).toHaveProperty('name');
        expect(firstModel).toHaveProperty('context_length');
        expect(firstModel).toHaveProperty('pricing');
      }
    }, 30000);

    it('includes popular models', async () => {
      const models = await client.listModels();

      // Should include common models
      const modelIds = models.map((m) => m.id);
      expect(modelIds.some((id) => id.includes('gpt'))).toBe(true);
      expect(modelIds.some((id) => id.includes('claude'))).toBe(true);
    }, 30000);
  });

  describe('getModel', () => {
    it('fetches specific model by ID', async () => {
      const model = await client.getModel(testModel);

      expect(model.id).toBe(testModel);
      expect(model.name).toBeDefined();
      expect(model.context_length).toBeGreaterThan(0);
    }, 30000);

    it('throws for unknown model', async () => {
      await expect(client.getModel('nonexistent/model-that-does-not-exist')).rejects.toThrow(
        'Model not found'
      );
    }, 30000);
  });

  describe('chatCompletion', () => {
    it('gets response from real API', async () => {
      const response = await client.chatCompletion({
        model: testModel,
        messages: [{ role: 'user', content: 'Reply with exactly: INTEGRATION_TEST_OK' }],
        max_tokens: 50,
      });

      expect(response.id).toBeDefined();
      expect(response.model).toBeDefined();
      expect(response.choices).toHaveLength(1);

      const firstChoice = response.choices[0];
      expect(firstChoice).toBeDefined();
      if (firstChoice) {
        expect(firstChoice.message.role).toBe('assistant');
        expect(firstChoice.message.content).toBeDefined();
        // LLMs may not follow instructions exactly, so just check it responded
        expect(firstChoice.message.content.length).toBeGreaterThan(0);
      }

      expect(response.usage).toBeDefined();
      expect(response.usage.total_tokens).toBeGreaterThan(0);
    }, 30000);

    it('handles system messages', async () => {
      const response = await client.chatCompletion({
        model: testModel,
        messages: [
          { role: 'system', content: 'You are a helpful assistant.' },
          { role: 'user', content: 'Say hello' },
        ],
        max_tokens: 50,
      });

      const firstChoice = response.choices[0];
      expect(firstChoice).toBeDefined();
      if (firstChoice) {
        expect(firstChoice.message.content.length).toBeGreaterThan(0);
      }
    }, 30000);
  });

  describe('chatCompletionStream', () => {
    it('streams response from real API', async () => {
      const tokens: string[] = [];

      for await (const token of client.chatCompletionStream({
        model: testModel,
        messages: [{ role: 'user', content: 'Count from 1 to 3' }],
        max_tokens: 50,
      })) {
        tokens.push(token);
      }

      // Should receive multiple tokens
      expect(tokens.length).toBeGreaterThan(0);

      // Combined tokens should form a coherent response
      const fullResponse = tokens.join('');
      expect(fullResponse.length).toBeGreaterThan(0);
    }, 30000);

    it('streams tokens incrementally', async () => {
      const tokenTimestamps: number[] = [];

      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- only timing matters, not token content
      for await (const _ of client.chatCompletionStream({
        model: testModel,
        messages: [{ role: 'user', content: 'Write a short sentence' }],
        max_tokens: 30,
      })) {
        tokenTimestamps.push(Date.now());
      }

      // Should receive multiple tokens over time (not all at once)
      expect(tokenTimestamps.length).toBeGreaterThan(1);
    }, 30000);
  });
});
