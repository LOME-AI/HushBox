import { describe, it, expect } from 'vitest';
import { requireGatewayConfig } from './gateway-config.js';
import type { Bindings } from '../types.js';

describe('requireGatewayConfig', () => {
  it('returns apiKey and publicModelsUrl when both are present', () => {
    const env = {
      AI_GATEWAY_API_KEY: 'test-api-key',
      PUBLIC_MODELS_URL: 'https://example.com/models',
    } as unknown as Bindings;

    const result = requireGatewayConfig(env);

    expect(result.apiKey).toBe('test-api-key');
    expect(result.publicModelsUrl).toBe('https://example.com/models');
  });

  it('throws when AI_GATEWAY_API_KEY is missing', () => {
    const env = {
      PUBLIC_MODELS_URL: 'https://example.com/models',
    } as unknown as Bindings;

    expect(() => requireGatewayConfig(env)).toThrow(/AI_GATEWAY_API_KEY required/);
  });

  it('throws when PUBLIC_MODELS_URL is missing', () => {
    const env = {
      AI_GATEWAY_API_KEY: 'test-api-key',
    } as unknown as Bindings;

    expect(() => requireGatewayConfig(env)).toThrow(/PUBLIC_MODELS_URL required/);
  });

  it('throws when both are missing', () => {
    const env = {} as unknown as Bindings;

    expect(() => requireGatewayConfig(env)).toThrow(/AI_GATEWAY_API_KEY required/);
  });
});
