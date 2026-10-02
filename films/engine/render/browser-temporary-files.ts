import path from 'node:path';

import { MIB, mebibytes, statfsType, tmpfsShortfall } from '@hushbox/scripts/lib/tmpfs';

import { FilmRenderError } from './film-error.js';

import type { ReadStatfs } from '@hushbox/scripts/lib/tmpfs';

/**
 * The room one render browser's temporary directory needs: its shared-memory
 * files, which Remotion's `--disable-dev-shm-usage` puts there, and its profile.
 * The measured peak was about 60 MiB on the densest fixture.
 */
export const BROWSER_TEMPORARY_BYTES = 64 * MIB;

/**
 * Where a render browser's private temporary directory is made: on Linux, the
 * RAM filesystem, because a Chrome thread writing its frame-transfer files to a
 * contended disk blocks for as long as the disk takes; elsewhere nothing, and
 * the browser keeps the OS temporary directory.
 */
export function browserTemporaryParent(platform: NodeJS.Platform): string | undefined {
  return platform === 'linux' ? path.join(path.sep, 'dev', 'shm') : undefined;
}

/**
 * The refusal of a render browser's temporary directory parent that is not
 * tmpfs or has less than `BROWSER_TEMPORARY_BYTES` free, naming the film, the
 * directory, its filesystem, its free space and the need; nothing when it holds.
 */
export function browserTemporaryRefusal(
  filmId: string,
  directory: string,
  reading: Awaited<ReturnType<ReadStatfs>>
): FilmRenderError | undefined {
  const shortfall = tmpfsShortfall(reading, BROWSER_TEMPORARY_BYTES);
  if (shortfall === undefined) return undefined;
  const free = mebibytes(shortfall.freeBytes);
  const found = shortfall.isTmpfs
    ? `is tmpfs with ${free} free. Raise the shared-memory size (for a container, its shm size)`
    : `is not tmpfs (statfs type ${statfsType(shortfall.type)}), with ${free} free. Mount a tmpfs at ${directory}`;
  return new FilmRenderError({
    filmId,
    rule: 'browser-temporary-files',
    detail: `a render browser's temporary directory needs ${mebibytes(BROWSER_TEMPORARY_BYTES)} free on a tmpfs, and ${directory} ${found}, and re-run.`,
  });
}
