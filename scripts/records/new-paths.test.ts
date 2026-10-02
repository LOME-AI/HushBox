import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { absentDirectories, firstOccupied, removePaths } from './new-paths.js';

let root: string;

function write(relative: string, content = `${relative}\n`): void {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Every entry under `root`, folders marked with a trailing slash. */
function entries(): string[] {
  return readdirSync(root, { recursive: true, withFileTypes: true })
    .map((entry) => {
      const relative = path.relative(root, path.join(entry.parentPath, entry.name));
      return entry.isDirectory() ? `${relative}/` : relative;
    })
    .toSorted((a, b) => a.localeCompare(b));
}

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'records-new-paths-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('firstOccupied', () => {
  it('names nothing when every named path is free', () => {
    write('docs/kept.md');

    expect(firstOccupied(root, ['docs/runs/a/plan.md'])).toBeUndefined();
  });

  it('names a file standing at a named path', () => {
    write('docs/runs/plan.md');

    expect(firstOccupied(root, ['docs/runs/plan.md'])).toBe('docs/runs/plan.md');
  });

  it('names an empty folder standing at a named path', () => {
    mkdirSync(path.join(root, 'docs', 'plan.md'), { recursive: true });

    expect(firstOccupied(root, ['docs/plan.md'])).toBe('docs/plan.md');
  });

  it('names a symbolic link at a named path even when its target does not exist', () => {
    mkdirSync(path.join(root, 'docs'));
    symlinkSync(path.join(root, 'nowhere'), path.join(root, 'docs', 'link.md'));

    expect(firstOccupied(root, ['docs/link.md'])).toBe('docs/link.md');
  });

  it('names a file standing where a folder above a named path would be', () => {
    write('docs/runs');

    expect(firstOccupied(root, ['docs/runs/plan.md'])).toBe('docs/runs');
  });

  it('names the first taken path in the order given', () => {
    write('b/second.md');
    write('a/first.md');

    expect(firstOccupied(root, ['a/first.md', 'b/second.md'])).toBe('a/first.md');
  });

  it('fails on a path it cannot look at', () => {
    write('docs/locked/plan.md');
    chmodSync(path.join(root, 'docs', 'locked'), 0o000);
    try {
      expect(() => firstOccupied(root, ['docs/locked/plan.md'])).toThrow(/EACCES/u);
    } finally {
      chmodSync(path.join(root, 'docs', 'locked'), 0o755);
    }
  });
});

describe('absentDirectories', () => {
  it('names the folders that do not exist, deepest first', () => {
    write('docs/kept.md');

    expect(absentDirectories(root, ['docs/runs/a/plan.md'])).toEqual(['docs/runs/a', 'docs/runs']);
  });

  it('names a folder once however many files sit in it', () => {
    expect(absentDirectories(root, ['docs/a.md', 'docs/b.md'])).toEqual(['docs']);
  });

  it('leaves out a folder path where a file stands', () => {
    write('docs/runs');

    expect(absentDirectories(root, ['docs/runs/plan.md'])).toEqual([]);
  });
});

describe('removePaths', () => {
  it('removes the files it is given and the folders it is given once they are empty', () => {
    write('docs/kept.md');
    write('docs/runs/a/plan.md');
    write('docs/b.md');

    removePaths(root, ['docs/runs/a/plan.md', 'docs/b.md'], ['docs/runs/a', 'docs/runs']);

    expect(entries()).toEqual(['docs/', 'docs/kept.md']);
  });

  it('keeps a folder that holds something else', () => {
    write('docs/runs/plan.md');
    write('docs/runs/other.md');

    removePaths(root, ['docs/runs/plan.md'], ['docs/runs', 'docs']);

    expect(entries()).toEqual(['docs/', 'docs/runs/', 'docs/runs/other.md']);
  });

  it('keeps a folder standing at a file it is given', () => {
    mkdirSync(path.join(root, 'docs', 'plan.md'), { recursive: true });

    removePaths(root, ['docs/plan.md'], []);

    expect(entries()).toEqual(['docs/', 'docs/plan.md/']);
  });

  it('removes a symbolic link without touching its target', () => {
    write('target.md');
    mkdirSync(path.join(root, 'docs'));
    symlinkSync(path.join(root, 'target.md'), path.join(root, 'docs', 'link.md'));

    removePaths(root, ['docs/link.md'], ['docs']);

    expect(entries()).toEqual(['target.md']);
  });

  it('passes over paths that are not there', () => {
    write('docs/runs');

    removePaths(root, ['docs/runs/plan.md', 'docs/other/plan.md'], ['docs/other']);

    expect({ entries: entries(), runs: existsSync(path.join(root, 'docs', 'runs')) }).toEqual({
      entries: ['docs/', 'docs/runs'],
      runs: true,
    });
  });
});
