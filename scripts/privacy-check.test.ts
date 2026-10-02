import { afterAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { HOUR_MS, isoAt, secondsAt, TEST_DAY_START } from '@hushbox/shared/test-time';
import { formatGateReport } from './privacy-gate.js';
import { readWorktreeBlobs } from './lib/privacy/worktree.js';
import { CHECK_BATCH_SIZE, resolveScope, runPrivacyCheck, scanInBatches } from './privacy-check.js';
import type { WorktreeReader } from './privacy-check.js';

const CLEAN_TEXT = 'a day, no clock\n';
const DISCLOSING_INSTANT = isoAt(TEST_DAY_START + 14 * HOUR_MS);
const DISCLOSING_TEXT = `recorded ${DISCLOSING_INSTANT}\n`;
const NO_FINDINGS = formatGateReport({ text: [], binary: [] });

/** The marked `.gitignore` block naming the record roots, as every checkout carries it. */
const RECORDS_BLOCK = [
  '# BEGIN records overlay',
  'docs/runs/',
  '/.records.git/',
  '# END records overlay',
  '',
].join('\n');

interface Harness {
  readonly directory: string;
  git: (...args: string[]) => Promise<string>;
  write: (file: string, content: string | Buffer) => Promise<void>;
  commit: (message: string) => Promise<void>;
}

const workspaces: string[] = [];

afterAll(async () => {
  await Promise.all(workspaces.map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function harness(): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-check-'));
  workspaces.push(directory);
  const git = async (...args: string[]): Promise<string> => {
    const result = await execa('git', ['-C', directory, ...args]);
    return result.stdout.trim();
  };
  const write = async (file: string, content: string | Buffer): Promise<void> => {
    const absolute = path.join(directory, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  };
  const commit = async (message: string): Promise<void> => {
    const stamp = `@${String(secondsAt(TEST_DAY_START))} +0000`;
    await execa('git', ['-C', directory, 'commit', '-qm', message], {
      env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    });
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'agent@hushbox.ai');
  await git('config', 'user.name', 'agent');
  return { directory, git, write, commit };
}

/** A worktree whose `.gitignore` carries the records block after `otherRules`. */
async function checkoutHarness(otherRules = ''): Promise<Harness> {
  const repo = await harness();
  await repo.write('.gitignore', `${otherRules}${RECORDS_BLOCK}`);
  return repo;
}

/** A worktree whose `.gitignore` carries the records block beside an ordinary ignore rule. */
async function recordsHarness(): Promise<Harness> {
  const repo = await checkoutHarness('*.md.lock\n');
  await repo.write('notes.md', CLEAN_TEXT);
  return repo;
}

/** A worktree holding one more file than a single batch covers. */
async function crowdedHarness(): Promise<{ repo: Harness; names: string[] }> {
  const repo = await harness();
  const names = Array.from(
    { length: CHECK_BATCH_SIZE + 1 },
    (_unused, index) => `f/${String(index).padStart(4, '0')}.md`
  );
  await fs.mkdir(path.join(repo.directory, 'f'), { recursive: true });
  await Promise.all(
    names.map(async (name, index) =>
      fs.writeFile(
        path.join(repo.directory, name),
        index === names.length - 1 ? DISCLOSING_TEXT : CLEAN_TEXT
      )
    )
  );
  return { repo, names };
}

describe('resolveScope', () => {
  const paths = ['docs/notes.md', 'docsy.md', 'scripts/run.ts'];

  it('takes every enumerated path when no argument is given', () => {
    expect(resolveScope(paths, [])).toEqual({ paths, unmatched: [] });
  });

  it('takes the one path an exact file argument names', () => {
    expect(resolveScope(paths, ['docs/notes.md']).paths).toEqual(['docs/notes.md']);
  });

  it('takes every path under a directory argument', () => {
    expect(resolveScope(paths, ['docs']).paths).toEqual(['docs/notes.md']);
  });

  it('leaves out a sibling whose name merely starts with the argument', () => {
    expect(resolveScope(paths, ['docs']).paths).not.toContain('docsy.md');
  });

  it('accepts the trailing separator a shell completes a directory with', () => {
    expect(resolveScope(paths, [`docs${path.sep}`]).paths).toEqual(['docs/notes.md']);
  });

  it('names an argument that matched nothing, as the caller typed it', () => {
    expect(resolveScope(paths, ['docs', 'absent/']).unmatched).toEqual(['absent/']);
  });

  it('takes every enumerated path when an argument names the repository root', () => {
    expect(resolveScope(paths, ['.']).paths).toEqual(paths);
  });

  it('leaves the repository root unrefused, though it names no enumerated path itself', () => {
    expect(resolveScope(paths, ['.']).unmatched).toEqual([]);
  });
});

describe('the working-tree check', () => {
  it('passes a working tree that discloses nothing', async () => {
    const repo = await checkoutHarness();
    await repo.write('notes.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(0);
  });

  it('reports through the gate s own findings text, unchanged', async () => {
    const repo = await checkoutHarness();
    await repo.write('notes.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.report.endsWith(NO_FINDINGS)).toBe(true);
  });

  it('opens with a line naming the working tree and the number of files examined', async () => {
    const repo = await checkoutHarness();
    await repo.write('notes.md', CLEAN_TEXT);
    await repo.write('deep/other.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 3 file(s) examined across the whole working tree, staged or not.'
    );
  });

  it('finds a violation in an untracked file nobody has staged', async () => {
    const repo = await checkoutHarness();
    await repo.write('untracked.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('untracked.md');
  });

  it('leaves the same violation unread in a gitignored file', async () => {
    const repo = await checkoutHarness('ignored.md\n');
    await repo.write('ignored.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(0);
  });

  it('judges the bytes on disk rather than the ones the commit carries', async () => {
    const repo = await checkoutHarness();
    await repo.write('notes.md', CLEAN_TEXT);
    await repo.git('add', 'notes.md');
    await repo.commit('clean');
    await repo.write('notes.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(1);
  });

  it('leaves a violation outside a directory argument unread', async () => {
    const repo = await harness();
    await repo.write('docs/notes.md', CLEAN_TEXT);
    await repo.write('other/notes.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['docs']);

    expect(outcome.code).toBe(0);
  });

  it('names the arguments a scoped run examined, so its clean result cannot read as a whole-tree one', async () => {
    const repo = await harness();
    await repo.write('docs/notes.md', CLEAN_TEXT);
    await repo.write('other/notes.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['docs']);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 1 file(s) examined in the working tree under docs, staged or not.'
    );
  });

  it('scans the one file an exact file argument names', async () => {
    const repo = await harness();
    await repo.write('docs/notes.md', DISCLOSING_TEXT);
    await repo.write('other/notes.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['docs/notes.md']);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('docs/notes.md');
  });

  it('stops on an argument naming nothing the worktree holds, rather than passing on zero files', async () => {
    const repo = await harness();
    await repo.write('notes.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['absent']);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('absent');
    expect(outcome.report).not.toContain(NO_FINDINGS);
  });

  it('refuses an argument reaching outside the repository, as one naming nothing', async () => {
    const repo = await harness();
    await repo.write('notes.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['../elsewhere.md']);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('named nothing the working tree holds');
  });

  it('refuses an absolute argument outside the repository, as one naming nothing', async () => {
    const repo = await harness();
    await repo.write('notes.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, [path.join(os.tmpdir(), 'elsewhere.md')]);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('named nothing the working tree holds');
  });

  it('refuses an argument reaching through a symbolic link, as one naming nothing', async () => {
    const repo = await harness();
    await repo.write('kept/notes.md', CLEAN_TEXT);
    await fs.symlink('kept', path.join(repo.directory, 'link'));

    const outcome = await runPrivacyCheck(repo.directory, ['link/notes.md']);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('named nothing the working tree holds');
  });

  it('honours an allowlist entry the worktree file carries and nobody staged', async () => {
    const repo = await checkoutHarness();
    await repo.write('notes.md', DISCLOSING_TEXT);
    await repo.write(
      'privacy-allowlist.json',
      JSON.stringify({
        entries: [
          {
            clause: 'provenance',
            description: 'third-party capture',
            path: 'notes.md',
            literals: [DISCLOSING_INSTANT],
          },
        ],
      })
    );

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(0);
  });

  it('admits a binary blob the worktree allowlist claims as third-party without blocking', async () => {
    const repo = await checkoutHarness();
    // A GIF89a header whose comment extension carries a clock the gate reads.
    const comment = Buffer.from(`recorded ${DISCLOSING_INSTANT}`, 'latin1');
    await repo.write(
      'shot.gif',
      Buffer.concat([
        Buffer.from('GIF89a', 'latin1'),
        Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
        Buffer.from([0x21, 0xfe, comment.length]),
        comment,
        Buffer.from([0x00, 0x3b]),
      ])
    );
    await repo.write(
      'privacy-allowlist.json',
      JSON.stringify({
        entries: [{ clause: 'provenance', description: 'third-party artifact', path: 'shot.gif' }],
      })
    );

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(0);
    expect(outcome.report).toContain('shot.gif');
  });

  it('blocks on a binary blob no allowlist entry admits', async () => {
    const repo = await checkoutHarness();
    const comment = Buffer.from(`recorded ${DISCLOSING_INSTANT}`, 'latin1');
    await repo.write(
      'shot.gif',
      Buffer.concat([
        Buffer.from('GIF89a', 'latin1'),
        Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
        Buffer.from([0x21, 0xfe, comment.length]),
        comment,
        Buffer.from([0x00, 0x3b]),
      ])
    );

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(1);
  });
});

describe('a path argument naming files git ignores', () => {
  /** A worktree whose `.gitignore` ignores a directory holding one disclosing file. */
  async function ignoringHarness(): Promise<Harness> {
    const repo = await harness();
    await repo.write('.gitignore', 'records/\n');
    await repo.write('kept/notes.md', CLEAN_TEXT);
    await repo.write('records/notes.md', DISCLOSING_TEXT);
    return repo;
  }

  it('examines an ignored file the argument names', async () => {
    const repo = await ignoringHarness();

    const outcome = await runPrivacyCheck(repo.directory, ['records/notes.md']);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 1 file(s) examined in the working tree under records/notes.md, staged or not.'
    );
  });

  it('reports the finding an ignored file the argument names carries', async () => {
    const repo = await ignoringHarness();

    const outcome = await runPrivacyCheck(repo.directory, ['records/notes.md']);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('records/notes.md:1:');
  });

  it('examines every file under an ignored directory the argument names', async () => {
    const repo = await ignoringHarness();
    await repo.write('records/deep/other.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['records']);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 2 file(s) examined in the working tree under records, staged or not.'
    );
  });

  it('examines a directory argument inside an ignored directory', async () => {
    const repo = await ignoringHarness();
    await repo.write('records/deep/other.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['records/deep']);

    expect(outcome.report).toContain('records/deep/other.md:1:');
  });

  it('examines a file argument git ignores by its own name', async () => {
    const repo = await ignoringHarness();
    await repo.write('.gitignore', '*.log\n');
    await repo.write('kept/debug.log', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['kept/debug.log']);

    expect(outcome.report).toContain('kept/debug.log:1:');
  });

  it('leaves an ignored subtree unread under a directory argument git does not ignore', async () => {
    const repo = await ignoringHarness();
    await repo.write('.gitignore', 'node_modules/\n');
    await repo.write('kept/node_modules/vendored.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['kept']);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 1 file(s) examined in the working tree under kept, staged or not.'
    );
  });

  it('reports no finding from an ignored subtree under a directory argument git does not ignore', async () => {
    const repo = await ignoringHarness();
    await repo.write('.gitignore', 'node_modules/\n');
    await repo.write('kept/node_modules/vendored.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['kept']);

    expect(outcome.code).toBe(0);
  });

  it('refuses an argument naming nothing on disk under an ignored directory', async () => {
    const repo = await ignoringHarness();

    const outcome = await runPrivacyCheck(repo.directory, ['records/absent.md']);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('named nothing the working tree holds');
  });

  it('keeps the ignored directory out of a run with no arguments', async () => {
    const repo = await ignoringHarness();
    await repo.write('.gitignore', `records/\n${RECORDS_BLOCK}`);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 2 file(s) examined across the whole working tree, staged or not.'
    );
  });

  it('keeps the ignored directory out of a run naming the repository root', async () => {
    const repo = await ignoringHarness();
    await repo.write('.gitignore', `records/\n${RECORDS_BLOCK}`);

    const outcome = await runPrivacyCheck(repo.directory, ['.']);

    expect(outcome.code).toBe(0);
  });

  it('honours an allowlist entry for an ignored file the argument names', async () => {
    const repo = await ignoringHarness();
    await repo.write(
      'privacy-allowlist.json',
      JSON.stringify({
        entries: [
          {
            clause: 'provenance',
            description: 'third-party capture',
            path: 'records/notes.md',
            literals: [DISCLOSING_INSTANT],
          },
        ],
      })
    );

    const outcome = await runPrivacyCheck(repo.directory, ['records/notes.md']);

    expect(outcome.code).toBe(0);
  });

  it('blocks on a binary blob in an ignored file the argument names', async () => {
    const repo = await ignoringHarness();
    const comment = Buffer.from(`recorded ${DISCLOSING_INSTANT}`, 'latin1');
    await repo.write(
      'records/shot.gif',
      Buffer.concat([
        Buffer.from('GIF89a', 'latin1'),
        Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
        Buffer.from([0x21, 0xfe, comment.length]),
        comment,
        Buffer.from([0x00, 0x3b]),
      ])
    );

    const outcome = await runPrivacyCheck(repo.directory, ['records/shot.gif']);

    expect(outcome.code).toBe(1);
    expect(outcome.report).not.toContain('named nothing the working tree holds');
  });
});

describe('the record files in a run with no arguments', () => {
  it('reports the finding a record file carries', async () => {
    const repo = await recordsHarness();
    await repo.write('docs/runs/plan.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('docs/runs/plan.md');
  });

  it('counts the record files among the files examined', async () => {
    const repo = await recordsHarness();
    await repo.write('docs/runs/plan.md', CLEAN_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 3 file(s) examined across the whole working tree, staged or not.'
    );
  });

  it('examines a record file the repository also tracks once', async () => {
    const repo = await recordsHarness();
    await repo.write('docs/runs/plan.md', CLEAN_TEXT);
    await repo.git('add', '--force', 'docs/runs/plan.md');

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 3 file(s) examined across the whole working tree, staged or not.'
    );
  });

  it('leaves a finding unread in a file another ignore rule excludes from the record roots', async () => {
    const repo = await recordsHarness();
    await repo.write('docs/runs/plan.md', CLEAN_TEXT);
    await repo.write('docs/runs/plan.md.lock', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, []);

    expect(outcome.code).toBe(0);
  });

  it('fails in a checkout whose .gitignore lacks the records block', async () => {
    const repo = await harness();
    await repo.write('.gitignore', 'ignored.md\n');
    await repo.write('notes.md', CLEAN_TEXT);

    await expect(runPrivacyCheck(repo.directory, [])).rejects.toThrow('records overlay');
  });

  it('fails in a checkout with no .gitignore', async () => {
    const repo = await harness();
    await repo.write('notes.md', CLEAN_TEXT);

    await expect(runPrivacyCheck(repo.directory, [])).rejects.toThrow('.gitignore');
  });

  it('leaves the record files out of a run naming a path', async () => {
    const repo = await recordsHarness();
    await repo.write('docs/runs/plan.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['notes.md']);

    expect(outcome.code).toBe(0);
  });
});

describe('the record files in a run naming the repository root', () => {
  it('reports the finding a record file carries', async () => {
    const repo = await recordsHarness();
    await repo.write('docs/runs/plan.md', DISCLOSING_TEXT);

    const outcome = await runPrivacyCheck(repo.directory, ['.']);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('docs/runs/plan.md');
  });

  it('examines as many files as a run with no arguments', async () => {
    const repo = await recordsHarness();
    await repo.write('docs/runs/plan.md', CLEAN_TEXT);

    const rooted = await runPrivacyCheck(repo.directory, ['.']);
    const whole = await runPrivacyCheck(repo.directory, []);

    expect(rooted.report.split('\n')[0]).toMatch(/^Privacy check: 3 file\(s\) examined /u);
    expect(whole.report.split('\n')[0]).toMatch(/^Privacy check: 3 file\(s\) examined /u);
  });

  it('examines a record file the repository also tracks once', async () => {
    const repo = await recordsHarness();
    await repo.write('docs/runs/plan.md', CLEAN_TEXT);
    await repo.git('add', '--force', 'docs/runs/plan.md');

    const outcome = await runPrivacyCheck(repo.directory, ['.']);

    expect(outcome.report.split('\n')[0]).toBe(
      'Privacy check: 3 file(s) examined in the working tree under ., staged or not.'
    );
  });

  it('fails in a checkout whose .gitignore lacks the records block', async () => {
    const repo = await harness();
    await repo.write('.gitignore', 'ignored.md\n');
    await repo.write('notes.md', CLEAN_TEXT);

    await expect(runPrivacyCheck(repo.directory, ['.'])).rejects.toThrow('records overlay');
  });
});

describe('scanInBatches', () => {
  it('reads the path set one bounded batch at a time', async () => {
    const { repo, names } = await crowdedHarness();
    const asked: number[] = [];
    const recording: WorktreeReader = async (root, paths) => {
      asked.push(paths.length);
      return readWorktreeBlobs(root, paths);
    };

    await scanInBatches(repo.directory, names, [], recording);

    expect(asked).toEqual([CHECK_BATCH_SIZE, 1]);
  });

  it('collects a finding from a batch past the first', async () => {
    const { repo, names } = await crowdedHarness();

    const scan = await scanInBatches(repo.directory, names, [], readWorktreeBlobs);

    expect(scan.findings.text.map((finding) => finding.path)).toContain(names.at(-1));
    expect(scan.examined).toBe(names.length);
  });
});
