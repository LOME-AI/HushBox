import { hc } from 'hono/client';
import type { AppType } from '@hushbox/api';
import { ApiError, getApiUrl } from './api.js';

export const client = hc<AppType>(getApiUrl(), {
  init: { credentials: 'include' },
});

/**
 * Unwrap a Hono RPC client Response.
 * On success (res.ok), returns parsed JSON.
 * On failure, throws ApiError with the error message from the response body.
 */
export async function fetchJson<T>(responsePromise: Promise<Response>): Promise<T> {
  const res = await responsePromise;
  if (!res.ok) {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    const code =
      typeof body === 'object' &&
      body !== null &&
      'code' in body &&
      typeof (body as Record<string, unknown>)['code'] === 'string'
        ? ((body as Record<string, unknown>)['code'] as string)
        : 'INTERNAL';
    throw new ApiError(code, res.status, body);
  }
  return (await res.json()) as T;
}
