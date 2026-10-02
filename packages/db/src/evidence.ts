import { serviceEvidence } from './schema/service-evidence';
import type { Database } from './client';

/**
 * One name per seam a CI step proves. A name says what was proven rather than
 * which vendor carried the bytes, and the two OpenRouter seams are separate
 * because they fail independently: inference replays a cassette, while the
 * catalog read is unauthenticated, uncassetted, and parses a vendor-owned
 * schema whose silent drift shrinks the catalog. Under one shared name a dead
 * catalog test is invisible whenever the inference path recorded a row.
 */
export const SERVICE_NAMES = {
  OPENROUTER_CATALOG: 'openrouter-catalog',
  OPENROUTER_INFERENCE: 'openrouter-inference',
  HELCIM: 'helcim',
  HELCIM_WEBHOOK: 'helcim-webhook',
  LINEAR: 'linear',
  R2_STORAGE: 'r2-storage',
  R2_GC: 'r2-gc',
  PUSH_FCM: 'push-fcm',
  BRAVE_SEARCH: 'brave-search',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

/**
 * The evidence row is only written when `isCI === true`: real-adapter seams
 * call this after a successful real external API call, and CI's
 * `verify:evidence` step later asserts the rows exist. Production sees
 * `isCI === false` and skips the write.
 */
export async function recordServiceEvidence(
  db: Database,
  isCI: boolean,
  service: ServiceName,
  details?: Record<string, unknown>
): Promise<void> {
  if (!isCI) return;

  await db.insert(serviceEvidence).values({
    service,
    details: details ?? null,
  });
}

export async function verifyServiceEvidence(
  db: Database,
  required: ServiceName[]
): Promise<{ success: boolean; missing: ServiceName[] }> {
  if (required.length === 0) return { success: true, missing: [] };

  const rows = await db.selectDistinct({ service: serviceEvidence.service }).from(serviceEvidence);

  const found = new Set(rows.map((r) => r.service));
  const missing = required.filter((s) => !found.has(s));

  return { success: missing.length === 0, missing };
}
