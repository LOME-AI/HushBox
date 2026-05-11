import { fetchModels } from '@hushbox/shared/models';
import { createMockAIClient } from './mock.js';
import type { MockAIClient, MockAIClientConfig, RawModel } from './types.js';

interface GatewayCatalogOptions extends MockAIClientConfig {
  /**
   * AI Gateway API key forwarded to `fetchModels`. Tests that mock
   * `@ai-sdk/gateway` ignore the value, but the in-memory model cache is
   * keyed by it — pass a unique key per scenario to bypass cross-test cache
   * hits, or stay with the default to share the fixture catalog.
   */
  apiKey?: string;
  /**
   * Public `/v1/models` URL forwarded to `fetchModels`. Defaults to a
   * non-resolving fixture; tests that stub `globalThis.fetch` or
   * `vi.mock('@ai-sdk/gateway', ...)` don't depend on the value.
   */
  publicModelsUrl?: string;
}

const DEFAULT_API_KEY = 'test-key';
const DEFAULT_PUBLIC_MODELS_URL = 'https://test.example/v1/models';

/**
 * Test-only mock AIClient that keeps the deterministic stream / classifier
 * behavior of `createMockAIClient` but routes `listRawModels` through the
 * shared `fetchModels`. Test files that hoist a `vi.mock('@ai-sdk/gateway',
 * ...)` setup keep priming `__TEST_MOCK_MODELS__` / `getAvailableModels`
 * exactly as before — `fetchModels` consumes that stub, so the catalog the
 * route sees mirrors the per-test fixture rather than the mock client's
 * built-in `MOCK_RAW_MODELS`.
 *
 * Exists because the route migration moved every catalog read onto the
 * AIClient boundary; chat/billing/trial unit tests previously seeded model
 * data via the gateway mock and should keep working without rewriting each
 * fixture into RawModel shape.
 */
export function createMockAIClientWithGatewayCatalog(
  options: GatewayCatalogOptions = {}
): MockAIClient {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const publicModelsUrl = options.publicModelsUrl ?? DEFAULT_PUBLIC_MODELS_URL;
  const { apiKey: _a, publicModelsUrl: _p, ...mockConfig } = options;
  const base = createMockAIClient(mockConfig);
  return {
    ...base,
    listRawModels: (): Promise<RawModel[]> => fetchModels({ apiKey, publicModelsUrl }),
  };
}
