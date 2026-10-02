import { useAppVersionStore } from '@/stores/app-version.js';
import { ApiError } from './api.js';
import { parseRetryAfterMs } from './retry.js';

/**
 * Pulls the optional `currentVersion` / `updateUrl` fields out of a 426
 * VERSION_MISMATCH response body's `details` object (the `{ code, details }`
 * error contract every route follows). Returns `undefined` when the body is
 * absent or not an object (legacy/bodyless 426) so the caller falls back to
 * flipping only the boolean flag; missing individual fields become `null`.
 */
function extractVersionMismatch(
  body: unknown
): { currentVersion: string | null; updateUrl: string | null } | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const details = (body as Record<string, unknown>)['details'];
  const record: Record<string, unknown> =
    typeof details === 'object' && details !== null ? (details as Record<string, unknown>) : {};
  const currentVersion =
    typeof record['currentVersion'] === 'string' ? record['currentVersion'] : null;
  const updateUrl = typeof record['updateUrl'] === 'string' ? record['updateUrl'] : null;
  return { currentVersion, updateUrl };
}

/**
 * The `ApiError` a failed response stands for, built in one place for every
 * caller: the retry policy reads its status, `Retry-After` and key fact, so a
 * second builder would let one caller retry differently from the rest. A 426
 * also raises the app's upgrade-required flag.
 */
export async function apiErrorFromResponse(response: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await response.json();
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
  if (response.status === 426) {
    useAppVersionStore.getState().setUpgradeRequired(true, extractVersionMismatch(body));
  }
  const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
  return new ApiError(code, response.status, body, {
    retryAfterMs: retryAfterMs ?? undefined,
    response,
  });
}
