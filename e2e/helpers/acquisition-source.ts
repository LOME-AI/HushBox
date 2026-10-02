import { requireEnv } from './env.js';
import { expectOkResponse } from './ok-response.js';
import type { AcquisitionPlatform, GrowthChannel, GrowthSelfReportContext } from '@hushbox/shared';
import type { APIRequestContext } from '@playwright/test';

/**
 * Dev read-back of the account's acquisition row. The channel prompt's own
 * appearance and disappearance is app state: it proves what the server said was
 * due, never what it stored. Specs that drive the prompt assert the stored row
 * through here (rule 1.5), and raw dev-endpoint calls live here rather than in
 * a spec (rule 3.3).
 */

const API_BASE = requireEnv('VITE_API_URL');

/** One account's stored source row, as the dev read-back projects it. */
interface StoredAcquisitionSource {
  readonly campaign: string;
  readonly platform: AcquisitionPlatform;
  readonly selfReportedChannel: GrowthChannel | null;
  readonly selfReportedContext: GrowthSelfReportContext | null;
  readonly selfReportSkipped: GrowthSelfReportContext | null;
}

/**
 * The acquisition row for `email`, or `null` when the account carries none —
 * so a caller may poll for a row a flow has not committed yet, and so a whole
 * expected row can be compared in one assertion without narrowing first. Any
 * status other than 200/404 throws, so a broken seam fails at the call site
 * rather than reading as an account with no row.
 */
export async function fetchAcquisitionSource(
  request: APIRequestContext,
  email: string
): Promise<StoredAcquisitionSource | null> {
  const response = await request.get(
    `${API_BASE}/dev/acquisition-source/${encodeURIComponent(email)}`
  );
  if (response.status() === 404) return null;
  await expectOkResponse(response, 'dev acquisition-source read-back', 200);
  return (await response.json()) as StoredAcquisitionSource;
}
