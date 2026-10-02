import { randomUUID } from 'node:crypto';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { claim, tryLock } from '../claims/claim.js';
import { ramPathsFor } from '../stack/ram-root.js';
import { withBuildLease } from './lease.js';
import type { RamRootHost } from '../stack/ram-root.js';
import type { BuildOutput } from './lease.js';

/**
 * A private copy of a built output, served for as long as one run needs it.
 *
 * The build lease alone cannot protect a served bundle: the lease covers the
 * write, and the serve outlives it by however long the run takes, so a build
 * starting in that window finds the lease free and wipes the directory out from
 * under the server — blank pages and 404s, while the build reports success.
 * Holding the lease across the serve instead would refuse every other writer
 * for the whole run, which is the conflict rather than a fix. Copying is what
 * makes the two independent: the build writes its own directory and the server
 * reads a snapshot nothing else can reach.
 *
 * A snapshot is itself a claimed resource, so it is bounded without a clock. Its
 * owner holds the claim for exactly as long as it serves, and the next run
 * drops any snapshot whose owner no longer holds one — which a killed run's
 * does not, the instant the kernel reaps it. Reclamation is asked of the lock
 * and never inferred from a directory or a lock file being there.
 */

/**
 * Apart from every build output: a snapshot is a build output's twin, not part
 * of one, and no build wipes this directory. On Linux it is in the checkout's
 * E2E RAM root, so a preview's read of an evicted bundle never waits on a disk;
 * elsewhere it is beside the checkout's other runtime cache files. `host` is
 * where that root is made, the machine's own RAM filesystem when not given.
 */
export function snapshotsDir(repoRoot: string, host?: RamRootHost): string {
  return (
    ramPathsFor(repoRoot, host)?.snapshots ??
    path.join(repoRoot, 'scripts', '.cache', 'dist-snapshots')
  );
}

/** What makes a snapshot's claim file out of the snapshot's own name. */
const LOCK_SUFFIX = '.lock';

/** The claim on a snapshot, a sibling of it — the primitive owns its bytes. */
export function snapshotLockPath(repoRoot: string, id: string, host?: RamRootHost): string {
  return `${path.join(snapshotsDir(repoRoot, host), id)}${LOCK_SUFFIX}`;
}

/**
 * Drops every snapshot no run is still serving, and names them. This is the
 * whole reclamation mechanism: a run that exits cleanly drops its own, and one
 * that is killed leaves its snapshot for whichever run comes next.
 *
 * A lock file goes with the directory it names, and one standing alone goes on
 * its own: it guards a snapshot that does not exist, so nothing is left to
 * protect and the file would otherwise stand in the tree for good. Each
 * removal is decided by the lock and never by what is on disk, and is stated
 * where it decides.
 */
export async function reclaimExpiredSnapshots(
  repoRoot: string,
  host?: RamRootHost
): Promise<string[]> {
  const root = snapshotsDir(repoRoot, host);
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const snapshots = new Set(
    entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
  );
  const lonely = entries
    .filter((entry) => !entry.isDirectory() && entry.name.endsWith(LOCK_SUFFIX))
    .map((entry) => entry.name.slice(0, -LOCK_SUFFIX.length))
    .filter((id) => !snapshots.has(id));

  const reclaimed: string[] = [];
  for (const id of snapshots) {
    if (await dropSnapshot(repoRoot, id, host)) reclaimed.push(id);
  }
  for (const id of lonely) await dropLoneClaimFile(repoRoot, id, host);
  return reclaimed;
}

/** Drops the snapshot `id` and its claim file, unless a run still holds it. */
async function dropSnapshot(
  repoRoot: string,
  id: string,
  host: RamRootHost | undefined
): Promise<boolean> {
  const lockPath = snapshotLockPath(repoRoot, id, host);
  const probe = await tryLock(lockPath);
  if (probe.held) return false;
  await rm(path.join(snapshotsDir(repoRoot, host), id), { recursive: true, force: true });
  // The directory says its owner reached the claim body, and the free lock
  // says that owner is gone, so nothing can be inside the acquire window for
  // this id — and each id is a fresh uuid no run mints twice, so nothing will
  // ever come to this path again.
  await rm(lockPath, { force: true });
  return true;
}

