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
      PUBLIC_MODELS_URL: 'https://test.example/v1/models',
    });
    expect(client.isMock).toBe(false);
  });

  it('throws if PUBLIC_MODELS_URL is missing in production', () => {
    expect(() => getAIClient({ NODE_ENV: 'production', AI_GATEWAY_API_KEY: 'test-key' })).toThrow(
      'PUBLIC_MODELS_URL required'
    );
  });

  it('returns a fresh mock instance on every call (no module-level cache)', () => {
    // Mock state is per-request: every aiClientMiddleware invocation builds
    // a new mock from request headers, so there is no cross-request bleed.
    const first = getAIClient({ NODE_ENV: 'development' });
    const second = getAIClient({ NODE_ENV: 'development' });
    expect(first).not.toBe(second);
  });

  it('threads mockConfig into the mock — classifierResolution drives the classifier output', async () => {
    const client = getAIClient(
      { NODE_ENV: 'development' },
      { mockConfig: { classifierResolution: 'anthropic/claude-opus-4.6' } }
    );
    expect(client.isMock).toBe(true);
    const { CLASSIFIER_SYSTEM_PROMPT_MARKER } = await import('@hushbox/shared');
    const events: unknown[] = [];
    for await (const event of client.stream({
      modality: 'text',
      model: 'cheap/c',
      messages: [
        { role: 'system', content: `${CLASSIFIER_SYSTEM_PROMPT_MARKER}\nPick.\n- a/x\n- b/y` },
        { role: 'user', content: '[USER START]: hi' },
      ],
    })) {
      events.push(event);
    }
    const text = events
      .filter(
        (e): e is { kind: 'text-delta'; content: string } =>
          typeof (e as { kind?: unknown }).kind === 'string' &&
          (e as { kind: string }).kind === 'text-delta'
      )
      .map((e) => e.content)
      .join('');
    expect(text).toBe('anthropic/claude-opus-4.6');
  });
});
