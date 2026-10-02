/**
 * A tree's files as they stand in the working tree. An undo after a failed
 * checkout removes a file only while its bytes are still the tree's, so a file
 * someone else wrote at the same path is never taken for the checkout's.
 */
import { readlinkSync } from 'node:fs';
import path from 'node:path';
import { entryAt } from './new-paths.js';
import { git } from './overlay.js';

export interface TreeFile {
  readonly path: string;
  /** The blob's object name. */
  readonly object: string;
}

/** The blobs of a `git ls-tree -r -z` listing. */
export function treeFiles(listing: string): TreeFile[] {
  return listing
    .split('\0')
    .filter((entry) => entry !== '')
    .flatMap((entry) => {
      const tab = entry.indexOf('\t');
      const [, type = '', object = ''] = entry.slice(0, tab).split(' ');
      return type === 'blob' ? [{ path: entry.slice(tab + 1), object }] : [];
    });
}

/** `file` in the quoted form `hash-object --stdin-paths` unquotes, so any name is one line. */
function quoted(file: string): string {
  const escaped = file
    .replaceAll('\\', String.raw`\\`)
    .replaceAll('"', String.raw`\"`)
    .replaceAll('\n', String.raw`\n`);
  return `"${escaped}"`;
}

/**
 * The paths of `files` whose entry on disk hashes to its blob. A file is hashed
 * both through the work tree's attributes, as a checkout converted it, and as
 * its raw bytes, which is what a checkout wrote when the blob already holds
 * line endings the attributes would change; a symbolic link is hashed by its
 * target, which is what git stores for one.
 */
export async function unchangedFiles(
  root: string,
  gitArguments: readonly string[],
  files: readonly TreeFile[]
): Promise<string[]> {
  const regular = files.filter((file) => entryAt(root, file.path)?.isFile() === true);
  const links = files.filter((file) => entryAt(root, file.path)?.isSymbolicLink() === true);
  const unchanged: string[] = [];
  if (regular.length > 0) {
    const input = `${regular.map((file) => quoted(file.path)).join('\n')}\n`;
    const hash = async (filters: readonly string[]): Promise<string[]> => {
      const hashes = await git(
        root,
        [...gitArguments, 'hash-object', ...filters, '--stdin-paths'],
        'hash the restored files',
        { input }
      );
      return hashes.split('\n');
    };
    const filtered = await hash([]);
    const raw = await hash(['--no-filters']);
    unchanged.push(
      ...regular
        .filter((file, index) => filtered[index] === file.object || raw[index] === file.object)
        .map((file) => file.path)
    );
  }
  for (const link of links) {
    const target = readlinkSync(path.join(root, ...link.path.split('/')), { encoding: 'buffer' });
    const object = await git(
      root,
      [...gitArguments, 'hash-object', '--no-filters', '--stdin'],
      'hash the restored links',
      { input: target }
    );
    if (object === link.object) unchanged.push(link.path);
  }
  return unchanged;
}
