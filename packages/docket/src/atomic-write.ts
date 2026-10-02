import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { renameWithRetry } from '@hushbox/shared/atomic-rename';
import type { RenameDeps } from '@hushbox/shared/atomic-rename';

/** Writes beside the target and moves it into place, so no reader sees a half file. */
export async function atomicWrite(
  filePath: string,
  text: string,
  deps: RenameDeps = {}
): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, text);
  await renameWithRetry(temporary, filePath, deps);
}
