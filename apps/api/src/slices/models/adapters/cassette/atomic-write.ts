/**
 * The two-step write the cassette store lands a recording with: bytes to a
 * sibling of the target, then a rename, which is atomic within one filesystem.
 * A partial temporary file from a crashed write is orphaned but never read.
 *
 * The staging name is random rather than derived from the writer's identity:
 * process ids repeat across identity spaces, so two writers that share one
 * stage at a single name and the loser's rename finds nothing there.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renameWithRetrySync } from '@hushbox/shared/atomic-rename';
import type { RenameSyncDeps } from '@hushbox/shared/atomic-rename';

export function writeAtomically(finalPath: string, body: string, deps: RenameSyncDeps = {}): void {
  const temporaryPath = `${finalPath}.${randomUUID()}.tmp`;
  mkdirSync(path.dirname(finalPath), { recursive: true });
  writeFileSync(temporaryPath, body);
  renameWithRetrySync(temporaryPath, finalPath, deps);
}
