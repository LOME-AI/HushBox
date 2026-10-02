import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { HELD_CLAIMS_ENV } from '../claims/claim.js';
import { RUN_CLAIM_ENV } from '../claims/registry.js';
import { claimSlot, readSlotClaims } from '../claims/slot-claim.js';
import { composeProjectName, getWorktreeConfig, isComposeProjectOfThisRepo } from './worktree.js';
import { PORT_RANGE, portsFor } from '../stack/port-plan.js';
import { withScratchDirectory } from '../scratch-directory.js';
import { isOutsideRoot } from '../path-containment.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const FIXTURE_PREFIX = 'hushbox-worktree-';

/** Where a linked worktree's git directory sits inside its clone. */
const GITDIR_OF_A_WORKTREE = path.join(
  path.sep,
  'checkouts',
  'repo',
  '.git',
  'worktrees',
  'my-feature'
);

let registryDir: string;

/**
 * Runs one test against a fresh fixture tree, staged outside the repository.
 *
 * `scripts` is a workspace the architecture layer scans whole, so a fixture
 * tree under this file's own directory is a directory ts-morph enumerates: a
 * concurrent scan dies on it mid-life, and one that survives the glob is read
 * as repository source. Location is what closes both, not timing.
 */
function withFixtureTree(body: (fixtureDir: string) => void): () => Promise<void> {
  return () =>
    withScratchDirectory(FIXTURE_PREFIX, (fixtureDir) => {
      body(fixtureDir);
      return Promise.resolve();
    });
}

/** Stages a main checkout: `.git` is a directory, which is also its git directory. */
function stageMainCheckout(dir: string): void {
  mkdirSync(path.join(dir, '.git'), { recursive: true });
}

/** Stages a linked worktree pointing at a git directory that exists. */
function stageWorktree(dir: string, gitDir: string): void {
  mkdirSync(gitDir, { recursive: true });
  writeFileSync(path.join(dir, '.git'), `gitdir: ${gitDir}\n`);
}

/**
 * The tokens this file was invoked under. Both are cleared before every case
 * below, and a hook that puts back an empty string instead leaves every later
 * suite here — and everything else this worker goes on to run — creating
 * resources no claim names.
 */
const inheritedRunClaim = process.env[RUN_CLAIM_ENV];
const inheritedHeldClaims = process.env[HELD_CLAIMS_ENV];

beforeEach(() => {
  // Both tokens are inherited from whatever invoked the suite. Neutralised
  // before the first case rather than after it: a token cleared only in
  // teardown makes the first case fail and every later one pass.
  process.env[RUN_CLAIM_ENV] = '';
  process.env[HELD_CLAIMS_ENV] = '';
  registryDir = mkdtempSync(path.join(os.tmpdir(), 'hushbox-worktree-slots-'));
});

afterEach(() => {
  // Empty string rather than absent: every reader treats an empty token as
  // none, and a computed key cannot be deleted.
  process.env[RUN_CLAIM_ENV] = inheritedRunClaim ?? '';
  process.env[HELD_CLAIMS_ENV] = inheritedHeldClaims ?? '';
  rmSync(registryDir, { recursive: true, force: true });
});

describe('composeProjectName', () => {
  it('names the compose project after the slot, for every checkout alike', () => {
    expect(composeProjectName(0)).toBe('hushbox-0');
    expect(composeProjectName(7)).toBe('hushbox-7');
  });

  it('recognises a compose project of this repository under either scheme', () => {
    expect(isComposeProjectOfThisRepo(composeProjectName(3))).toBe(true);
    expect(isComposeProjectOfThisRepo('hushbox')).toBe(true);
    expect(isComposeProjectOfThisRepo('someone-elses-stack')).toBe(false);
  });
});

