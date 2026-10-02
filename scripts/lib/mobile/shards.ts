/**
 * What one shard of a mobile-test run is: the emulator container it drives,
 * the host port that emulator publishes adb on, and where it writes.
 */

import path from 'node:path';
import { emulatorContainerName } from './emulator-container.js';
import { portFor } from '../stack/port-plan.js';
import { stackModeFrom, stackSlotFrom } from '../../with-env.js';

export const RESULTS_DIR = 'maestro-results';

/**
 * Where a shard's emulator publishes its ADB port on the host. Every emulator
 * binds 5555 for adb inside its own container, so the shard only decides which
 * host port that is mapped to — and the allocator owns that, one whole block
 * per shard. Spacing shards by two inside one checkout's band, as this once
 * did, put shard 1 on the port slot+2 held for shard 0.
 */
export function adbPortForShard(shard: number): number {
  return portFor('emulatorAdb', {
    slot: stackSlotFrom(process.env),
    mode: stackModeFrom(process.env),
    lane: shard,
  });
}

/**
 * What a shard's emulator container is called. Derived from the same slot and
 * shard the port above is, so two checkouts can no more mint one name than they
 * can bind one port.
 */
export function containerNameForShard(shard: number): string {
  return emulatorContainerName(stackSlotFrom(process.env), shard);
}

export function debugOutputForShard(shard: number): string {
  return path.join(RESULTS_DIR, `shard-${String(shard)}`);
}
