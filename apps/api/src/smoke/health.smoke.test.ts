import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import { ERROR_CODES } from '@hushbox/shared';
import { TEST_YEAR_START, freezeClock, isoAt } from '@hushbox/shared/test-time';
import { createErrorResponse } from '../lib/errors/index.js';
import { createSmokeHarness } from './harness.js';

describe('health smoke', () => {
  it('serves GET /health through the full pipeline via the typed client', async () => {
    freezeClock(TEST_YEAR_START);
    try {
      const { client } = createSmokeHarness();
      const res = await client.health.$get();
      expect(res.status).toBe(200);
      const body = await res.json();
      expectTypeOf(body).toEqualTypeOf<{ status: string; timestamp: string }>();
      expect(body).toEqual({ status: 'ok', timestamp: isoAt(TEST_YEAR_START) });
    } finally {
      vi.useRealTimers();
    }
  });

  it('answers an unmounted path with the uniform NOT_FOUND wire shape', async () => {
    const { app, env } = createSmokeHarness();
    const res = await app.request('/smoke-probe-no-such-route', {}, env);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(JSON.stringify(createErrorResponse(ERROR_CODES.NOT_FOUND)));
  });
});
