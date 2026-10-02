import { test, expect } from '../fixtures.js';
import { matrix } from '../../scripts/lib/playwright/browser-matrix.js';
import { previewOpApi } from '../admin/helpers/op-modal.js';
import {
  ALL_NOTIFICATIONS_ON,
  saveNotificationPreferences,
} from '../notifications/push-harness.js';
import { clearUsageRateLimits } from './auth.js';
import { withRequestRetry } from './resilient-request.js';
import type { APIRequestContext, Request } from '../fixtures.js';

const SPEC_MATRIX = matrix({
  engine: 'engine-any',
  formFactor: 'either',
  reason:
    'The wrapper decides whether to re-send by inspecting the call it intercepts, node-side. No page is opened, so no rendering engine participates.',
});

/**
 * A stub context whose one method answers the given statuses in order (the last
 * one repeating), recording how many times it was called. `status()` is what the
 * retry policy reads off a response; `ok()` is what a caller that refuses a
 * failed write reads.
 */
function stubContext(
  method: 'get' | 'post' | 'put' | 'delete' | 'fetch',
  statuses: readonly number[]
): { context: APIRequestContext; sends: () => number } {
  let sends = 0;
  const send = (): Promise<unknown> => {
    const status = statuses[Math.min(sends, statuses.length - 1)];
    sends += 1;
    return Promise.resolve({
      status: () => status,
      ok: () => status !== undefined && status < 400,
    });
  };
  return {
    context: { [method]: send } as unknown as APIRequestContext,
    sends: () => sends,
  };
}

test.describe('Request-retry replay safety', SPEC_MATRIX, () => {
  test('re-sends a transient mutating failure that carries an idempotency key', async () => {
    const stub = stubContext('post', [503, 200]);

    const settled = await withRequestRetry(stub.context).post('/dev/conversation', {
      headers: { 'Idempotency-Key': 'a-fixed-key' },
    });

    expect(settled.status()).toBe(200);
    expect(stub.sends()).toBe(2);
  });

  test('re-sends a transient mutating failure keyed under a lowercase header name', async () => {
    const stub = stubContext('post', [503, 200]);

    const settled = await withRequestRetry(stub.context).post('/dev/conversation', {
      headers: { 'idempotency-key': 'a-fixed-key' },
    });

    expect(settled.status()).toBe(200);
    expect(stub.sends()).toBe(2);
  });

  test('leaves a transient mutating failure carrying no idempotency key unsent again', async () => {
    const stub = stubContext('post', [503, 200]);

    const settled = await withRequestRetry(stub.context).post('/dev/conversation');

    expect(settled.status()).toBe(503);
    expect(stub.sends()).toBe(1);
  });

  test('leaves a transient fetch declaring a mutating method and no key unsent again', async () => {
    const stub = stubContext('fetch', [503, 200]);

    const settled = await withRequestRetry(stub.context).fetch('/dev/conversation', {
      method: 'POST',
    });

    expect(settled.status()).toBe(503);
    expect(stub.sends()).toBe(1);
  });

  test('leaves a transient fetch of a request object naming a mutating method unsent again', async () => {
    const stub = stubContext('fetch', [503, 200]);

    // `fetch` also accepts a `Request` as its target, which carries the method
    // on itself when the options bag names none.
    const settled = await withRequestRetry(stub.context).fetch({
      method: () => 'POST',
    } as unknown as Request);

    expect(settled.status()).toBe(503);
    expect(stub.sends()).toBe(1);
  });

  test('re-sends a transient read that carries no idempotency key', async () => {
    const stub = stubContext('get', [503, 200]);

    const settled = await withRequestRetry(stub.context).get('/health');

    expect(settled.status()).toBe(200);
    expect(stub.sends()).toBe(2);
  });

  // A route that declares an idempotency exemption ignores the key a caller
  // sends rather than rejecting it; what the key buys there is that the retry
  // wrapper sees the replay premise and re-sends.
  test('re-sends the usage rate-limit reset every test runs, after a transient failure', async () => {
    const stub = stubContext('delete', [503, 200]);

    await clearUsageRateLimits(withRequestRetry(stub.context));

    expect(stub.sends()).toBe(2);
  });

  test('re-sends a notification-preferences write after a transient failure', async () => {
    const stub = stubContext('put', [503, 200]);

    await saveNotificationPreferences(withRequestRetry(stub.context), ALL_NOTIFICATIONS_ON);

    expect(stub.sends()).toBe(2);
  });

  test('re-sends an admin op preview after a transient failure', async () => {
    const stub = stubContext('post', [503, 200]);

    const settled = await previewOpApi(withRequestRetry(stub.context), 'wallet.credit', {});

    expect(settled.status()).toBe(200);
    expect(stub.sends()).toBe(2);
  });
});
