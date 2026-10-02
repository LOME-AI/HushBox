import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryFileSystemHost, Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule from './compiled-output-stays-out-of-source-trees.rule.js';
import type { FileSystemHost, RuntimeDirEntry } from 'ts-morph';

/**
 * The rule walks the repository off the project's file system and asks git
 * which of what it finds is tracked, so a fixture writes real paths under
 * {@link REPO_ROOT} into an in-memory file system and lets the git half read
 * the checkout it is actually running in. A fixture path the checkout does not
 * hold is untracked there, which is the state the rule reports; a fixture path
 * the checkout does hold tracked is the state it must pass over.
 */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  const fileSystem = project.getFileSystem();
  for (const [relative, contents] of Object.entries(files)) {
    fileSystem.writeFileSync(path.join(REPO_ROOT, relative), contents);
  }
  return project;
}

/**
 * Every file-system member passed through to an inner host, so each double
 * below overrides only the listing behaviour it exists to change.
 */
class DelegatingHost implements FileSystemHost {
  constructor(protected readonly inner: FileSystemHost) {}
  readDirSync(dirPath: string): RuntimeDirEntry[] {
    return this.inner.readDirSync(dirPath);
  }
  directoryExistsSync(dirPath: string): boolean {
    return this.inner.directoryExistsSync(dirPath);
  }
  isCaseSensitive(): boolean {
    return this.inner.isCaseSensitive();
  }
  delete(filePath: string): Promise<void> {
    return this.inner.delete(filePath);
  }
  deleteSync(filePath: string): void {
    this.inner.deleteSync(filePath);
  }
  readFile(filePath: string, encoding?: string): Promise<string> {
    return this.inner.readFile(filePath, encoding);
  }
  readFileSync(filePath: string, encoding?: string): string {
    return this.inner.readFileSync(filePath, encoding);
  }
  writeFile(filePath: string, text: string): Promise<void> {
    return this.inner.writeFile(filePath, text);
  }
  writeFileSync(filePath: string, text: string): void {
    this.inner.writeFileSync(filePath, text);
  }
  mkdir(dirPath: string): Promise<void> {
    return this.inner.mkdir(dirPath);
  }
  mkdirSync(dirPath: string): void {
    this.inner.mkdirSync(dirPath);
  }
  move(source: string, destination: string): Promise<void> {
    return this.inner.move(source, destination);
  }
  moveSync(source: string, destination: string): void {
    this.inner.moveSync(source, destination);
  }
  copy(source: string, destination: string): Promise<void> {
    return this.inner.copy(source, destination);
  }
  copySync(source: string, destination: string): void {
    this.inner.copySync(source, destination);
  }
  fileExists(filePath: string): Promise<boolean> {
    return this.inner.fileExists(filePath);
  }
  fileExistsSync(filePath: string): boolean {
    return this.inner.fileExistsSync(filePath);
  }
  directoryExists(dirPath: string): Promise<boolean> {
    return this.inner.directoryExists(dirPath);
  }
  realpathSync(filePath: string): string {
    return this.inner.realpathSync(filePath);
  }
  getCurrentDirectory(): string {
    return this.inner.getCurrentDirectory();
  }
  glob(patterns: readonly string[]): Promise<string[]> {
    return this.inner.glob(patterns);
  }
  globSync(patterns: readonly string[]): string[] {
    return this.inner.globSync(patterns);
  }
}

/** Refuses one directory read, standing in for a directory lost mid-walk. */
class RefusingDirectoryHost extends DelegatingHost {
  constructor(
    inner: FileSystemHost,
    private readonly refused: string,
    private readonly stillThere: boolean
  ) {
    super(inner);
  }
  override readDirSync(dirPath: string): RuntimeDirEntry[] {
    if (dirPath === this.refused) throw new Error('ENOTDIR: the walk lost this directory');
    return super.readDirSync(dirPath);
  }
  override directoryExistsSync(dirPath: string): boolean {
    return dirPath === this.refused ? this.stillThere : super.directoryExistsSync(dirPath);
  }
}

/** Adds one entry to one real directory listing, planting nothing on disk. */
class PlantingHost extends DelegatingHost {
  constructor(
    inner: FileSystemHost,
    private readonly directory: string,
    protected readonly planted: string
  ) {
    super(inner);
  }
  override readDirSync(dirPath: string): RuntimeDirEntry[] {
    const entries = super.readDirSync(dirPath);
    if (dirPath !== this.directory) return entries;
    return [...entries, { name: this.planted, isFile: true, isDirectory: false, isSymlink: false }];
  }
}

/** Plants the same entry as something that is neither a file nor a directory. */
class LinkListingHost extends PlantingHost {
  override readDirSync(dirPath: string): RuntimeDirEntry[] {
    return super
      .readDirSync(dirPath)
      .map((entry) =>
        entry.name === this.planted ? { ...entry, isFile: false, isSymlink: true } : entry
      );
  }
}

