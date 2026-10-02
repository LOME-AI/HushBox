import path from 'node:path';
import { claim } from '../../../../scripts/lib/claims/claim.js';

/**
 * Holds a finding's write lock the way a second writer would, and hands back
 * the release.
 *
 * The store's lock is an OS advisory lock, so a lock file with nothing behind
 * it holds nothing and a write walks straight past it. A test that wants to see
 * a refusal has to take a real lock; a second descriptor conflicts with the
 * first even inside one process, so a second process is not needed to get one.
 */
export async function holdFindingLock(filePath: string): Promise<() => Promise<void>> {
  const acquired = Promise.withResolvers<null>();
  const released = Promise.withResolvers<null>();

  const holding = claim(
    { name: path.basename(filePath), lockPath: `${filePath}.lock` },
    { onHeld: 'refuse', holder: 'another writer' },
    async () => {
      acquired.resolve(null);
      await released.promise;
    }
  );
  await Promise.race([acquired.promise, holding]);

  return async () => {
    released.resolve(null);
    await holding;
  };
}
