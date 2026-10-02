import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  publishFile,
  publishVideo,
  withRunDirectory,
  withRunDirectoryIn,
} from './run-directory.js';
import {
  RunOwnerError,
  parseRunOwner,
  runDirectoryPrefix,
  startToken,
  systemReads,
} from './run-owner.js';

import type { OwnerReads } from './run-owner.js';

import type { LoadedFilm } from './films.driver.js';

let root: string;
let film: Pick<LoadedFilm, 'id' | 'outDir'>;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'films-run-directory-'));
  film = { id: 'fixture', outDir: path.join(root, 'out') };
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('withRunDirectory', () => {
  it("hands the work an empty directory under the piece's out/", async () => {
    const seen = await withRunDirectory(film, (run) =>
      Promise.resolve({ parent: path.dirname(run), entries: readdirSync(run) })
    );

    expect(seen).toEqual({ parent: film.outDir, entries: [] });
  });

  it('hands two runs at once different directories', async () => {
    const runs = await Promise.all([
      withRunDirectory(film, (run) => Promise.resolve(run)),
      withRunDirectory(film, (run) => Promise.resolve(run)),
    ]);

    expect(new Set(runs).size).toBe(2);
  });

  it('removes the directory once the work resolves', async () => {
    const run = await withRunDirectory(film, (directory) => {
      writeFileSync(path.join(directory, 'frame-0000.png'), 'frame');
      return Promise.resolve(directory);
    });

    expect(existsSync(run)).toBe(false);
  });

  it('removes the directory once the work rejects', async () => {
    const seen: string[] = [];
    await withRunDirectory(film, (run) => {
      seen.push(run);
      writeFileSync(path.join(run, 'frame-0000.png'), 'frame');
      return Promise.reject(new Error('render'));
    }).catch(() => undefined);

    expect(seen.map((run) => existsSync(run))).toEqual([false]);
  });

  it("rejects with the work's own error", async () => {
    const failure = new Error('render');

    await expect(withRunDirectory(film, () => Promise.reject(failure))).rejects.toBe(failure);
  });

  it('never hands a later run a directory it did not make', async () => {
    mkdirSync(film.outDir);
    const left = mkdtempSync(path.join(film.outDir, 'run-'));
    writeFileSync(path.join(left, 'frame-0000.png'), 'a killed run');

    const seen = await withRunDirectory(film, (run) =>
      Promise.resolve({ isLeft: run === left, entries: readdirSync(run) })
    );

    expect(seen).toEqual({ isLeft: false, entries: [] });
  });
});

/** This process's own start token. */
async function ownToken(): Promise<string> {
  const token = await startToken(process.pid, systemReads);
  if (token === null) throw new Error('this process has no start token');
  return token;
}

describe('withRunDirectory and its owner', () => {
  it('names the directory after the process that made it', async () => {
    const owner = await withRunDirectory(film, (run) =>
      Promise.resolve(parseRunOwner(path.basename(run)))
    );

    expect(owner?.pid).toBe(process.pid);
  });

  it('removes a run directory whose owner no longer runs', async () => {
    mkdirSync(film.outDir);
    // This pid with another start time: the record a reused pid leaves.
    const left = mkdtempSync(
      path.join(film.outDir, runDirectoryPrefix(process.pid, 'linux:gone:1'))
    );
    writeFileSync(path.join(left, 'frame-0000.png'), 'a killed run');

    await withRunDirectory(film, () => Promise.resolve());

    expect(existsSync(left)).toBe(false);
  });

  it('leaves a run directory whose owner still runs', async () => {
    mkdirSync(film.outDir);
    const live = mkdtempSync(
      path.join(film.outDir, runDirectoryPrefix(process.pid, await ownToken()))
    );

    await withRunDirectory(film, () => Promise.resolve());

    expect(existsSync(live)).toBe(true);
  });

  it('refuses to make a run directory when this process has no start to read', async () => {
    const reads: OwnerReads = {
      platform: 'linux',
      readFile: (file) => Promise.reject(Object.assign(new Error(file), { code: 'ENOENT' })),
      run: () => Promise.reject(new Error('Linux reads no tool')),
    };

    await expect(
      withRunDirectoryIn(film.outDir, () => Promise.resolve(), reads)
    ).rejects.toBeInstanceOf(RunOwnerError);
  });

  it('leaves a directory whose name records no owner', async () => {
    mkdirSync(path.join(film.outDir, 'run-Ab3dE9'), { recursive: true });

    await withRunDirectory(film, () => Promise.resolve());

    expect(existsSync(path.join(film.outDir, 'run-Ab3dE9'))).toBe(true);
  });
});

describe('publishFile', () => {
  it('writes the bytes at the target, making its directory', async () => {
    const target = path.join(film.outDir, 'stems', 'click.wav');

    await publishFile(target, new TextEncoder().encode('this run'));

    expect(readFileSync(target, 'utf8')).toBe('this run');
  });

  it('replaces the file an earlier run published', async () => {
    const target = path.join(film.outDir, 'sheet.png');
    mkdirSync(film.outDir);
    writeFileSync(target, 'an earlier run');

    await publishFile(target, new TextEncoder().encode('this run'));

    expect(readFileSync(target, 'utf8')).toBe('this run');
  });

  it('leaves nothing beside the target but the target', async () => {
    const target = path.join(film.outDir, 'sheet.png');

    await publishFile(target, new TextEncoder().encode('this run'));

    expect(readdirSync(film.outDir)).toEqual(['sheet.png']);
  });

  it('returns the target', async () => {
    const target = path.join(film.outDir, 'sheet.png');

    await expect(publishFile(target, new TextEncoder().encode('this run'))).resolves.toBe(target);
  });
});

describe('publishVideo', () => {
  it("moves a finished MP4 to the piece's out/<film-id>.mp4", () => {
    mkdirSync(film.outDir);
    const run = mkdtempSync(path.join(film.outDir, 'run-'));
    const rendered = path.join(run, 'fixture.mp4');
    writeFileSync(rendered, 'this run');

    const published = publishVideo(film, rendered);

    expect([published, readFileSync(published, 'utf8'), existsSync(rendered)]).toEqual([
      path.join(film.outDir, 'fixture.mp4'),
      'this run',
      false,
    ]);
  });

  it('replaces the MP4 an earlier run published', () => {
    mkdirSync(film.outDir);
    writeFileSync(path.join(film.outDir, 'fixture.mp4'), 'an earlier run');
    const run = mkdtempSync(path.join(film.outDir, 'run-'));
    const rendered = path.join(run, 'fixture.mp4');
    writeFileSync(rendered, 'this run');

    expect(readFileSync(publishVideo(film, rendered), 'utf8')).toBe('this run');
  });
});
