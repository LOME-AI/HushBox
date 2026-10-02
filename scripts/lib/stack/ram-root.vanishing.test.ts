import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ramRootUsedBytes } from './ram-root.js';
import type { Dirent, ObjectEncodingOptions, PathLike } from 'node:fs';

/**
 * The entry the next walk finds gone: removed the moment a directory listing
 * that names it returns, so it is listed and then vanishes before the walk
 * reads it, which is what a run deleting its own output does to a walk.
 *
 * A recursive listing with a doomed directory somewhere under it rejects with
 * `ENOENT` instead, because that is what Node's recursive `readdir` does: it
 * scans each directory it finds, and one that vanishes before its scan fails
 * the whole call.
 */
const vanishing = vi.hoisted((): { entry: string | undefined } => ({ entry: undefined }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const { default: nodePath } = await import('node:path');

  /** Whether `entry` is a directory strictly inside `directory`. */
  async function isDirectoryUnder(entry: string, directory: PathLike): Promise<boolean> {
    const relative = nodePath.relative(String(directory), entry);
    if (relative === '' || relative.startsWith('..') || nodePath.isAbsolute(relative)) {
      return false;
    }
    const stats = await actual.stat(entry);
    return stats.isDirectory();
  }

  return {
    ...actual,
    readdir: async (
      directory: PathLike,
      options: ObjectEncodingOptions & { withFileTypes: true; recursive?: boolean }
    ): Promise<Dirent[]> => {
      const doomed = vanishing.entry;
      if (
        doomed !== undefined &&
        options.recursive === true &&
        (await isDirectoryUnder(doomed, directory))
      ) {
        vanishing.entry = undefined;
        await actual.rm(doomed, { recursive: true, force: true });
        throw Object.assign(new Error(`ENOENT: no such file or directory, scandir '${doomed}'`), {
          code: 'ENOENT',
          syscall: 'scandir',
          path: doomed,
        });
      }
      const entries = await actual.readdir(directory, options);
      const gone = vanishing.entry;
      if (
        gone !== undefined &&
        entries.some((entry) => nodePath.join(entry.parentPath, entry.name) === gone)
      ) {
        vanishing.entry = undefined;
        await actual.rm(gone, { recursive: true, force: true });
      }
      return entries;
    },
  };
});

const MIB = 1024 * 1024;

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'ram-root-vanishing-'));
});

afterEach(() => {
  vanishing.entry = undefined;
  rmSync(root, { recursive: true, force: true });
});

/** Writes `bytes` of data at `relative` under the root, every block of it allocated. */
function writeUnderRoot(relative: string, bytes: number): string {
  const file = path.join(root, relative);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.alloc(bytes, 1));
  return file;
}

/** The space `files` occupy, read straight from the filesystem. */
function allocatedBytes(files: readonly string[]): number {
  return files.reduce((total, file) => total + statSync(file).blocks * 512, 0);
}

describe('the space an E2E RAM root occupies, while a run changes it', () => {
  it('counts every other file when a directory vanishes after its parent is listed', async () => {
    const kept = [
      writeUnderRoot(path.join('persist', 'v3', 'do', 'room.sqlite'), MIB),
      writeUnderRoot(path.join('snapshots', 'web.js'), 2 * MIB),
    ];
    writeUnderRoot(path.join('test-results', 'chat-spec', 'trace.zip'), MIB);
    vanishing.entry = path.join(root, 'test-results', 'chat-spec');

    await expect(ramRootUsedBytes(root)).resolves.toBe(allocatedBytes(kept));
  });

  it('skips a file that vanishes between its listing and its stat', async () => {
    const kept = [writeUnderRoot(path.join('persist', 'v3', 'do', 'room.sqlite'), MIB)];
    const doomed = writeUnderRoot(path.join('test-results', 'trace.zip'), MIB);
    vanishing.entry = doomed;

    await expect(ramRootUsedBytes(root)).resolves.toBe(allocatedBytes(kept));
  });

  it('yields nothing for a root that does not exist', async () => {
    await expect(ramRootUsedBytes(path.join(root, 'never-made'))).resolves.toBe(0);
  });
});
