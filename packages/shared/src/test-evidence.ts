import fs from 'node:fs';

export type ServiceName = 'openrouter' | 'hookdeck';

export interface ServiceEvidence {
  service: ServiceName;
  timestamp: string;
  details?: Record<string, unknown>;
}

export const EVIDENCE_FILE = '/tmp/ci-service-evidence.jsonl';

/**
 * Record that a real external service was called.
 * Only writes in CI environments. No-op in local dev.
 */
export function recordServiceCall(service: ServiceName, details?: Record<string, unknown>): void {
  if (!process.env['CI']) return;

  const evidence: ServiceEvidence = {
    service,
    timestamp: new Date().toISOString(),
    ...(details && { details }),
  };

  fs.appendFileSync(EVIDENCE_FILE, JSON.stringify(evidence) + '\n');
}

/**
 * Verify that required services were called during CI run.
 * Returns success status and list of missing services.
 */
export function verifyEvidence(required: ServiceName[]): {
  success: boolean;
  missing: ServiceName[];
} {
  if (required.length === 0) {
    return { success: true, missing: [] };
  }

  if (!fs.existsSync(EVIDENCE_FILE)) {
    return { success: false, missing: required };
  }

  const content = fs.readFileSync(EVIDENCE_FILE, 'utf-8');
  const lines = content.split('\n').filter(Boolean);
  const found = new Set(lines.map((l) => (JSON.parse(l) as ServiceEvidence).service));

  const missing = required.filter((s) => !found.has(s));
  return { success: missing.length === 0, missing };
}