/**
 * Drops a claim file that names a snapshot which is not there, unless a run
 * still holds it.
 *
 * A free lock on such a file is debris wherever its owner is gone, and it
 * reads exactly the same for an owner still between creating its claim file
 * and locking it. What keeps the removal safe across that window is
 * {@link withBundleSnapshot}, which checks its claim file is still on disk
 * before it serves — so that run refuses rather than serves a snapshot a later
 * pass would delete out from under it.
 */
async function dropLoneClaimFile(
  repoRoot: string,
  id: string,
  host: RamRootHost | undefined
): Promise<void> {
  const lockPath = snapshotLockPath(repoRoot, id, host);
  const probe = await tryLock(lockPath);
  if (probe.held) return;
  await rm(lockPath, { force: true });
}

/** Raises rather than returning, where a snapshot's claim file has gone. */
async function requireClaimFile(
  repoRoot: string,
  id: string,
  host: RamRootHost | undefined
): Promise<void> {
  const entries = await readdir(snapshotsDir(repoRoot, host));
  if (entries.includes(`${id}${LOCK_SUFFIX}`)) return;
  throw new Error(
    `The claim on snapshot \`${id}\` is no longer on disk, so nothing says this ` +
      `snapshot is being served and a reclaim pass may take it mid-serve. This run ` +
      `refused to serve it rather than serve something that can vanish.`
  );
}

interface BundleSnapshotOptions {
  readonly repoRoot: string;
  /** Which built output this is a snapshot of, and whose lease guards it. */
  readonly resource: BuildOutput;
  /** The built output to copy. */
  readonly source: string;
  /** How this run names itself to anyone its lease refuses. */
  readonly holder: string;
  /** Writes `source`. Runs under the build lease, before the copy. */
  readonly produce: () => Promise<void>;
  /** Where the checkout's RAM root is made, the machine's own RAM filesystem when not given. */
  readonly ramHost?: RamRootHost | undefined;
}

/**
 * Produces the output under its build lease, copies it, releases the lease, and
 * hands the copy to `serve`. The claim on the snapshot is taken before the copy
 * exists and released after it is gone, so a snapshot without a live claim is
 * always debris and never a directory some run is about to fill.
 */
export async function withBundleSnapshot<T>(
  options: BundleSnapshotOptions,
  serve: (snapshot: string) => Promise<T>
): Promise<T> {
  await reclaimExpiredSnapshots(options.repoRoot, options.ramHost);

  const id = `${options.resource}-${randomUUID()}`;
  const snapshot = path.join(snapshotsDir(options.repoRoot, options.ramHost), id);
  const lockPath = snapshotLockPath(options.repoRoot, id, options.ramHost);

  return claim({ name: id, lockPath }, { onHeld: 'refuse', holder: options.holder }, async () => {
    try {
      // While the claim is held, never before it: a directory standing here is
      // how a later pass knows this id's owner got past its acquire, and that
      // is what lets the pass remove one whose lock has gone free.
      await mkdir(snapshot, { recursive: true });

      await withBuildLease(options.repoRoot, options.resource, options.holder, async () => {
        await options.produce();
        await cp(options.source, snapshot, { recursive: true });
      });

      // The claim file is the only thing that tells a reclaim pass this
      // snapshot is live, and it can be gone by now only because something
      // unlinked it — a pass that took it while this run sat between creating
      // it and locking it — leaving this lock on an unlinked inode nothing
      // else can see. Serving past that is what would let the next pass delete
      // the directory mid-serve, blank pages and all, so the run ends here
      // instead.
      await requireClaimFile(options.repoRoot, id, options.ramHost);

      return await serve(snapshot);
    } finally {
      await rm(snapshot, { recursive: true, force: true });
      // The lock file goes with the directory it names, and it goes while
      // this run still holds the lock — so the path is never both present
      // and free for anything else to take. What the primitive refuses to do
      // on release it refuses because a waiter or a later acquirer of the
      // same path would lock a deleted inode; a snapshot id is a fresh uuid
      // claimed in refuse mode, so this path can have neither.
      await rm(lockPath, { force: true });
    }
  });
}
