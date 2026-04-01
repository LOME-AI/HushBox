import { describe, it, expect, beforeAll } from 'vitest';
import { createDb, LOCAL_NEON_DEV_CONFIG, type Database } from '@hushbox/db';
import { createEnvUtilities } from '@hushbox/shared';
import { createOpenRouterClient, type EvidenceConfig } from './openrouter.js';
import { createFastMockOpenRouterClient } from '../../test-helpers/openrouter-mocks.js';
import type { OpenRouterClient, StreamToken } from './types.js';
import { retryWithBackoff, isProviderError } from './retry.js';

/**
 * Integration tests for OpenRouter auto-router (`openrouter/auto`).
 *
 * - Local dev: Tests run with mock client (no API key needed)
 * - CI: Tests run with real API (OPENROUTER_API_KEY required)
 */

const AUTO_ROUTER_MODEL = 'openrouter/auto';

const env = createEnvUtilities({
  ...(process.env['NODE_ENV'] && { NODE_ENV: process.env['NODE_ENV'] }),
  ...(process.env['CI'] && { CI: process.env['CI'] }),
});

const hasApiKey = Boolean(process.env['OPENROUTER_API_KEY']);
const DATABASE_URL = process.env['DATABASE_URL'];

if (env.isCI && !hasApiKey) {
  throw new Error(
    'OPENROUTER_API_KEY is required in CI. Ensure the secret is set in GitHub Actions.'
  );
}

if (env.isCI && !DATABASE_URL) {
  throw new Error('DATABASE_URL is required in CI for evidence recording.');
}

describe('Auto-Router Integration', () => {
  let client: OpenRouterClient;
  let db: Database | null = null;
  let evidenceConfig: EvidenceConfig | undefined;

  beforeAll(() => {
    if (env.isLocalDev) {
      client = createFastMockOpenRouterClient({
        streamContent: 'AUTO_ROUTER_TEST_OK',
        generationId: 'gen-auto-router-test',
      });
      console.log('Using mock OpenRouter client for local development');
      return;
    }

    const apiKey = process.env['OPENROUTER_API_KEY'];
    if (!apiKey) {
      throw new Error('OPENROUTER_API_KEY is required in CI/production');
    }

    if (DATABASE_URL) {
      db = createDb({
        connectionString: DATABASE_URL,
        neonDev: LOCAL_NEON_DEV_CONFIG,
      });
      evidenceConfig = { db, isCI: env.isCI };
    }

    client = createOpenRouterClient(apiKey, evidenceConfig);
  });

  it('routes to a real model and returns content', async () => {
    const response = await retryWithBackoff(
      () =>
        client.chatCompletion({
          model: AUTO_ROUTER_MODEL,
          messages: [{ role: 'user', content: 'Reply with exactly: AUTO_ROUTER_TEST_OK' }],
          max_tokens: 50,
        }),
      { shouldRetry: isProviderError }
    );

    expect(response.id).toBeDefined();
    // Auto-router should report which model actually handled the request
    expect(response.model).toBeDefined();
    expect(response.model.length).toBeGreaterThan(0);

    expect(response.choices).toHaveLength(1);
    const firstChoice = response.choices[0];
    expect(firstChoice).toBeDefined();
    if (firstChoice) {
      expect(firstChoice.message.content.length).toBeGreaterThan(0);
    }

    expect(response.usage.total_tokens).toBeGreaterThan(0);
  }, 30_000);

  it('respects allowed_models plugin to restrict routing', async () => {
    const response = await retryWithBackoff(
      () =>
        client.chatCompletion({
          model: AUTO_ROUTER_MODEL,
          messages: [{ role: 'user', content: 'Say hello' }],
          max_tokens: 50,
          plugins: [{ id: 'auto-router', allowed_models: ['anthropic/*'] }],
        }),
      { shouldRetry: isProviderError }
    );

    expect(response.model).toBeDefined();

    // In CI, verify the routed model is from Anthropic
    // In local dev, mock doesn't enforce this constraint
    if (!client.isMock) {
      expect(response.model).toMatch(/^anthropic\//);
    }

    expect(response.choices).toHaveLength(1);
  }, 30_000);

  it('streams tokens with generation ID via chatCompletionStreamWithMetadata', async () => {
    const { tokens, generationId } = await retryWithBackoff(
      async () => {
        const collected: string[] = [];
        let genId: string | undefined;

        for await (const token of client.chatCompletionStreamWithMetadata({
          model: AUTO_ROUTER_MODEL,
          messages: [{ role: 'user', content: 'Count from 1 to 3' }],
          max_tokens: 50,
        })) {
          collected.push(token.content);
          if (token.generationId) {
            genId = token.generationId;
          }
        }

        return { tokens: collected, generationId: genId };
      },
      { shouldRetry: isProviderError }
    );

    expect(tokens.length).toBeGreaterThan(0);
    expect(generationId).toBeDefined();
    expect(generationId!.length).toBeGreaterThan(0);
  }, 30_000);

  it('yields inlineCost > 0 on the final token', async () => {
    const { tokens } = await retryWithBackoff(
      async () => {
        const collected: StreamToken[] = [];

        for await (const token of client.chatCompletionStreamWithMetadata({
          model: AUTO_ROUTER_MODEL,
          messages: [{ role: 'user', content: 'Say one word' }],
          max_tokens: 10,
        })) {
          collected.push(token);
        }

        return { tokens: collected };
      },
      { shouldRetry: isProviderError }
    );

    expect(tokens.length).toBeGreaterThanOrEqual(2);

    const lastToken = tokens.at(-1);
    expect(lastToken).toBeDefined();
    expect(lastToken!.content).toBe('');
    expect(lastToken!.inlineCost).toBeGreaterThan(0);
  }, 60_000);

  it('works with ZDR provider enforcement', async () => {
    // The client already sends ZDR headers on every request.
    // This test verifies auto-router doesn't fail when ZDR is enforced.
    const response = await retryWithBackoff(
      () =>
        client.chatCompletion({
          model: AUTO_ROUTER_MODEL,
          messages: [{ role: 'user', content: 'Reply with OK' }],
          max_tokens: 10,
        }),
      { shouldRetry: isProviderError }
    );

    expect(response.choices).toHaveLength(1);
    const firstChoice = response.choices[0];
    expect(firstChoice).toBeDefined();
    if (firstChoice) {
      expect(firstChoice.message.content.length).toBeGreaterThan(0);
    }
  }, 30_000);
});
