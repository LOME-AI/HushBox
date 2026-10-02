import type { APIResponse } from '@playwright/test';

/** The slice of a response this assertion reads; every `APIResponse` is one. */
export type CheckedResponse = Pick<APIResponse, 'ok' | 'status' | 'headers' | 'text'>;

/** The one status, or the set of statuses, a caller counts as success. */
export type ExpectedStatus = number | readonly number[];

const QUOTED_LINE_CAP = 300;

function answeredAsExpected(response: CheckedResponse, expected?: ExpectedStatus): boolean {
  if (expected === undefined) return response.ok();
  const statuses = typeof expected === 'number' ? [expected] : expected;
  return statuses.includes(response.status());
}

/**
 * Throws unless `response` answered any 2xx, or, when `expected` is given,
 * exactly one of those statuses; the request is named by `label`. The message
 * carries the status, the content type and the body's first line: a proxy that
 * lost the Worker answers plain text, a handler refusal answers a JSON code, and
 * the status alone reads the same for both. Only the first line is quoted
 * because a proxy drop's later lines are stack frames carrying absolute paths.
 */
export async function expectOkResponse(
  response: CheckedResponse,
  label: string,
  expected?: ExpectedStatus
): Promise<void> {
  if (answeredAsExpected(response, expected)) return;
  const contentType = response.headers()['content-type'] ?? 'no content-type';
  const body = await response.text();
  const [firstLine = ''] = body.split(/[\n\r\u2028\u2029]/, 1);
  throw new Error(
    `${label} failed: ${String(response.status())} ${contentType} ${firstLine.slice(0, QUOTED_LINE_CAP)}`
  );
}
