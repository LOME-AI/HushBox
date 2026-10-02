import { readdirSync } from 'node:fs';
import path from 'node:path';

/** The files a piece (a film, an engine fixture or a take) is made of. */
const PIECE_FILE = /^(?:composition\.tsx|film\.ts|score\.ts|look\.[jt]s)$/;

/** Whether a segment of a path stops it being a POSIX-separated path that stays under its root. */
function strays(segment: string): boolean {
  return segment === '' || segment === '.' || segment === '..' || segment.includes('\\');
}

/**
 * The modules of each piece in `directories` (POSIX-separated, under the package
 * `root`), keyed as the registry's module context keys them, `./<dir>/<file>`,
 * each mapped to its path on disk. Only each listed directory's own files are
 * read, so a piece nested inside a listed one, and every directory no piece
 * holds, stays out.
 */
export function pieceModuleMap(
  root: string,
  directories: readonly string[]
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const dir of directories) {
    const segments = dir.split('/');
    if (segments.some((segment) => strays(segment))) {
      throw new Error(`${JSON.stringify(dir)} is not a directory under the films package`);
    }
    const directory = path.join(root, ...segments);
    const files = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PIECE_FILE.test(entry.name))
      .map((entry) => entry.name)
      .toSorted((a, b) => a.localeCompare(b));
    for (const file of files) {
      map[`./${dir}/${file}`] = path.join(directory, file);
    }
  }
  return map;
}