function projectRefusing(
  files: Record<string, string>,
  refused: string,
  stillThere: boolean
): Project {
  const inner = new InMemoryFileSystemHost();
  for (const [relative, contents] of Object.entries(files)) {
    inner.writeFileSync(path.join(REPO_ROOT, relative), contents);
  }
  const host = new RefusingDirectoryHost(inner, path.join(REPO_ROOT, refused), stillThere);
  return new Project({ fileSystem: host });
}

/** This file's own directory and the rule source beside it — derived, never spelled out. */
const OWN_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const RULE_SOURCE = fileURLToPath(import.meta.url).replace('.test.ts', '.ts');
const PLANTED_EMIT = RULE_SOURCE.replace(/\.ts$/, '.js');

describe('compiled-output-stays-out-of-source-trees', () => {
  it('reports an untracked compiled sibling of a TypeScript source', () => {
    const project = projectWith({
      'alpha/src/thing.ts': 'export const thing = 1;\n',
      'alpha/src/thing.js': 'export const thing = 1;\n',
    });

    expect(rule.check(project)).toEqual([
      {
        file: 'alpha/src/thing.js',
        line: 1,
        message:
          "alpha/src/thing.js is compiler output for alpha/src/thing.ts and is untracked. An emitted file beside its own source wins module resolution over that source and matches anything selecting files by their shape, so tools read the compiler's copy where the source was meant to be read and report the result as a defect in unrelated code. Delete it, then give whatever wrote it an output directory outside the source tree.",
      },
    ]);
  });

  it('accepts the same source once the compiled sibling is gone', () => {
    const project = projectWith({ 'alpha/src/thing.ts': 'export const thing = 1;\n' });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a module source that has no TypeScript sibling', () => {
    const project = projectWith({
      'alpha/src/entry.mjs': 'export const entry = 1;\n',
      'alpha/src/tool.js': 'module.exports = {};\n',
      'alpha/src/kinds.d.ts': 'declare const kinds: string;\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('accepts a generated sibling the repository tracks', () => {
    const project = projectWith({
      'packages/config/eslint.config.js': 'export default [];\n',
      'packages/config/eslint.config.ts': 'export default [];\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports the declaration and map shapes a compiler writes beside a source', () => {
    const project = projectWith({
      'alpha/src/thing.ts': 'export const thing = 1;\n',
      'alpha/src/thing.d.ts': 'export declare const thing: number;\n',
      'alpha/src/thing.js.map': '{}\n',
    });

    expect(rule.check(project).map((violation) => violation.file)).toEqual([
      'alpha/src/thing.d.ts',
      'alpha/src/thing.js.map',
    ]);
  });

  it('reports the emit shapes of the TSX, MTS and CTS spellings', () => {
    const project = projectWith({
      'alpha/src/view.tsx': 'export const view = 1;\n',
      'alpha/src/view.jsx': 'export const view = 1;\n',
      'alpha/src/mod.mts': 'export const mod = 1;\n',
      'alpha/src/mod.mjs': 'export const mod = 1;\n',
      'alpha/src/legacy.cts': 'export const legacy = 1;\n',
      'alpha/src/legacy.cjs': 'exports.legacy = 1;\n',
    });

    expect(rule.check(project).map((violation) => violation.file)).toEqual([
      'alpha/src/legacy.cjs',
      'alpha/src/mod.mjs',
      'alpha/src/view.jsx',
    ]);
  });

  it('passes over a directory version control ignores whole', () => {
    const project = projectWith({
      'node_modules/pkg/index.ts': 'export const pkg = 1;\n',
      'node_modules/pkg/index.js': 'export const pkg = 1;\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('tolerates a directory lost between being listed and being read', () => {
    const project = projectRefusing(
      {
        'alpha/src/thing.ts': 'export const thing = 1;\n',
        'alpha/gone/thing.ts': 'export const thing = 1;\n',
        'alpha/gone/thing.js': 'export const thing = 1;\n',
      },
      'alpha/gone',
      false
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('fails on a directory that refused the read and is still there', () => {
    const project = projectRefusing(
      { 'alpha/src/thing.ts': 'export const thing = 1;\n' },
      'alpha/src',
      true
    );

    expect(() => rule.check(project)).toThrow('ENOTDIR');
  });

  it('passes over an entry that is neither a file nor a directory', () => {
    const project = new Project({
      fileSystem: new LinkListingHost(new Project({}).getFileSystem(), OWN_DIRECTORY, PLANTED_EMIT),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('finds no compiled output beside a source in this repository', () => {
    const project = new Project({ skipAddingFilesFromTsConfig: true });

    expect(rule.check(project)).toEqual([]);
  });

  it('reaches a real source tree, so finding nothing there is a scan and not an omission', () => {
    const project = new Project({
      fileSystem: new PlantingHost(new Project({}).getFileSystem(), OWN_DIRECTORY, PLANTED_EMIT),
    });

    expect(rule.check(project).map((violation) => violation.file)).toEqual([
      path.relative(REPO_ROOT, PLANTED_EMIT),
    ]);
  });
});
