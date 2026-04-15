import { describe, it, expect } from 'vitest';
import { getAIClient } from './index.js';

describe('getAIClient', () => {
  it('returns a mock client in local development', () => {
    const client = getAIClient({ NODE_ENV: 'development' });
    expect(client.isMock).toBe(true);
  });

  it('returns a mock client in test mode', () => {
    const client = getAIClient({ NODE_ENV: 'test' });
    expect(client.isMock).toBe(true);
  });

  it('returns a mock client in E2E mode', () => {
    const client = getAIClient({ NODE_ENV: 'development', E2E: 'true' });
    expect(client.isMock).toBe(true);
  });

  it('throws if AI_GATEWAY_API_KEY is missing in production', () => {
    expect(() => getAIClient({ NODE_ENV: 'production' })).toThrow('AI_GATEWAY_API_KEY required');
  });

  it('throws if AI_GATEWAY_API_KEY is missing in CI', () => {
    expect(() => getAIClient({ NODE_ENV: 'development', CI: 'true' })).toThrow(
      'AI_GATEWAY_API_KEY required'
    );
  });

  it('returns a mock client even when API key is present in local dev', () => {
    const client = getAIClient({
      NODE_ENV: 'development',
      AI_GATEWAY_API_KEY: 'test-key',
    });
    expect(client.isMock).toBe(true);
  });

  it('returns a real client in CI when API key is provided', () => {
    const client = getAIClient({
      NODE_ENV: 'development',
      CI: 'true',
      AI_GATEWAY_API_KEY: 'test-key',
    });
    expect(client.isMock).toBe(false);
  });
});
