/**
 * Vitest setup file — ticks the per-slot heartbeat once per test process so
 * the idle-killer daemon doesn't tear the stack down mid-run. Imported via
 * the shared vitest config in packages/config/vitest.config.ts.
 *
 * No imports from outside scripts/ — this file is loaded by every Vitest
 * worker and should stay dependency-light.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { touchHeartbeat } from './idle-killer.js';

/* v8 ignore start -- runs as a side-effect on import; behavior validated via integration */
async function tickHeartbeatBestEffort(): Promise<void> {
  const slot = process.env['HB_STACK_SLOT'];
  if (slot === undefined) return;
  const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
  const repoRoot = path.resolve(scriptsDir, '..', '..');
  const heartbeatPath = path.join(repoRoot, 'scripts', '.cache', 'local', slot, 'heartbeat');
  try {
    await touchHeartbeat(heartbeatPath);
  } catch {
    /* best-effort — ignore */
  }
}

void tickHeartbeatBestEffort();
/* v8 ignore stop */
