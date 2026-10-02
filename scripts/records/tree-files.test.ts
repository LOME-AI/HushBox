import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git } from './overlay.js';
import { treeFiles, unchangedFiles, type TreeFile } from './tree-files.js';

let sandbox: string;
let repository: string;
let gitArguments: string[];

function write(relative: string, content = `${relative}\n`): void {
  const file = path.join(repository, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

/** Commits the work tree as it stands and returns the commit's files. */
async function committed(): Promise<TreeFile[]> {
  await git(repository, ['add', '--all']);
  await git(repository, ['commit', '--quiet', '--message', 'files']);
  return treeFiles(await git(repository, ['ls-tree', '-r', '-z', 'HEAD']));
}

/** The files `files` names that still hold the tree's bytes. */
async function unchanged(files: readonly TreeFile[]): Promise<string[]> {
  return unchangedFiles(repository, gitArguments, files);
}

beforeEach(async () => {
  sandbox = mkdtempSync(path.join(tmpdir(), 'records-tree-files-'));
  writeFileSync(
    path.join(sandbox, 'gitconfig'),
    '[user]\n\tname = Records Test\n\temail = records-test@hushbox.ai\n'
  );
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(sandbox, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  repository = path.join(sandbox, 'repository');
  mkdirSync(repository);
  await git(repository, ['init', '--quiet', '--initial-branch=main']);
  gitArguments = [`--git-dir=${path.join(repository, '.git')}`, `--work-tree=${repository}`];
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(sandbox, { recursive: true, force: true });
});

describe('treeFiles', () => {
  it('reads each blob as its path and object name', () => {
    const object = 'a'.repeat(40);

    expect(treeFiles(`100644 blob ${object}\tdocs/plan.md\0`)).toEqual([
      { path: 'docs/plan.md', object },
    ]);
  });

  it('keeps a path holding a tab and a newline whole', () => {
    const object = 'b'.repeat(40);

    expect(treeFiles(`100644 blob ${object}\tdocs/a\tb\nc.md\0`)).toEqual([
      { path: 'docs/a\tb\nc.md', object },
    ]);
  });

  it('leaves out an entry that is not a blob', () => {
    expect(treeFiles(`160000 commit ${'c'.repeat(40)}\tvendor/module\0`)).toEqual([]);
  });
});

describe('unchangedFiles', () => {
  it('names a file that holds the tree bytes', async () => {
    write('docs/plan.md');
    const files = await committed();

    expect(await unchanged(files)).toEqual(['docs/plan.md']);
  });

  it('leaves out a file whose bytes differ from the tree', async () => {
    write('docs/plan.md');
    const files = await committed();
    write('docs/plan.md', 'written by someone else\n');

    expect(await unchanged(files)).toEqual([]);
  });

  it('leaves out a path where nothing stands', async () => {
    write('docs/plan.md');
    const files = await committed();
    rmSync(path.join(repository, 'docs', 'plan.md'));

    expect(await unchanged(files)).toEqual([]);
  });

  it('leaves out a folder standing at a file path', async () => {
    write('docs/plan.md');
    const files = await committed();
    rmSync(path.join(repository, 'docs', 'plan.md'));
    mkdirSync(path.join(repository, 'docs', 'plan.md'));

    expect(await unchanged(files)).toEqual([]);
  });

  it('names a file whose line endings the checkout converted', async () => {
    write('.gitattributes', '*.md text eol=crlf\n');
    write('docs/plan.md', 'one\ntwo\n');
    const files = await committed();
    write('docs/plan.md', 'one\r\ntwo\r\n');

    expect(await unchanged(files)).toContain('docs/plan.md');
  });

  it('names a file whose blob holds line endings the attributes would convert', async () => {
    write('docs/plan.md', 'one\r\ntwo\r\n');
    const files = await committed();
    write('.gitattributes', '* text=auto eol=lf\n');

    expect(await unchanged(files)).toEqual(['docs/plan.md']);
  });

  it('names a file whose name holds a quote, a backslash and a newline', async () => {
    write('docs/a "b" \\c\nd.md');
    const files = await committed();

    expect(await unchanged(files)).toEqual(['docs/a "b" \\c\nd.md']);
  });

  it('names a symbolic link that points where the tree says', async () => {
    mkdirSync(path.join(repository, 'docs'));
    symlinkSync('target.md', path.join(repository, 'docs', 'link.md'));
    const files = await committed();

    expect(await unchanged(files)).toEqual(['docs/link.md']);
  });

  it('leaves out a symbolic link that points elsewhere', async () => {
    mkdirSync(path.join(repository, 'docs'));
    symlinkSync('target.md', path.join(repository, 'docs', 'link.md'));
    const files = await committed();
    rmSync(path.join(repository, 'docs', 'link.md'));
    symlinkSync('elsewhere.md', path.join(repository, 'docs', 'link.md'));

    expect(await unchanged(files)).toEqual([]);
  });
});
