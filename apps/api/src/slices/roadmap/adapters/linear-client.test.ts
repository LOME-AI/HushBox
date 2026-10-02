import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvUtilities } from '@hushbox/shared';
import { getLinearClient } from './linear-client.js';
import { MOCK_PROJECTS } from './mock-roadmap-fixture.js';

const localDev = createEnvUtilities({ NODE_ENV: 'development' });
const e2e = createEnvUtilities({ NODE_ENV: 'development', E2E: 'true' });
const production = createEnvUtilities({ NODE_ENV: 'production' });

describe('getLinearClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the mock client in local dev (no key needed)', async () => {
    const client = getLinearClient({}, localDev);
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toBe(MOCK_PROJECTS);
  });

  it('returns the mock client in E2E', async () => {
    const client = getLinearClient({}, e2e);
    const data = await client.fetchRoadmap('HUS');
    expect(data.projects).toBe(MOCK_PROJECTS);
  });

  it('fails fast outside dev/E2E when LINEAR_API_KEY_READ is missing', () => {
    expect(() => getLinearClient({}, production)).toThrow(/LINEAR_API_KEY_READ/);
    expect(() => getLinearClient({ LINEAR_API_KEY_READ: '' }, production)).toThrow(
      /LINEAR_API_KEY_READ/
    );
  });

  it('returns the real client outside dev/E2E when the key is present', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('nope', { status: 500 }));
    const client = getLinearClient({ LINEAR_API_KEY_READ: 'lin_api_test' }, production);
    await expect(client.fetchRoadmap('HUS')).rejects.toThrow();
    // The mock client answers from the committed fixture and never reaches the
    // network; only the real one posts to Linear, carrying the key it was built
    // from.
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.linear.app/graphql',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'lin_api_test' }),
      })
    );
  });
});
