import type { StatsFs } from 'node:fs';

/**
 * Whether a directory can hold what a process keeps in RAM there: its
 * filesystem is tmpfs, and it has the room asked for. A directory on disk
 * brings back the stalls a RAM directory exists to remove, and a tmpfs that
 * fills fails whichever write comes next.
 */

/** The kernel's filesystem type number for tmpfs. */
export const TMPFS_MAGIC = 0x01_02_19_94;

/** The fields of a filesystem reading the check reads. */
export type ReadStatfs = (target: string) => Promise<Pick<StatsFs, 'type' | 'bsize' | 'bavail'>>;

export const MIB = 1024 * 1024;

/** A size in whole mebibytes, rounded down. */
export function mebibytes(bytes: number): string {
  return `${String(Math.floor(bytes / MIB))} MiB`;
}

/** A statfs filesystem type as the kernel headers write it: eight hex digits. */
export function statfsType(type: number): string {
  return `0x${type.toString(16).padStart(8, '0')}`;
}

/** Why a filesystem cannot hold what was asked of it. */
export interface TmpfsShortfall {
  readonly isTmpfs: boolean;
  readonly type: number;
  /** What an unprivileged writer may still write there. */
  readonly freeBytes: number;
}

/**
 * How the filesystem `reading` describes falls short of holding `requiredBytes`
 * on tmpfs, with `creditBytes` (space its owner frees before writing) counted
 * as free; nothing when it holds them. A NaN in any size falls short.
 */
export function tmpfsShortfall(
  reading: Pick<StatsFs, 'type' | 'bsize' | 'bavail'>,
  requiredBytes: number,
  creditBytes = 0
): TmpfsShortfall | undefined {
  const freeBytes = reading.bavail * reading.bsize;
  const isTmpfs = reading.type === TMPFS_MAGIC;
  if (isTmpfs && freeBytes + creditBytes >= requiredBytes) return undefined;
  return { isTmpfs, type: reading.type, freeBytes };
}
