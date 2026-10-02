import { dropDatabaseSql } from '@hushbox/db/test-db';
import { emptyStoreDirectory, storeProbe } from '../claims/world-scan.js';
import { emptyBucket, type ObjectStoreEndpoint } from '../test-run/scratch-bucket-reclaim.js';
import { withMaintenanceExecutor } from '../test-run/test-db-provision.js';
import { redisCommand } from './srh-command.js';
import type { StoreAnswer } from '../claims/world-reading.js';

/**
 * Recreating one stack's data plane from nothing: its database dropped, its
 * Redis logical database flushed, its media bucket emptied, and its Worker
 * persist root and browsers' temporary directory emptied, so the bring-up's own
 * create and migrate steps rebuild it and the seed lands on nothing an earlier
 * run left.
 *
 * Every target is a parameter rather than something this module works out,
 * because the one property that matters is that nothing but the named stack's
 * stores is reached: the caller resolves them from the environment it loaded,
 * and a test hands scratch ones of its own.
 */

export interface DataPlaneTargets {
  readonly databaseName: string;
  /** Selects the Redis logical database: the proxy fronts one per token. */
  readonly redisToken: string;
  readonly bucket: string;
  /** Absolute. */
  readonly persistRoot: string;
  /**
   * Absolute, and only where the stack's browsers have a temporary directory of
   * their own: a worker killed mid-run leaves its browser profile there.
   */
  readonly browserTmp?: string;
}

export interface DataPlaneLegs {
  readonly dropDatabase: (name: string) => Promise<void>;
  readonly flushRedis: (token: string) => Promise<void>;
  readonly emptyBucket: (bucket: string) => Promise<void>;
  readonly probeStore: (root: string) => Promise<StoreAnswer>;
  readonly emptyDirectory: (root: string) => Promise<void>;
}

interface LiveDataPlaneConfig {
  /** Any connection string on the cluster; the drop runs over its maintenance database. */
  readonly databaseUrl: string;
  readonly redisUrl: string;
  readonly objectStore: ObjectStoreEndpoint;
}

/**
 * Empties every target, or refuses before touching any of them while a process
 * holds the persist root open: a Worker still writing there would carry on over
 * an emptied directory with state no seed made.
 *
 * `unknown` proceeds: on a platform with no process filesystem the probe can
 * never answer otherwise, and the band check and port reclaim that precede a
 * bring-up are what keep a second run off this stack there.
 */
export async function resetDataPlane(
  targets: DataPlaneTargets,
  legs: DataPlaneLegs
): Promise<void> {
  const answer = await legs.probeStore(targets.persistRoot);
  if (answer.kind === 'occupied') {
    throw new Error(
      `ensure-stack: refusing to recreate the data plane while a process holds ` +
        `${targets.persistRoot} open — a Worker from an earlier run is still exiting. ` +
        'Re-run once it has gone.'
    );
  }
  // The persist root first, so as little as possible separates it from the
  // occupancy reading taken above.
  await legs.emptyDirectory(targets.persistRoot);
  if (targets.browserTmp !== undefined) await legs.emptyDirectory(targets.browserTmp);
  await legs.dropDatabase(targets.databaseName);
  await legs.flushRedis(targets.redisToken);
  await legs.emptyBucket(targets.bucket);
}

/**
 * The persist root emptied and kept, or left alone where no Worker has made it
 * yet — an absent root holds nothing an earlier run could have left.
 */
export async function emptyPersistRoot(root: string): Promise<void> {
  try {
    await emptyStoreDirectory(root);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw error;
  }
}

/** The one answer `FLUSHDB` gives; anything else means the proxy did something else. */
const FLUSHED = 'OK';

export function liveDataPlaneLegs(config: LiveDataPlaneConfig): DataPlaneLegs {
  return {
    dropDatabase: (name) =>
      withMaintenanceExecutor(config.databaseUrl, (maintenance) =>
        maintenance.exec(dropDatabaseSql(name))
      ),
    // FLUSHDB, never FLUSHALL: the proxy fronts every stack's logical database
    // on one Redis, and FLUSHALL empties all of them.
    flushRedis: async (token) => {
      const result = await redisCommand(config.redisUrl, token, ['flushdb']);
      if (result !== FLUSHED) {
        throw new Error(
          `ensure-stack: Redis REST flushdb answered ${JSON.stringify(result)} rather than ` +
            `${JSON.stringify(FLUSHED)}, so the flush cannot be taken as done.`
        );
      }
    },
    emptyBucket: (bucket) => emptyBucket(config.objectStore, bucket),
    probeStore: (root) => storeProbe(root, process.platform)(''),
    emptyDirectory: emptyPersistRoot,
  };
}
