import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, overlayDirectory, overlayGit } from './overlay.js';
import { listRecordFiles } from './record-files.js';

/** The repository's own `.gitignore`, so every rule the checkout ships is in force. */
const SHIPPED_GITIGNORE = readFileSync(
  path.join(import.meta.dirname, '..', '..', '.gitignore'),
  'utf8'
);

let root: string;
let home: string;

function write(relative: string, content = `${relative}\n`): void {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

beforeEach(async () => {
  home = mkdtempSync(path.join(tmpdir(), 'records-home-'));
  writeFileSync(path.join(home, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(home, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('XDG_CONFIG_HOME', path.join(home, 'xdg'));
  root = mkdtempSync(path.join(tmpdir(), 'records-files-'));
  await git(root, ['init', '--quiet']);
  write('.gitignore', SHIPPED_GITIGNORE);
  await git(root, ['init', '--bare', '--quiet', overlayDirectory(root)]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function listed(): Promise<string[]> {
  return listRecordFiles(root, overlayDirectory(root));
}

describe('listRecordFiles', () => {
  it('lists a file under each record root', async () => {
    write('docs/runs/run-a/plan.md');
    write('docs/history/OLD-PLAN.md');
    write('docs/audits/audit-a/findings/F-1.md');

    expect(await listed()).toEqual([
      'docs/audits/audit-a/findings/F-1.md',
      'docs/history/OLD-PLAN.md',
      'docs/runs/run-a/plan.md',
    ]);
  });

  it('leaves out the audits guide beside the audit folders', async () => {
    write('docs/audits/CLAUDE.md');

    expect(await listed()).toEqual([]);
  });

  it('leaves out a file outside the record roots', async () => {
    write('docs/CODE-RULES.md');
    write('notes.md');

    expect(await listed()).toEqual([]);
  });

  it('leaves out a lock file another rule ignores', async () => {
    write('docs/audits/audit-a/findings/F-1.md.lock');

    expect(await listed()).toEqual([]);
  });

  it('leaves out a log file another rule ignores', async () => {
    write('docs/runs/run-a/agent.log');

    expect(await listed()).toEqual([]);
  });

  it('leaves out a file under a local directory another rule ignores', async () => {
    write('docs/runs/run-a/scratch.local/notes.md');

    expect(await listed()).toEqual([]);
  });

  it('leaves out a record-root directory that another rule also ignores', async () => {
    write('docs/audits/audit-a.local/notes.md');

    expect(await listed()).toEqual([]);
  });

  it('leaves out a file a nested ignore file excludes', async () => {
    write('docs/runs/run-a/.gitignore', 'private.md\n');
    write('docs/runs/run-a/private.md');

    expect(await listed()).toEqual(['docs/runs/run-a/.gitignore']);
  });

  it("leaves out a file the main repository's exclude file names", async () => {
    write('.git/info/exclude', 'docs/history/excluded.md\n');
    write('docs/history/excluded.md');

    expect(await listed()).toEqual([]);
  });

  it('reads a main repository that has no exclude file', async () => {
    rmSync(path.join(root, '.git', 'info'), { recursive: true, force: true });
    write('docs/history/OLD-PLAN.md');

    expect(await listed()).toEqual(['docs/history/OLD-PLAN.md']);
  });

  it('reads the record patterns from the block, whatever they name', async () => {
    write(
      '.gitignore',
      '# BEGIN records overlay\n*-notes/\n/.records.git/\n# END records overlay\n'
    );
    write('team-notes/week.md');
    write('docs/runs/run-a/plan.md');

    expect(await listed()).toEqual(['team-notes/week.md']);
  });

  it('leaves out a file the overlay already tracks', async () => {
    write('docs/runs/run-a/plan.md');
    await overlayGit(root, ['add', '--force', '--', 'docs/runs/run-a/plan.md']);

    expect(await listed()).toEqual([]);
  });

  it("leaves out a record root the main repository's exclude file names", async () => {
    write('.git/info/exclude', 'docs/history/\n');
    write('docs/history/OLD-PLAN.md');
    write('docs/runs/run-a/plan.md');

    expect(await listed()).toEqual(['docs/runs/run-a/plan.md']);
  });

  it('leaves out an audit folder a nested ignore file above it names', async () => {
    write('docs/audits/.gitignore', '2026-03-03/\n');
    write('docs/audits/2026-03-03/findings/F-1.md');
    write('docs/audits/2026-07-30/findings/F-1.md');

    expect(await listed()).toEqual(['docs/audits/2026-07-30/findings/F-1.md']);
  });

  it('lists a file a nested ignore file re-includes against a rule outside the block', async () => {
    write('docs/runs/run-a/.gitignore', '!keep.log\n');
    write('docs/runs/run-a/keep.log');
    write('docs/runs/run-a/other.log');

    expect(await listed()).toEqual(['docs/runs/run-a/.gitignore', 'docs/runs/run-a/keep.log']);
  });

  it("reads the user exclude file the main repository's config names", async () => {
    write('.git/user-exclude', '*.draft.md\n');
    await git(root, ['config', 'core.excludesFile', path.join(root, '.git', 'user-exclude')]);
    write('docs/runs/run-a/plan.draft.md');
    write('docs/runs/run-a/plan.md');

    expect(await listed()).toEqual(['docs/runs/run-a/plan.md']);
  });

  it('reads the default user exclude file when no config names one', async () => {
    mkdirSync(path.join(home, 'xdg', 'git'), { recursive: true });
    writeFileSync(path.join(home, 'xdg', 'git', 'ignore'), '*.draft.md\n');
    write('docs/runs/run-a/plan.draft.md');
    write('docs/runs/run-a/plan.md');

    expect(await listed()).toEqual(['docs/runs/run-a/plan.md']);
  });

  it("matches case as the main repository's config says", async () => {
    await git(root, ['config', 'core.ignoreCase', 'true']);
    write('docs/runs/run-a/.gitignore', '*.DRAFT\n');
    write('docs/runs/run-a/plan.draft');

    expect(await listed()).toEqual(['docs/runs/run-a/.gitignore']);
  });

  it('lists a file under a record root spelled in another case when the main repository folds case', async () => {
    await git(root, ['config', 'core.ignoreCase', 'true']);
    write('Docs/Runs/r/upper.md');
    write('docs/runs/r/plan.md');

    expect(await listed()).toEqual(['Docs/Runs/r/upper.md', 'docs/runs/r/plan.md']);
  });

  it('does not read a nested ignore file that is a symbolic link, as git does not', async () => {
    write('elsewhere/rules', 'private.md\n');
    mkdirSync(path.join(root, 'docs', 'runs', 'run-a'), { recursive: true });
    symlinkSync(
      path.join(root, 'elsewhere', 'rules'),
      path.join(root, 'docs', 'runs', 'run-a', '.gitignore')
    );
    write('docs/runs/run-a/private.md');

    expect(await listed()).toEqual(['docs/runs/run-a/.gitignore', 'docs/runs/run-a/private.md']);
  });

  it("fails naming git's message when the main repository's config is broken", async () => {
    write('docs/runs/run-a/plan.md');
    await git(root, ['config', 'core.ignoreCase', 'not-a-boolean']);

    await expect(listed()).rejects.toThrow(/^records: .+ failed: .*not-a-boolean/u);
  });

  it('reads the exclude file when git makes repositories from an empty template', async () => {
    mkdirSync(path.join(home, 'empty-template'));
    writeFileSync(
      path.join(home, 'gitconfig'),
      `[init]\n\ttemplateDir = ${path.join(home, 'empty-template')}\n`
    );
    write('.git/info/exclude', 'docs/history/\n');
    write('docs/history/OLD-PLAN.md');
    write('docs/runs/run-a/plan.md');

    expect(await listed()).toEqual(['docs/runs/run-a/plan.md']);
  });
});
