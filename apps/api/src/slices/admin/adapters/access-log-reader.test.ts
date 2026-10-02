import { describe, expect, it, vi } from 'vitest';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { createAccessLogReaderFromEnv } from './access-log-reader.js';

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);

describe('createAccessLogReaderFromEnv', () => {
  it('binds the fake reader (no events, no network) outside production', async () => {
    const reader = createAccessLogReaderFromEnv({ NODE_ENV: 'development' });
    await expect(reader.listEvents({ since: new Date(0), until: NOW })).resolves.toEqual({
      events: [],
      pageLimitReached: false,
    });
  });

  it('fails fast in production when the API token is missing', () => {
    expect(() => createAccessLogReaderFromEnv({ NODE_ENV: 'production' })).toThrow(
      'CLOUDFLARE_ACCESS_LOG_API_TOKEN'
    );
  });

  it('fails fast in production when the Cloudflare account id is missing', () => {
    expect(() =>
      createAccessLogReaderFromEnv({
        NODE_ENV: 'production',
        CLOUDFLARE_ACCESS_LOG_API_TOKEN: 'real-token',
      })
    ).toThrow('CLOUDFLARE_ACCOUNT_ID');
  });

  it('binds the real Cloudflare reader in production when token and account id are set', async () => {
    const requested: string[] = [];
    const stubFetch: typeof globalThis.fetch = (input) => {
      requested.push(input instanceof Request ? input.url : String(input));
      return Promise.resolve(Response.json({ success: true, result: [] }));
    };
    vi.stubGlobal('fetch', stubFetch);
    try {
      const reader = createAccessLogReaderFromEnv({
        NODE_ENV: 'production',
        CLOUDFLARE_ACCESS_LOG_API_TOKEN: 'real-token',
        CLOUDFLARE_ACCOUNT_ID: 'real-account-id',
      });
      await expect(reader.listEvents({ since: new Date(0), until: NOW })).resolves.toEqual({
        events: [],
        pageLimitReached: false,
      });
      expect(requested[0]).toContain('/accounts/real-account-id/access/logs/access_requests');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
