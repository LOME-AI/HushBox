import { afterAll, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { HOUR_MS, SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  batchEntries,
  repositoryRoot,
  runPrivacySweep,
  SWEEP_BATCH_SIZE,
} from './privacy-sweep.js';
import type { IndexEntry } from './lib/privacy/verify-content-privacy.js';

const CONFORMING_SECONDS = TEST_DAY_START / SECOND_MS;
const DISCLOSING_INSTANT = new Date(TEST_DAY_START + 14 * HOUR_MS).toISOString();

interface Harness {
  readonly directory: string;
  git: (...args: string[]) => Promise<string>;
  write: (file: string, content: string | Buffer) => Promise<void>;
  commit: (message: string) => Promise<string>;
}

const workspaces: string[] = [];

afterAll(async () => {
  await Promise.all(workspaces.map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
});

async function harness(): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-sweep-'));
  workspaces.push(directory);
  const git = async (...args: string[]): Promise<string> => {
    const result = await execa('git', args, { cwd: directory });
    return result.stdout.trim();
  };
  const write = async (file: string, content: string | Buffer): Promise<void> => {
    const absolute = path.join(directory, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  };
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'agent@hushbox.ai');
  await git('config', 'user.name', 'agent');
  await write('privacy-allowlist.json', JSON.stringify({ entries: [] }));
  await git('add', 'privacy-allowlist.json');
  const commit = async (message: string): Promise<string> => {
    const stamp = `@${String(CONFORMING_SECONDS)} +0000`;
    await execa('git', ['commit', '-qm', message], {
      cwd: directory,
      env: { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp },
    });
    return git('rev-parse', 'HEAD');
  };
  return { directory, git, write, commit };
}

describe('repositoryRoot', () => {
  it('resolves the checkout root from this module s own directory', () => {
    expect(repositoryRoot(path.resolve('checkout', 'scripts'))).toBe(path.resolve('checkout'));
  });
});

describe('batchEntries', () => {
  const entry = (index: number): IndexEntry => ({ objectId: String(index), path: String(index) });

  it('keeps a run shorter than the batch size in one batch', () => {
    expect(batchEntries([entry(1), entry(2)], 3)).toEqual([[entry(1), entry(2)]]);
  });

  it('splits a run longer than the batch size', () => {
    expect(batchEntries([entry(1), entry(2), entry(3)], 2)).toEqual([
      [entry(1), entry(2)],
      [entry(3)],
    ]);
  });

  it('answers no batches for nothing to read', () => {
    expect(batchEntries([], 4)).toEqual([]);
  });
});

describe('the sweep', () => {
  it('passes a committed tree that discloses nothing', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const commit = await repo.commit('clean');

    await expect(runPrivacySweep(repo.directory, commit)).resolves.toMatchObject({ code: 0 });
  });

  it('blocks on a disclosing file anywhere in the committed tree', async () => {
    const repo = await harness();
    await repo.write('deep/nested/notes.md', `recorded ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'deep/nested/notes.md');
    const commit = await repo.commit('disclosing');

    const outcome = await runPrivacySweep(repo.directory, commit);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('deep/nested/notes.md');
  });

  it('judges the committed tree rather than the worktree', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const commit = await repo.commit('clean');
    await repo.write('notes.md', `recorded ${DISCLOSING_INSTANT}\n`);

    await expect(runPrivacySweep(repo.directory, commit)).resolves.toMatchObject({ code: 0 });
  });

  it('blocks on a violation the worktree no longer carries', async () => {
    const repo = await harness();
    await repo.write('notes.md', `recorded ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const commit = await repo.commit('disclosing');
    await fs.rm(path.join(repo.directory, 'notes.md'));

    await expect(runPrivacySweep(repo.directory, commit)).resolves.toMatchObject({ code: 1 });
  });

  it('reads the allowlist from the swept commit, never from the index', async () => {
    const repo = await harness();
    await repo.write('notes.md', `recorded ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const commit = await repo.commit('disclosing');
    await repo.write(
      'privacy-allowlist.json',
      JSON.stringify({
        entries: [
          {
            description: 'staged, never committed',
            path: 'notes.md',
            literals: [DISCLOSING_INSTANT],
          },
        ],
      })
    );
    await repo.git('add', 'privacy-allowlist.json');

    await expect(runPrivacySweep(repo.directory, commit)).resolves.toMatchObject({ code: 1 });
  });

  it('honours the allowlist the swept commit carries', async () => {
    const repo = await harness();
    await repo.write('notes.md', `recorded ${DISCLOSING_INSTANT}\n`);
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
    await repo.git('add', 'notes.md', 'privacy-allowlist.json');
    const commit = await repo.commit('exempted');

    await expect(runPrivacySweep(repo.directory, commit)).resolves.toMatchObject({ code: 0 });
  });

  it('examines one blob at every path it sits at, not at whichever git names', async () => {
    const repo = await harness();
    const disclosing = `recorded ${DISCLOSING_INSTANT}\n`;
    await repo.write('archive/notes.md', disclosing);
    await repo.write('live/notes.md', disclosing);
    await repo.git('add', 'archive/notes.md', 'live/notes.md');
    const commit = await repo.commit('same bytes, two paths');

    const outcome = await runPrivacySweep(repo.directory, commit);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('live/notes.md');
    expect(outcome.report).toContain('archive/notes.md');
  });

  it('reads past the first batch', async () => {
    const repo = await harness();
    const paths = Array.from({ length: SWEEP_BATCH_SIZE + 1 }, (_unused, index) =>
      String(index).padStart(4, '0')
    );
    for (const [index, name] of paths.entries()) {
      const last = index === paths.length - 1;
      await repo.write(`f/${name}.md`, last ? `recorded ${DISCLOSING_INSTANT}\n` : 'a day\n');
    }
    await repo.git('add', 'f');
    const commit = await repo.commit('many');

    const outcome = await runPrivacySweep(repo.directory, commit);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(`f/${String(paths.at(-1))}.md`);
  });

  it('reports a binary blob the stripper must clean', async () => {
    const repo = await harness();
    // A GIF89a header whose comment extension carries a clock the gate reads.
    const comment = Buffer.from(`recorded ${DISCLOSING_INSTANT}`, 'latin1');
    const gif = Buffer.concat([
      Buffer.from('GIF89a', 'latin1'),
      Buffer.from([0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00]),
      Buffer.from([0x21, 0xfe, comment.length]),
      comment,
      Buffer.from([0x00, 0x3b]),
    ]);
    await repo.write('shot.gif', gif);
    await repo.git('add', 'shot.gif');
    const commit = await repo.commit('binary');

    const outcome = await runPrivacySweep(repo.directory, commit);

    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('shot.gif');
  });
});
