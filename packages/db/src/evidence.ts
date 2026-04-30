import type { Database } from './client';
import { serviceEvidence } from './schema/service-evidence';

export const SERVICE_NAMES = {
  AI_GATEWAY: 'ai-gateway',
  HELCIM: 'helcim',
  HOOKDECK: 'hookdeck',
} as const;

export type ServiceName = (typeof SERVICE_NAMES)[keyof typeof SERVICE_NAMES];

/**
 * Shared shape for any external-service factory that records evidence after
 * successful real API calls. Bundled by the `createEvidenceConfig(c)` helper
 * in apps/api so middleware passes the same dependencies into every factory.
 *
 * The evidence row is only written when `isCI === true` — see
 * `recordServiceEvidence`. Production sees `isCI === false` and skips.
 */
export interface EvidenceConfig {
  db: Database;
  isCI: boolean;
}

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
