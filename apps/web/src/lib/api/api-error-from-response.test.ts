import { describe, it, expect, beforeEach } from 'vitest';
import { useAppVersionStore } from '@/stores/app-version';
import { ApiError } from './api.js';
import { apiErrorFromResponse } from './api-error-from-response.js';
import { markRequestKeyed } from './idempotent-mutation.js';

describe('apiErrorFromResponse', () => {
  beforeEach(() => {
    useAppVersionStore.setState({ upgradeRequired: false, currentVersion: null, updateUrl: null });
  });

  it('builds an ApiError carrying the status and the parsed body', async () => {
    const body = { code: 'FORBIDDEN', details: { reason: 'not-a-member' } };

    const error = await apiErrorFromResponse(Response.json(body, { status: 403 }));

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: 'FORBIDDEN', status: 403, data: body });
  });

  it('names a body with no string code INTERNAL', async () => {
    const error = await apiErrorFromResponse(Response.json({ code: 42 }, { status: 500 }));

    expect(error.message).toBe('INTERNAL');
  });

  it('names an unparseable body INTERNAL and keeps no data', async () => {
    const error = await apiErrorFromResponse(new Response('gateway exploded', { status: 502 }));

    expect(error).toMatchObject({ message: 'INTERNAL', status: 502, data: undefined });
  });

  it('carries the Retry-After delay in milliseconds', async () => {
    const response = Response.json(
      { code: 'RATE_LIMITED' },
      { status: 429, headers: { 'Retry-After': '2' } }
    );

    const error = await apiErrorFromResponse(response);

    expect(error.retryAfterMs).toBe(2000);
  });

  it('carries no Retry-After delay when the response names none', async () => {
    const error = await apiErrorFromResponse(
      Response.json({ code: 'UNAVAILABLE' }, { status: 503 })
    );

    expect(error.retryAfterMs).toBeUndefined();
  });

  it('records that the request carried an Idempotency-Key when the fetch wrapper marked it', async () => {
    const response = markRequestKeyed(
      Response.json({ code: 'UNAVAILABLE' }, { status: 503 }),
      true
    );

    const error = await apiErrorFromResponse(response);

    expect(error.carriedIdempotencyKey).toBe(true);
  });

  it('records no Idempotency-Key for a response the fetch wrapper did not mark', async () => {
    const error = await apiErrorFromResponse(
      Response.json({ code: 'UNAVAILABLE' }, { status: 503 })
    );

    expect(error.carriedIdempotencyKey).toBe(false);
  });

  it('raises the upgrade-required flag with the versions a 426 body names', async () => {
    const body = {
      code: 'VERSION_MISMATCH',
      details: { currentVersion: 'srv-9', updateUrl: '/updates/download/ios/srv-9' },
    };

    await apiErrorFromResponse(Response.json(body, { status: 426 }));

    expect(useAppVersionStore.getState()).toMatchObject({
      upgradeRequired: true,
      currentVersion: 'srv-9',
      updateUrl: '/updates/download/ios/srv-9',
    });
  });

  it('nulls a version field a 426 body leaves out or gives a non-string', async () => {
    const body = { code: 'VERSION_MISMATCH', details: { currentVersion: 7 } };

    await apiErrorFromResponse(Response.json(body, { status: 426 }));

    expect(useAppVersionStore.getState()).toMatchObject({
      upgradeRequired: true,
      currentVersion: null,
      updateUrl: null,
    });
  });

  it('nulls both version fields when a 426 body carries no details object', async () => {
    useAppVersionStore.setState({ currentVersion: 'stale', updateUrl: 'stale' });

    await apiErrorFromResponse(Response.json({ code: 'VERSION_MISMATCH' }, { status: 426 }));

    expect(useAppVersionStore.getState()).toMatchObject({
      upgradeRequired: true,
      currentVersion: null,
      updateUrl: null,
    });
  });

  it('raises only the upgrade-required flag on a 426 with no parseable body', async () => {
    useAppVersionStore.setState({ currentVersion: 'kept', updateUrl: 'kept' });

    await apiErrorFromResponse(new Response('not json', { status: 426 }));

    expect(useAppVersionStore.getState()).toMatchObject({
      upgradeRequired: true,
      currentVersion: 'kept',
      updateUrl: 'kept',
    });
  });

  it('leaves the upgrade-required flag alone on any other status', async () => {
    await apiErrorFromResponse(Response.json({ code: 'NOT_FOUND' }, { status: 404 }));

    expect(useAppVersionStore.getState().upgradeRequired).toBe(false);
  });
});
