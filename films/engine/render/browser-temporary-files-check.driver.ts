import { readFileSync, readdirSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import path from 'node:path';

import { renderStill, selectComposition } from '@remotion/renderer';
import { TMPFS_MAGIC, statfsType } from '@hushbox/scripts/lib/tmpfs';

import { DEFAULT_GL } from '../cli/command.js';

import { browserTemporaryParent } from './browser-temporary-files.js';
import { withFilmBrowser, withFilmBundle } from './film-browser.driver.js';
import { loadFilm } from './films.driver.js';
import { withRunDirectory } from './run-directory.js';

import type { HeadlessBrowser } from '@remotion/renderer';

/*
 * Checks that a render browser keeps its temporary files in RAM: opens the
 * browser every film render opens, renders frame 0 of engine-render, and while
 * the browser is still open reads every Chrome process's memory maps. Each
 * `.org.chromium.Chromium.*` file mapped (the shared memory frames pass
 * through) and the browser's profile must be on tmpfs. Usage, from the
 * repository root, on Linux:
 *
 *   node --import tsx films/engine/render/browser-temporary-files-check.driver.ts
 *
 * Prints one line per Chrome process and exits 1 when anything is off tmpfs,
 * or when no mapping is found at all, since a census that finds nothing
 * proves nothing.
 */

const FILM_ID = 'engine-render';
const SHARED_MEMORY = '.org.chromium.Chromium.';
const PROFILE_FLAG = '--user-data-dir=';
const PROC = path.join(path.sep, 'proc');

/** One Chrome process: the filesystem type under each shared-memory file it maps, and under its profile. */
interface ChromeProcess {
  pid: number;
  name: string;
  fileTypes: number[];
  profileType: number | undefined;
}

/** Each process's parent, read from `/proc/<pid>/stat`, whose command name may hold spaces. */
function parents(): Map<number, number> {
  const byPid = new Map<number, number>();
  for (const entry of readdirSync(PROC)) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(path.join(PROC, entry, 'stat'), 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      byPid.set(Number(entry), Number(fields[1]));
    } catch (error) {
      // A process that exits between the listing and the read has no parent to record.
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return byPid;
}

function descendantsOf(root: number): number[] {
  const byPid = parents();
  const found: number[] = [];
  let frontier = [root];
  while (frontier.length > 0) {
    const current = new Set(frontier);
    frontier = [...byPid].filter(([, parent]) => current.has(parent)).map(([pid]) => pid);
    found.push(...frontier);
  }
  return found;
}

async function filesystemType(directory: string): Promise<number> {
  const reading = await statfs(directory);
  return reading.type;
}

/** What one process maps and where its profile is, read while the browser is open: closing it removes the profile. */
async function census(pid: number): Promise<ChromeProcess> {
  const read = (file: string): string => readFileSync(path.join(PROC, String(pid), file), 'utf8');
  const files = new Set<string>();
  for (const line of read('maps').split('\n')) {
    const at = line.indexOf(path.sep);
    const file = at === -1 ? '' : line.slice(at).replace(/ \(deleted\)$/, '');
    if (path.basename(file).startsWith(SHARED_MEMORY)) files.add(file);
  }
  const profile = read('cmdline')
    .split('\0')
    .find((argument) => argument.startsWith(PROFILE_FLAG))
    ?.slice(PROFILE_FLAG.length);
  const fileTypes: number[] = [];
  for (const file of files) {
    fileTypes.push(await filesystemType(path.dirname(file)));
  }
  return {
    pid,
    name: read('comm').trim(),
    fileTypes,
    profileType: profile === undefined ? undefined : await filesystemType(profile),
  };
}

async function renderFrameZero(
  serveUrl: string,
  browser: HeadlessBrowser,
  run: string
): Promise<void> {
  const composition = await selectComposition({
    serveUrl,
    id: FILM_ID,
    inputProps: {},
    puppeteerInstance: browser,
    chromiumOptions: { gl: DEFAULT_GL },
  });
  await renderStill({
    composition,
    serveUrl,
    frame: 0,
    output: path.join(run, 'frame-0000.png'),
    imageFormat: 'png',
    overwrite: true,
    puppeteerInstance: browser,
    chromiumOptions: { gl: DEFAULT_GL },
  });
}

/** Every Chrome process this process started, while the browser is open after frame 0. */
async function chromeCensus(): Promise<ChromeProcess[]> {
  const film = loadFilm(FILM_ID);
  return withFilmBundle(film, async (serveUrl) =>
    withFilmBrowser(FILM_ID, DEFAULT_GL, async (browser) => {
      // Frame 0 renders into this run's own directory, never a piece's published stills.
      await withRunDirectory(film, async (run) => renderFrameZero(serveUrl, browser, run));
      const found: ChromeProcess[] = [];
      for (const pid of descendantsOf(process.pid)) {
        try {
          found.push(await census(pid));
        } catch (error) {
          // A helper process that exits after the listing has nothing left to map.
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
      }
      return found.filter(
        ({ fileTypes, profileType }) => fileTypes.length > 0 || profileType !== undefined
      );
    })
  );
}

/** Prints one line per process and the verdict; returns the exit status. */
function report(chrome: readonly ChromeProcess[]): number {
  let off = 0;
  let mapped = 0;
  for (const { pid, name, fileTypes, profileType } of chrome) {
    const offFiles = fileTypes.filter((type) => type !== TMPFS_MAGIC).length;
    const types = [...new Set(fileTypes)].map((type) => statfsType(type)).join(', ') || 'none';
    const profileNote = profileType === undefined ? '' : `; profile on ${statfsType(profileType)}`;
    process.stdout.write(
      `pid ${String(pid)} ${name}: ${String(fileTypes.length)} shared-memory files on ${types}, ${String(offFiles)} off tmpfs${profileNote}\n`
    );
    mapped += fileTypes.length;
    off += offFiles + (profileType === undefined || profileType === TMPFS_MAGIC ? 0 : 1);
  }
  if (mapped === 0) {
    process.stdout.write(
      'browser temporary files check: FAIL, no Chrome process maps a shared-memory file\n'
    );
    return 1;
  }
  const verdict = off === 0 ? 'PASS' : `FAIL, ${String(off)} off tmpfs`;
  process.stdout.write(`browser temporary files check: ${verdict}\n`);
  return off === 0 ? 0 : 1;
}

async function main(): Promise<number> {
  if (browserTemporaryParent(process.platform) === undefined) {
    process.stdout.write(
      'browser temporary files check: off Linux the browser keeps the OS temporary directory\n'
    );
    return 0;
  }
  return report(await chromeCensus());
}

process.exitCode = await main();