describe('getWorktreeConfig', () => {
  it(
    'stages its fixture tree outside the repository',
    withFixtureTree((fixtureDir) => {
      expect(isOutsideRoot(path, REPO_ROOT, fixtureDir)).toBe(true);
    })
  );

  describe('main checkout', () => {
    it(
      'reports it is not a worktree when .git is a directory',
      withFixtureTree((fixtureDir) => {
        stageMainCheckout(fixtureDir);

        expect(getWorktreeConfig(fixtureDir, registryDir).isWorktree).toBe(false);
      })
    );

    it(
      'returns name "main"',
      withFixtureTree((fixtureDir) => {
        stageMainCheckout(fixtureDir);

        expect(getWorktreeConfig(fixtureDir, registryDir).name).toBe('main');
      })
    );

    it(
      'claims a slot like any other checkout rather than being given slot 0',
      withFixtureTree((fixtureDir) => {
        const occupant = path.join(fixtureDir, 'occupant');
        mkdirSync(path.join(occupant, '.git'), { recursive: true });
        claimSlot({
          worktreePath: occupant,
          gitDir: path.join(occupant, '.git'),
          registryDir,
        });
        stageMainCheckout(fixtureDir);

        expect(getWorktreeConfig(fixtureDir, registryDir).slot).toBe(1);
      })
    );

    it(
      'names its compose project after the slot it claimed',
      withFixtureTree((fixtureDir) => {
        stageMainCheckout(fixtureDir);

        const config = getWorktreeConfig(fixtureDir, registryDir);

        expect(config.projectName).toBe(composeProjectName(config.slot));
      })
    );

    it(
      'defaults to process.cwd() when no root directory is given',
      withFixtureTree((fixtureDir) => {
        stageMainCheckout(fixtureDir);
        const originalCwd = process.cwd();
        process.chdir(fixtureDir);
        try {
          expect(getWorktreeConfig(undefined, registryDir)).toEqual(
            getWorktreeConfig(fixtureDir, registryDir)
          );
        } finally {
          process.chdir(originalCwd);
        }
      })
    );

    it(
      'returns the development ports of the slot it claimed',
      withFixtureTree((fixtureDir) => {
        stageMainCheckout(fixtureDir);

        const config = getWorktreeConfig(fixtureDir, registryDir);

        expect(config.ports).toEqual(portsFor({ slot: config.slot, mode: 'development' }));
      })
    );

    it(
      'leaves every service inside the allocated range',
      withFixtureTree((fixtureDir) => {
        stageMainCheckout(fixtureDir);

        const config = getWorktreeConfig(fixtureDir, registryDir);

        for (const port of Object.values(config.ports)) {
          expect(port).toBeGreaterThanOrEqual(PORT_RANGE.first);
          expect(port).toBeLessThanOrEqual(PORT_RANGE.last);
        }
      })
    );
  });

  describe('linked worktree', () => {
    it(
      'reports it is a worktree when .git is a file',
      withFixtureTree((fixtureDir) => {
        stageWorktree(fixtureDir, path.join(fixtureDir, 'gitdir'));

        expect(getWorktreeConfig(fixtureDir, registryDir).isWorktree).toBe(true);
      })
    );

    it(
      'takes its name from the last segment of the gitdir path',
      withFixtureTree((fixtureDir) => {
        writeFileSync(path.join(fixtureDir, '.git'), `gitdir: ${GITDIR_OF_A_WORKTREE}\n`);

        expect(getWorktreeConfig(fixtureDir, registryDir).name).toBe('my-feature');
      })
    );

    it(
      'resolves a relative gitdir against the checkout',
      withFixtureTree((fixtureDir) => {
        mkdirSync(path.join(fixtureDir, 'elsewhere'), { recursive: true });
        writeFileSync(path.join(fixtureDir, '.git'), 'gitdir: ./elsewhere\n');

        expect(getWorktreeConfig(fixtureDir, registryDir).name).toBe('elsewhere');
      })
    );

    it(
      'names its compose project after the slot it claimed',
      withFixtureTree((fixtureDir) => {
        stageWorktree(fixtureDir, path.join(fixtureDir, 'gitdir'));

        const config = getWorktreeConfig(fixtureDir, registryDir);

        expect(config.projectName).toBe(composeProjectName(config.slot));
      })
    );

    it(
      'keeps the slot it was issued across calls',
      withFixtureTree((fixtureDir) => {
        stageWorktree(fixtureDir, path.join(fixtureDir, 'gitdir'));

        expect(getWorktreeConfig(fixtureDir, registryDir).slot).toBe(
          getWorktreeConfig(fixtureDir, registryDir).slot
        );
      })
    );

    it(
      'takes a different slot from a checkout that already holds one',
      withFixtureTree((fixtureDir) => {
        const first = path.join(fixtureDir, 'first');
        const second = path.join(fixtureDir, 'second');
        mkdirSync(first, { recursive: true });
        mkdirSync(second, { recursive: true });
        stageWorktree(first, path.join(fixtureDir, 'gitdirs', 'first'));
        stageWorktree(second, path.join(fixtureDir, 'gitdirs', 'second'));

        expect(getWorktreeConfig(first, registryDir).slot).not.toBe(
          getWorktreeConfig(second, registryDir).slot
        );
      })
    );

    it(
      'records the git directory whose disappearance frees the slot',
      withFixtureTree((fixtureDir) => {
        const gitDir = path.join(fixtureDir, 'gitdir');
        stageWorktree(fixtureDir, gitDir);

        const config = getWorktreeConfig(fixtureDir, registryDir);

        expect(readSlotClaims(registryDir).get(config.slot)?.gitDir).toBe(gitDir);
      })
    );
  });

  describe('error cases', () => {
    it(
      'throws when .git does not exist',
      withFixtureTree((fixtureDir) => {
        expect(() => getWorktreeConfig(fixtureDir, registryDir)).toThrow();
      })
    );

    it(
      'throws when .git file has no gitdir line',
      withFixtureTree((fixtureDir) => {
        writeFileSync(path.join(fixtureDir, '.git'), 'something else\n');

        expect(() => getWorktreeConfig(fixtureDir, registryDir)).toThrow();
      })
    );
  });

  describe('against a real repository', () => {
    /**
     * The freeness predicate reads the checkout's git directory rather than
     * running `git worktree list`, so what has to be shown is that the two
     * answer the same question: git deletes `<common>/worktrees/<name>` in the
     * same act that drops the worktree from its list.
     */
    async function git(cwd: string, args: string[]): Promise<string> {
      const result = await execa('git', args, { cwd });
      return result.stdout;
    }

    async function stageRepository(root: string): Promise<string> {
      const clone = path.join(root, 'clone');
      mkdirSync(clone, { recursive: true });
      await git(clone, ['init', '-q', '-b', 'main']);
      await git(clone, ['config', 'user.email', 'agent@hushbox.ai']);
      await git(clone, ['config', 'user.name', 'agent']);
      await git(clone, ['commit', '-q', '--allow-empty', '-m', 'seed']);
      return clone;
    }

    it('reissues the slot of a worktree git no longer lists, and keeps a listed one', async () => {
      await withScratchDirectory(FIXTURE_PREFIX, async (root) => {
        const clone = await stageRepository(root);
        const departing = path.join(root, 'departing');
        const staying = path.join(root, 'staying');
        await git(clone, ['worktree', 'add', '-q', departing]);
        await git(clone, ['worktree', 'add', '-q', staying]);

        const departingSlot = getWorktreeConfig(departing, registryDir).slot;
        const stayingSlot = getWorktreeConfig(staying, registryDir).slot;
        await git(clone, ['worktree', 'remove', departing]);
        const listed = await git(clone, ['worktree', 'list', '--porcelain']);

        expect(listed).not.toContain(departing);
        expect(listed).toContain(staying);
        const arriving = path.join(root, 'arriving');
        mkdirSync(arriving, { recursive: true });
        await git(clone, ['worktree', 'add', '-q', arriving]);
        expect(getWorktreeConfig(arriving, registryDir).slot).toBe(departingSlot);
        expect(getWorktreeConfig(staying, registryDir).slot).toBe(stayingSlot);
      });
    }, 60_000);
  });
});
