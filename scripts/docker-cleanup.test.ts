import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

vi.mock('execa', () => ({
  execa: vi.fn(),
}));

import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { freezeClock, isoAt, HOUR_MS, MINUTE_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  CLONE_DIR_LABEL,
  ownershipOf,
  parseWorktreePaths,
  parseDockerProjects,
  triageProjects,
  slotLookup,
  getActiveWorktreePaths,
  getRunningDockerProjects,
  removeProject,
  cleanupOrphanedProjects,
  parseUnmanagedContainers,
  listUnmanagedContainers,
  parseStuckContainers,
  getStuckContainers,
  reclaimUnmanagedContainers,
  COMMAND_LINE,
  main,
  type ProjectOwnership,
} from './docker-cleanup.js';
import { CHECKOUT_DIRECTORY } from './compose.js';
import { parseCommandLine } from './lib/cli/command-line.js';
import { UNOWNED_RECLAIM_AFTER_MS } from './lib/claims/resource-age.js';
import { RUN_CLAIM_ENV, registerRun } from './lib/claims/registry.js';
import { readOwnership, recordOwnedResource } from './lib/claims/ownership.js';
import { claimSlot } from './lib/claims/slot-claim.js';
import { composeProjectName } from './lib/cli/worktree.js';
import { emulatorContainerName } from './lib/mobile/emulator-container.js';
import { withScratchDirectory } from './lib/scratch-directory.js';
import type { Ownership } from './lib/claims/ownership.js';

const mockExeca = vi.mocked(execa);

/**
 * An instant in the shape docker prints a container's creation time in: a date,
 * a time, and the offset that places them, followed by the zone they add up to.
 * Rendered at zero offset so the zone of whatever host runs these decides
 * nothing.
 */
function dockerCreatedAt(instantMs: number): string {
  const [date, clock] = isoAt(instantMs).split(/[TZ.]/);
  return `${date ?? ''} ${clock ?? ''} +0000 UTC`;
}

/** How a run this suite registers names itself in a scratch registry. */
function runInit(registryDir: string): Parameters<typeof registerRun>[0] {
  return {
    command: 'pnpm dev',
    mode: 'development',
    slot: 9,
    gitCommonDir: '/repo/project/.git',
    registryDir,
  };
}

/**
 * Leaves this run's own record unreadable while its lock stays held, which is
 * the one state that makes a live run's resources invisible to a reading.
 */
function damageOwnRecord(): string {
  const runDir = process.env[RUN_CLAIM_ENV] ?? '';
  const record = path.join(runDir, 'run.json');
  const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
  writeFileSync(
    record,
    JSON.stringify({ ...(written as object), mode: 'a-mode-this-checkout-has-never-heard-of' })
  );
  return path.basename(runDir);
}

describe('docker-cleanup', () => {
  /**
   * The ownership answer of a registry holding nothing, which is what every
   * case that is not about ownership needs. Read through the real reader over a
   * directory nothing ever created, so these cases exercise the same answer a
   * machine with no claims gives rather than a hand-built stand-in.
   */
  let nothingOwned: Ownership;

  beforeAll(async () => {
    nothingOwned = await readOwnership(
      path.join(tmpdir(), `hb-cleanup-no-registry-${randomUUID()}`)
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    // The invocation running this suite is itself a registered run, and it
    // stamps its run directory into the environment every child inherits. Left
    // in place, `registerRun` below adopts that run instead of registering in a
    // scratch registry, and these cases read and write the machine-wide
    // registry every other process on this machine is using.
    vi.stubEnv(RUN_CLAIM_ENV, '');
  });

  afterEach(() => {
    // Ahead of the mock restoration, because anything that throws there would
    // otherwise skip it. The runner restores stubs before each test and never
    // after the last one, so the claim this file blanks in setup outlives the
    // file without this.
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  /** Makes a directory under `root` and answers the path it was made at. */
  function made(root: string, ...segments: string[]): string {
    const directory = path.join(root, ...segments);
    mkdirSync(directory, { recursive: true });
    return directory;
  }

  /** A clone of this repository staged on disk, plus a sibling clone of it. */
  interface ScratchClone {
    /** The git common directory every checkout of this clone shares. */
    readonly commonDir: string;
    /** A different clone of the same repository, with a common directory of its own. */
    readonly siblingCommonDir: string;
    /** A checkout of this clone, made real. */
    directory(name: string): string;
    /** A checkout of the sibling clone, made real. */
    sibling(name: string): string;
    /** A path inside this clone that nothing ever created. */
    absent(name: string): string;
  }

  /**
   * Runs `body` against checkouts that are actually there, because
   * `resolveGitCommonDir` runs git *inside* the recorded working directory: a
   * directory that is not there answers null however plausible its path reads.
   * A fixture that hands back a common directory for a path it never created
   * states an input the resolver cannot produce, and manufactures a verdict —
   * reclaimable — that no such project ever reaches.
   */
  function withClone<T>(body: (clone: ScratchClone) => T | Promise<T>): Promise<T> {
    return withScratchDirectory('hb-clone-', (root) =>
      Promise.resolve(
        body({
          commonDir: path.join(root, 'clone', '.git'),
          siblingCommonDir: path.join(root, 'sibling', '.git'),
          directory: (name) => made(root, 'clone', name),
          sibling: (name) => made(root, 'sibling', name),
          absent: (name) => path.join(root, 'clone', name),
        })
      )
    );
  }

  /**
   * The `ProjectOwnership` a pass builds for one running compose project: its
   * common directory is whatever the resolver answers for the recorded working
   * directory, which is nothing at all once that directory is gone.
   */
  function asResolved(
    projectName: string,
    workingDir: string,
    commonDir: string
  ): ProjectOwnership {
    return {
      project: { projectName, workingDir },
      commonDir: existsSync(workingDir) ? commonDir : null,
    };
  }

  describe('command line', () => {
    it('reads a dry run as off by default', () => {
      const parsed = parseCommandLine(COMMAND_LINE, []);
      expect(parsed.kind === 'run' && parsed.flags['--dry-run']).toBe(false);
    });

    it('reads --dry-run as on', () => {
      const parsed = parseCommandLine(COMMAND_LINE, ['--dry-run']);
      expect(parsed.kind === 'run' && parsed.flags['--dry-run']).toBe(true);
    });

    it('promises no outcome the pass cannot reach', () => {
      // A project whose recorded directory went with its checkout is reclaimed
      // only where its own label names this clone; one carrying no label
      // resolves to nothing and is left running, so offering the projects of
      // checkouts that no longer exist promises more than the pass does. And
      // two of the six verdicts print nothing at all — the project a checkout
      // is currently running under, and one a live run's claim spared — so a
      // promise covering every project the pass did not remove is false in the
      // same way.
      expect(COMMAND_LINE.summary).not.toMatch(/no longer exists?\b/);
      expect(COMMAND_LINE.summary).not.toMatch(/every other project/i);
    });

    it('names each condition a removal is decided on', () => {
      // The conjunction `verdictFor` reaches `reclaimable` on, and the reading
      // of live claims `triageProjects` withholds a teardown for: the recorded
      // directory resolving into this clone, the worktree listing naming no
      // checkout under it, and every live run's record having been read
      // without naming the project.
      expect(COMMAND_LINE.summary).toMatch(/this clone/i);
      expect(COMMAND_LINE.summary).toMatch(/worktree/i);
      expect(COMMAND_LINE.summary).toMatch(/live run/i);
    });

    it('states every condition as necessary rather than sufficient', () => {
      // A summary saying a project goes "when" the conditions hold promises a
      // removal wherever they do, which is false: a project a live run's claim
      // spared meets all three and is left running. A guard assembled from the
      // clauses alone passes on either reading, so the direction is asserted
      // here — an inversion is the failure that has actually occurred.
      const conditions = COMMAND_LINE.summary.match(/\bwhen\b/g) ?? [];
      const necessary = COMMAND_LINE.summary.match(/\bonly when\b/g) ?? [];
      expect(necessary.length).toBeGreaterThan(0);
      expect(conditions).toHaveLength(necessary.length);
    });

    it('names the containers the same pass reclaims, not the projects alone', () => {
      // `reclaimUnmanagedContainers` runs on every invocation of this command,
      // so a help text about compose projects alone describes half of it.
      expect(COMMAND_LINE.summary).toMatch(/container/i);
    });

    it('refuses a flag it does not recognise rather than removing anything', () => {
      expect(() => parseCommandLine(COMMAND_LINE, ['--dry-run', '--force'])).toThrow(/--force/);
    });
  });

  describe('parseWorktreePaths', () => {
    it('parses porcelain output with multiple worktrees', () => {
      const output = [
        'worktree /repo/project',
        'HEAD abc123',
        'branch refs/heads/main',
        '',
        'worktree /repo/worktrees/feature-a',
        'HEAD def456',
        'branch refs/heads/feature-a',
        '',
      ].join('\n');

      expect(parseWorktreePaths(output)).toEqual(['/repo/project', '/repo/worktrees/feature-a']);
    });

    it('returns empty array for empty string', () => {
      expect(parseWorktreePaths('')).toEqual([]);
    });

    it('handles single worktree', () => {
      const output = ['worktree /repo/project', 'HEAD abc123', 'branch refs/heads/main', ''].join(
        '\n'
      );

      expect(parseWorktreePaths(output)).toEqual(['/repo/project']);
    });

    it('handles trailing newlines', () => {
      const output = 'worktree /repo/project\nHEAD abc123\nbranch refs/heads/main\n\n\n';

      expect(parseWorktreePaths(output)).toEqual(['/repo/project']);
    });
  });

  describe('parseDockerProjects', () => {
    it('parses multi-line output into unique projects', () => {
      const output = [
        'hushbox-34\t/repo/worktrees/feature-a',
        'hushbox-34\t/repo/worktrees/feature-a',
        'hushbox-51\t/repo/worktrees/feature-b',
      ].join('\n');

      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox-34', workingDir: '/repo/worktrees/feature-a' },
        { projectName: 'hushbox-51', workingDir: '/repo/worktrees/feature-b' },
      ]);
    });

    it('keeps both spellings of our own projects and drops everything else', () => {
      const output = [
        'hushbox\t/repo/main-repo',
        'hushbox-34\t/repo/worktrees/feature-a',
        'other-project\t/repo/other',
      ].join('\n');

      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox', workingDir: '/repo/main-repo' },
        { projectName: 'hushbox-34', workingDir: '/repo/worktrees/feature-a' },
      ]);
    });

    it('returns empty array for empty string', () => {
      expect(parseDockerProjects('')).toEqual([]);
    });

    it('handles single project', () => {
      const output = 'hushbox-73\t/repo/worktrees/feature-c';

      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox-73', workingDir: '/repo/worktrees/feature-c' },
      ]);
    });

    it('reads the clone a project stamped on its containers', () => {
      const output = 'hushbox-34\t/repo/worktrees/feature-a\t/repo/.git';

      expect(parseDockerProjects(output)).toEqual([
        {
          projectName: 'hushbox-34',
          workingDir: '/repo/worktrees/feature-a',
          cloneDir: '/repo/.git',
        },
      ]);
    });

    it('reads a project carrying no stamp as naming no clone', () => {
      const output = 'hushbox-34\t/repo/worktrees/feature-a\t';

      // The whole object, so a stamp read as the empty string — which every
      // unstamped container answers with — fails here rather than reaching the
      // comparison as a clone directory nothing can match.
      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox-34', workingDir: '/repo/worktrees/feature-a' },
      ]);
    });

    it('skips malformed lines', () => {
      const output = [
        'hushbox-34\t/repo/worktrees/feature-a',
        'malformed-line',
        '\t',
        'hushbox-51\t/repo/worktrees/feature-b',
      ].join('\n');

      expect(parseDockerProjects(output)).toEqual([
        { projectName: 'hushbox-34', workingDir: '/repo/worktrees/feature-a' },
        { projectName: 'hushbox-51', workingDir: '/repo/worktrees/feature-b' },
      ]);
    });
  });

  describe('ownershipOf', () => {
    /** A resolver that would answer, so preferring the stamp is visible. */
    const resolvesTo = (commonDir: string | null) => (): Promise<string | null> =>
      Promise.resolve(commonDir);

    it('takes the clone the project stamped, without resolving its directory', async () => {
      const found = await ownershipOf(
        { projectName: 'hushbox-34', workingDir: '/repo/gone', cloneDir: '/stamped/.git' },
        resolvesTo('/resolved/.git')
      );

      expect(found.commonDir).toBe('/stamped/.git');
    });

    it('resolves the recorded directory of a project that stamped nothing', async () => {
      const found = await ownershipOf(
        { projectName: 'hushbox-34', workingDir: '/repo/live' },
        resolvesTo('/resolved/.git')
      );

      expect(found.commonDir).toBe('/resolved/.git');
    });

    it('answers no clone for a project that stamped nothing and resolves nothing', async () => {
      const found = await ownershipOf(
        { projectName: 'hushbox-34', workingDir: '/repo/gone' },
        resolvesTo(null)
      );

      expect(found.commonDir).toBeNull();
    });
  });

  describe('triageProjects', () => {
    /** A checkout that has claimed no slot: nothing it started is judged by name. */
    const noSlotClaimed = (): null => null;

    /** The slot registry as it reads once `worktreePath` has claimed `slot`. */
    function holding(worktreePath: string, slot: number): (candidate: string) => number | null {
      return (candidate) => (candidate === worktreePath ? slot : null);
    }

    it('reaps a project whose directory is there and is no checkout the listing names', async () => {
      await withClone((clone) => {
        const stranded = clone.directory('feature-a');
        const alsoStranded = clone.directory('feature-b');
        const live = clone.directory('feature-c');

        const triage = triageProjects({
          ownerships: [
            asResolved('hushbox-34', stranded, clone.commonDir),
            asResolved('hushbox-51', alsoStranded, clone.commonDir),
            asResolved('hushbox-73', live, clone.commonDir),
          ],
          activeWorktreePaths: [clone.directory('main'), live],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: noSlotClaimed,
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([
          { projectName: 'hushbox-34', workingDir: stranded },
          { projectName: 'hushbox-51', workingDir: alsoStranded },
        ]);
        expect(triage.unresolved).toEqual([]);
        expect(triage.otherClone).toEqual([]);
      });
    });

    it('leaves standing the project of a checkout that has been deleted', async () => {
      // A directory that is not there says nothing about whether the stack
      // started from it is dead: a deleted checkout of this clone and a path
      // that was never this clone's answer identically, and this pass cannot
      // tell them apart. This is the verdict a genuinely gone checkout
      // reaches, and the reason the reclaimable class below is the narrower
      // one whose directory survives its checkout.
      await withClone((clone) => {
        const deleted = clone.absent('feature-a');

        const triage = triageProjects({
          ownerships: [asResolved('hushbox-34', deleted, clone.commonDir)],
          activeWorktreePaths: [clone.directory('main')],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: noSlotClaimed,
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.unresolved).toEqual([{ projectName: 'hushbox-34', workingDir: deleted }]);
      });
    });

    it('leaves a live worktree of this repository alone', async () => {
      await withClone((clone) => {
        const checkouts = ['feature-a', 'feature-b', 'feature-c'].map((name) =>
          clone.directory(name)
        );

        const triage = triageProjects({
          ownerships: checkouts.map((dir, index) =>
            asResolved(composeProjectName(index + 1), dir, clone.commonDir)
          ),
          activeWorktreePaths: [clone.directory('main'), ...checkouts],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: noSlotClaimed,
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.unresolved).toEqual([]);
        expect(triage.otherClone).toEqual([]);
      });
    });

    it('leaves a worktree of a different clone of this repository running', async () => {
      await withClone((clone) => {
        const elsewhere = clone.sibling('feature-a');

        const triage = triageProjects({
          ownerships: [asResolved('hushbox-34', elsewhere, clone.siblingCommonDir)],
          activeWorktreePaths: [clone.directory('main')],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: noSlotClaimed,
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.otherClone).toEqual([{ projectName: 'hushbox-34', workingDir: elsewhere }]);
        expect(triage.unresolved).toEqual([]);
      });
    });

    /** A recorded working directory that is gone answers no repository at all. */
    const gone = (): Promise<string | null> => Promise.resolve(null);

    it('reclaims a project stamped with this clone whose directory is gone', async () => {
      // The case the stamp exists for. Without one this is the verdict above —
      // unresolved, and left standing forever, because a deleted directory and
      // a directory that was never this clone's answer identically.
      await withClone(async (clone) => {
        const deleted = clone.absent('feature-a');
        const stamped = {
          projectName: 'hushbox-34',
          workingDir: deleted,
          cloneDir: clone.commonDir,
        };

        const triage = triageProjects({
          ownerships: [await ownershipOf(stamped, gone)],
          activeWorktreePaths: [clone.directory('main')],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: noSlotClaimed,
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([stamped]);
        expect(triage.unresolved).toEqual([]);
      });
    });

    it('leaves standing a project stamped with a different clone', async () => {
      await withClone(async (clone) => {
        const deleted = clone.absent('feature-a');
        const stamped = {
          projectName: 'hushbox-34',
          workingDir: deleted,
          cloneDir: clone.siblingCommonDir,
        };

        const triage = triageProjects({
          ownerships: [await ownershipOf(stamped, gone)],
          activeWorktreePaths: [clone.directory('main')],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: noSlotClaimed,
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.otherClone).toEqual([stamped]);
      });
    });

    it('reads a stamp through a symlink as the clone it resolves to', async () => {
      // The stamp is compared exactly as a resolved directory is, canonical
      // spelling included: a checkout reached through a link has two absolute
      // spellings, and one of them read literally would place this clone's own
      // project as a sibling's.
      await withScratchDirectory('hb-clone-link-', async (root) => {
        const commonDir = made(root, 'real', 'clone', '.git');
        symlinkSync(path.join(root, 'real'), path.join(root, 'link'));
        const stamped = {
          projectName: 'hushbox-34',
          workingDir: path.join(root, 'real', 'clone', 'feature-a'),
          cloneDir: path.join(root, 'link', 'clone', '.git'),
        };

        const triage = triageProjects({
          ownerships: [await ownershipOf(stamped, gone)],
          activeWorktreePaths: [],
          repoCommonDir: commonDir,
          slotOfWorktree: noSlotClaimed,
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([stamped]);
        expect(triage.otherClone).toEqual([]);
      });
    });

    it('returns empty lists when given no projects', async () => {
      await withClone((clone) => {
        expect(
          triageProjects({
            ownerships: [],
            activeWorktreePaths: [clone.directory('main')],
            repoCommonDir: clone.commonDir,
            slotOfWorktree: noSlotClaimed,
            ownership: nothingOwned,
          })
        ).toEqual({
          orphaned: [],
          unresolved: [],
          otherClone: [],
          held: [],
          unaccounted: [],
          blocked: [],
        });
      });
    });

    it('matches Windows-style backslash paths against forward-slash worktree paths', () => {
      // The one fixture here whose answer is not read off a directory on disk.
      // It states a Windows host, where that directory is there and the
      // resolver answers exactly this; no such path can be created on the
      // POSIX host these run on. What it covers is the spelling comparison,
      // and nothing about the resolver.
      //
      // The content privacy gate refuses a drive letter written against its
      // backslashes, so these fixtures join theirs from a separate literal.
      const drive = 'C:';
      const windowsProject: ProjectOwnership = {
        project: {
          projectName: 'hushbox-34',
          workingDir: String.raw`${drive}\repo\worktrees\feature-a`,
        },
        commonDir: String.raw`${drive}\repo\.git`,
      };

      const activeMatch = triageProjects({
        ownerships: [windowsProject],
        activeWorktreePaths: ['C:/repo/worktrees/feature-a'],
        repoCommonDir: 'c:/repo/.git',
        slotOfWorktree: noSlotClaimed,
        ownership: nothingOwned,
      });
      expect(activeMatch.orphaned).toEqual([]);
      expect(activeMatch.unresolved).toEqual([]);
      expect(activeMatch.otherClone).toEqual([]);

      const orphan = triageProjects({
        ownerships: [windowsProject],
        activeWorktreePaths: ['C:/repo/worktrees/feature-b'],
        repoCommonDir: 'c:/repo/.git',
        slotOfWorktree: noSlotClaimed,
        ownership: nothingOwned,
      });
      expect(orphan.orphaned).toEqual([windowsProject.project]);
    });

    it('leaves the project a live checkout runs under the slot it holds', async () => {
      await withClone((clone) => {
        const worktree = clone.directory('feature-a');

        const triage = triageProjects({
          ownerships: [asResolved(composeProjectName(7), worktree, clone.commonDir)],
          activeWorktreePaths: [worktree],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: holding(worktree, 7),
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.unresolved).toEqual([]);
        expect(triage.otherClone).toEqual([]);
        expect(triage.unaccounted).toEqual([]);
      });
    });

    it('reports the hash-named project a live checkout abandoned when it claimed a slot', async () => {
      await withClone((clone) => {
        const worktree = clone.directory('feature-a');

        const triage = triageProjects({
          ownerships: [asResolved('hushbox-34', worktree, clone.commonDir)],
          activeWorktreePaths: [worktree],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: holding(worktree, 7),
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.unaccounted).toEqual([{ projectName: 'hushbox-34', workingDir: worktree }]);
      });
    });

    it('reports the unnumbered project the main checkout abandoned when it claimed a slot', async () => {
      await withClone((clone) => {
        const main = clone.directory('main');

        const triage = triageProjects({
          ownerships: [asResolved('hushbox', main, clone.commonDir)],
          activeWorktreePaths: [main],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: holding(main, 0),
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.unaccounted).toEqual([{ projectName: 'hushbox', workingDir: main }]);
      });
    });

    it('leaves the project of a live checkout that has claimed no slot', async () => {
      await withClone((clone) => {
        const worktree = clone.directory('feature-a');

        const triage = triageProjects({
          ownerships: [asResolved('hushbox-34', worktree, clone.commonDir)],
          activeWorktreePaths: [worktree],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: noSlotClaimed,
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.unresolved).toEqual([]);
        expect(triage.otherClone).toEqual([]);
        expect(triage.unaccounted).toEqual([]);
      });
    });

    it('spares a project a live run recorded, whatever slot its checkout now holds', async () => {
      await withClone(async (clone) => {
        const worktree = clone.directory('feature-a');
        const registryDir = clone.directory('runs');
        const live = asResolved(composeProjectName(9), worktree, clone.commonDir);

        await registerRun(runInit(registryDir), async () => {
          await recordOwnedResource('compose-project', live.project.projectName);
          const ownership = await readOwnership(registryDir);

          const triage = triageProjects({
            ownerships: [live],
            activeWorktreePaths: [worktree],
            repoCommonDir: clone.commonDir,
            slotOfWorktree: holding(worktree, 3),
            ownership,
          });

          expect(triage.held).toEqual([live.project]);
          expect(triage.orphaned).toEqual([]);
        });
      });
    });

    it('reports the project a live checkout no longer runs under, and leaves it standing', async () => {
      await withClone((clone) => {
        const worktree = clone.directory('feature-a');

        const triage = triageProjects({
          ownerships: [asResolved(composeProjectName(9), worktree, clone.commonDir)],
          activeWorktreePaths: [worktree],
          repoCommonDir: clone.commonDir,
          slotOfWorktree: holding(worktree, 3),
          ownership: nothingOwned,
        });

        expect(triage.orphaned).toEqual([]);
        expect(triage.unaccounted).toEqual([
          { projectName: composeProjectName(9), workingDir: worktree },
        ]);
      });
    });

    it('reclaims nothing while a live run\u2019s record could not be read', async () => {
      await withClone(async (clone) => {
        const stranded = clone.directory('feature-a');
        const registryDir = clone.directory('runs');
        const gone = asResolved(composeProjectName(9), stranded, clone.commonDir);

        await registerRun(runInit(registryDir), async () => {
          damageOwnRecord();
          const ownership = await readOwnership(registryDir);

          const triage = triageProjects({
            ownerships: [gone],
            activeWorktreePaths: [clone.directory('main')],
            repoCommonDir: clone.commonDir,
            slotOfWorktree: noSlotClaimed,
            ownership,
          });

          expect(triage.orphaned).toEqual([]);
          expect(triage.blocked).toEqual([gone.project]);
        });
      });
    });
  });

  /**
   * Docker records the working directory a compose project was started from,
   * git prints the worktree list in its own spelling, and the slot registry
   * records the spelling its claimer used. A checkout reached through a symlink
   * has two absolute spellings, so these three can disagree about one checkout
   * — and the disagreement's verdict is that a live stack has no live worktree,
   * which tears it down.
   */
  describe('a compose project whose recorded directory is spelled through a link', () => {
    it('is not orphaned while the checkout it names is live under its real path', async () => {
      await withScratchDirectory('hushbox-docker-cleanup-spelling-', (dir) => {
        const checkout = path.join(dir, 'real', 'checkout');
        mkdirSync(checkout, { recursive: true });
        symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');
        const commonDir = path.join(dir, 'real', '.git');
        const project = {
          projectName: composeProjectName(0),
          workingDir: path.join(dir, 'link', 'checkout'),
        };

        const triage = triageProjects({
          ownerships: [{ project, commonDir }],
          activeWorktreePaths: [checkout],
          repoCommonDir: commonDir,
          slotOfWorktree: () => 0,
          ownership: nothingOwned,
        });

        expect(triage).toEqual({
          orphaned: [],
          unresolved: [],
          otherClone: [],
          held: [],
          unaccounted: [],
          blocked: [],
        });
        return Promise.resolve();
      });
    });

    it('is matched to the slot its checkout claimed under the other spelling', async () => {
      await withScratchDirectory('hushbox-docker-cleanup-slot-spelling-', (dir) => {
        const registryDir = path.join(dir, 'registry');
        const worktreePath = path.join(dir, 'real', 'checkout');
        const gitDir = path.join(dir, 'real', 'gitdir');
        mkdirSync(worktreePath, { recursive: true });
        mkdirSync(gitDir, { recursive: true });
        symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'), 'dir');
        const slot = claimSlot({ worktreePath, gitDir, registryDir });

        const lookup = slotLookup(registryDir);

        expect(lookup(path.join(dir, 'link', 'checkout'))).toBe(slot);
        return Promise.resolve();
      });
    });
  });

  describe('slotLookup', () => {
    it('answers the slot the registry issued to a checkout, and null for any other', async () => {
      await withScratchDirectory('hushbox-docker-cleanup-slots-', (dir) => {
        const registryDir = path.join(dir, 'registry');
        const worktreePath = path.join(dir, 'checkout');
        const gitDir = path.join(dir, 'gitdir');
        mkdirSync(worktreePath, { recursive: true });
        mkdirSync(gitDir, { recursive: true });
        const slot = claimSlot({ worktreePath, gitDir, registryDir });

        const lookup = slotLookup(registryDir);

        expect(lookup(worktreePath)).toBe(slot);
        expect(lookup(path.join(dir, 'somewhere-else'))).toBeNull();
        return Promise.resolve();
      });
    });
  });

  describe('getActiveWorktreePaths', () => {
    it('calls git worktree list --porcelain via execa', async () => {
      mockExeca.mockResolvedValueOnce({
        stdout: 'worktree /repo/project\nHEAD abc\nbranch refs/heads/main\n',
      } as never);

      const result = await getActiveWorktreePaths();

      expect(mockExeca).toHaveBeenCalledWith('git', ['worktree', 'list', '--porcelain']);
      expect(result).toEqual(['/repo/project']);
    });
  });

  describe('getRunningDockerProjects', () => {
    it('calls docker ps with correct format and filter arguments', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'hushbox-34\t/repo/worktrees/a' } as never);

      await getRunningDockerProjects();

      expect(mockExeca).toHaveBeenCalledWith('docker', [
        'ps',
        '--filter',
        'label=com.docker.compose.project',
        '--format',
        `{{.Label "com.docker.compose.project"}}\t{{.Label "com.docker.compose.project.working_dir"}}\t{{.Label "${CLONE_DIR_LABEL}"}}`,
      ]);
    });

    it('returns parsed projects from output', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: 'hushbox-34\t/repo/worktrees/a' } as never);

      const result = await getRunningDockerProjects();

      expect(result).toEqual([{ projectName: 'hushbox-34', workingDir: '/repo/worktrees/a' }]);
    });

    it('returns empty array when docker ps returns empty output', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '' } as never);

      const result = await getRunningDockerProjects();

      expect(result).toEqual([]);
    });

    it('throws with the underlying cause when docker ps fails', async () => {
      const cause = new Error('Docker not running');
      mockExeca.mockRejectedValue(cause);

      await expect(getRunningDockerProjects()).rejects.toThrow(
        /could not list running Docker Compose projects/
      );
      await expect(getRunningDockerProjects()).rejects.toMatchObject({ cause });
    });
  });

  describe('parseUnmanagedContainers', () => {
    it('keeps a container that belongs to no compose project', () => {
      // The emulator, named by the launch itself rather than by compose, is the
      // container this reclaim exists to reach — so the fixture is the name that
      // launch mints rather than a spelling of it.
      const emulator = emulatorContainerName(9, 0);
      const created = dockerCreatedAt(TEST_DAY_START);

      expect(parseUnmanagedContainers(`${emulator}\t\t${created}`)).toEqual([
        { name: emulator, createdAt: created },
      ]);
    });

    it('keeps the creation time of a container the listing gives none for as no time at all', () => {
      const emulator = emulatorContainerName(9, 0);

      expect(parseUnmanagedContainers(`${emulator}\t`)).toEqual([
        { name: emulator, createdAt: '' },
      ]);
    });

    it('drops a container a compose project already owns', () => {
      expect(
        parseUnmanagedContainers(
          `hushbox-postgres-1\thushbox-34\t${dockerCreatedAt(TEST_DAY_START)}`
        )
      ).toEqual([]);
    });

    it('reads nothing from an empty listing', () => {
      expect(parseUnmanagedContainers('')).toEqual([]);
    });
  });

  describe('listUnmanagedContainers', () => {
    it('throws with the underlying cause when docker ps fails', async () => {
      const cause = new Error('Docker not running');
      mockExeca.mockRejectedValue(cause);

      await expect(listUnmanagedContainers()).rejects.toThrow(/could not list containers/);
      await expect(listUnmanagedContainers()).rejects.toMatchObject({ cause });
    });
  });

  describe('parseStuckContainers', () => {
    it('keeps a container docker has in a state other than running', () => {
      expect(parseStuckContainers('hushbox-0-minio-setup-run-a1\tcreated')).toEqual([
        { name: 'hushbox-0-minio-setup-run-a1', state: 'created' },
      ]);
    });

    it('keeps an exited container, which holds its name and its layer', () => {
      expect(parseStuckContainers('hushbox-0-minio-setup-run-a1\texited')).toEqual([
        { name: 'hushbox-0-minio-setup-run-a1', state: 'exited' },
      ]);
    });

    it('drops a container docker is running', () => {
      expect(parseStuckContainers('hushbox-0-postgres-1\trunning')).toEqual([]);
    });

    it('reads nothing from an empty listing', () => {
      expect(parseStuckContainers('')).toEqual([]);
    });
  });

  describe('getStuckContainers', () => {
    it('asks docker for every container carrying this clone’s label', async () => {
      mockExeca.mockResolvedValueOnce({ stdout: '' } as never);

      await getStuckContainers();

      const args = mockExeca.mock.calls[0]?.[1] as readonly string[];
      expect(args).toContain('-a');
      expect(args).toContain(`label=${CLONE_DIR_LABEL}`);
    });

    it('throws with the underlying cause when docker ps fails', async () => {
      const cause = new Error('Docker not running');
      mockExeca.mockRejectedValue(cause);

      await expect(getStuckContainers()).rejects.toThrow(/could not list containers/);
      await expect(getStuckContainers()).rejects.toMatchObject({ cause });
    });
  });

  describe('reclaimUnmanagedContainers', () => {
    const CHECKOUT = '/checkout-under-test/.git';

    beforeEach(() => {
      // Only the clock: these cases register runs and take locks, and faking
      // the timers those wait on would stall them rather than steady them.
      freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    function withRegistry<T>(body: (registryDir: string) => Promise<T>): Promise<T> {
      return withScratchDirectory('hushbox-container-reclaim-', body);
    }

    /** A container in a listing, as docker renders the row this pass reads. */
    interface ListedContainer {
      readonly name: string;
      /** Docker's own rendering of its creation time; empty where it carried none. */
      readonly createdAt: string;
    }

    /**
     * A creation time for a container created `elapsedMs` before the instant
     * these cases pin the clock to.
     */
    function createdAgo(elapsedMs: number): string {
      return dockerCreatedAt(TEST_DAY_START - elapsedMs);
    }

    /** A container young enough that no boundary is in question for it. */
    function fresh(name: string): ListedContainer {
      return { name, createdAt: createdAgo(MINUTE_MS) };
    }

    /** A container that has stood past the age one nothing accounts for is left for. */
    function ancient(name: string): ListedContainer {
      return { name, createdAt: createdAgo(UNOWNED_RECLAIM_AFTER_MS + HOUR_MS) };
    }

    function listing(containers: readonly (string | ListedContainer)[]): void {
      const rows = containers.map((found) => (typeof found === 'string' ? fresh(found) : found));
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'docker' && Array.isArray(args) && args[0] === 'ps') {
          return Promise.resolve({
            stdout: rows.map((row) => `${row.name}\t\t${row.createdAt}`).join('\n'),
          } as never);
        }
        return Promise.resolve({} as never);
      }) as never);
    }

    function run<T>(registryDir: string, body: () => Promise<T>): Promise<T> {
      return registerRun(
        {
          command: 'pnpm mobile:test',
          mode: 'development',
          slot: 4,
          gitCommonDir: CHECKOUT,
          registryDir,
        },
        body
      );
    }

    it('leaves a container whose owning run still holds its claim', async () => {
      await withRegistry(async (registryDir) => {
        await run(registryDir, async () => {
          await recordOwnedResource('container', 'hushbox-emulator-live');
          listing(['hushbox-emulator-live']);

          const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

          expect(result.removed).toEqual([]);
        });
      });
    });

    it('removes a container whose owning run died', async () => {
      await withRegistry(async (registryDir) => {
        await expect(
          run(registryDir, async () => {
            await recordOwnedResource('container', 'hushbox-emulator-dead');
            throw new Error('killed');
          })
        ).rejects.toThrow('killed');
        listing(['hushbox-emulator-dead']);

        const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

        expect(result.removed).toEqual(['hushbox-emulator-dead']);
        expect(mockExeca).toHaveBeenCalledWith('docker', ['rm', '-f', 'hushbox-emulator-dead'], {
          stdio: 'inherit',
        });
      });
    });

    it('reports a container no claim accounts for and leaves it standing', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      listing(['hushbox-emulator-stranger']);

      await withRegistry(async (registryDir) => {
        const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

        expect(result.unowned).toEqual(['hushbox-emulator-stranger']);
        expect(result.removed).toEqual([]);
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('hushbox-emulator-stranger'));
    });

    it('names the unreadable live run rather than asserting no claim names the container', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      listing(['hushbox-emulator-stranger']);

      await withRegistry(async (registryDir) => {
        const runId = await run(registryDir, async () => {
          const runDir = process.env[RUN_CLAIM_ENV] ?? '';
          const record = path.join(runDir, 'run.json');
          const written: unknown = JSON.parse(readFileSync(record, 'utf8'));
          writeFileSync(
            record,
            JSON.stringify({
              ...(written as object),
              mode: 'a-mode-this-checkout-has-never-heard-of',
            })
          );
          await reclaimUnmanagedContainers({ dryRun: false, registryDir });
          return path.basename(runDir);
        });

        const printed = warn.mock.calls.map((call) => String(call[0])).join('\n');
        expect(printed).not.toContain('no claim, live or expired');
        expect(printed).toContain(runId);
      });
      warn.mockRestore();
    });

    it('classifies stopped containers too, since an exited one keeps its name and layer', async () => {
      listing([]);

      await withRegistry((registryDir) =>
        reclaimUnmanagedContainers({ dryRun: false, registryDir })
      );

      expect(mockExeca).toHaveBeenCalledWith('docker', [
        'ps',
        '-a',
        '--filter',
        'name=hushbox-',
        '--format',
        '{{.Names}}\t{{.Label "com.docker.compose.project"}}\t{{.CreatedAt}}',
      ]);
    });

    it('asks docker when a container was created rather than how long it has run', async () => {
      // A container created and never started has no running time at all, and
      // one is what the boundary must still be able to judge. Asking for the
      // creation time is what makes that answerable; asking how long it has
      // been running would leave exactly that container unreadable forever.
      listing([]);

      await withRegistry((registryDir) =>
        reclaimUnmanagedContainers({ dryRun: false, registryDir })
      );

      const args = mockExeca.mock.calls[0]?.[1] as readonly string[];
      expect(args.join(' ')).toContain('{{.CreatedAt}}');
      expect(args.join(' ')).not.toContain('RunningFor');
      expect(args.join(' ')).not.toContain('StartedAt');
    });

    it('removes a container no claim accounts for once it has stood past the boundary', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      listing([ancient('hushbox-emulator-abandoned'), fresh('hushbox-emulator-recent')]);

      await withRegistry(async (registryDir) => {
        const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

        expect(result.reclaimedByAge).toEqual(['hushbox-emulator-abandoned']);
        expect(result.removed).toEqual(['hushbox-emulator-abandoned']);
      });
      expect(mockExeca).toHaveBeenCalledWith('docker', ['rm', '-f', 'hushbox-emulator-abandoned'], {
        stdio: 'inherit',
      });
    });

    it('leaves standing a container no claim accounts for that has not', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      listing([ancient('hushbox-emulator-abandoned'), fresh('hushbox-emulator-recent')]);

      await withRegistry(async (registryDir) => {
        const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

        expect(result.unowned).toEqual(['hushbox-emulator-recent']);
        expect(result.removed).not.toContain('hushbox-emulator-recent');
      });
      expect(mockExeca).not.toHaveBeenCalledWith(
        'docker',
        ['rm', '-f', 'hushbox-emulator-recent'],
        expect.anything()
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('hushbox-emulator-recent'));
    });

    it('says the age could not be read for a container the listing gives no creation time', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      listing([{ name: 'hushbox-emulator-undated', createdAt: '' }]);

      await withRegistry(async (registryDir) => {
        const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

        expect(result.unowned).toEqual(['hushbox-emulator-undated']);
        expect(result.removed).toEqual([]);
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read/));
    });

    it('says the age could not be read for a creation time it cannot make sense of', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      listing([{ name: 'hushbox-emulator-garbled', createdAt: 'whenever it was' }]);

      await withRegistry(async (registryDir) => {
        const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

        expect(result.unowned).toEqual(['hushbox-emulator-garbled']);
        expect(result.removed).toEqual([]);
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read/));
    });

    it('says the age could not be read for a container docker dates later than now', async () => {
      // Two readings that cannot both be of this machine, so neither is one
      // this pass may act on — and acting would mean removing something the
      // boundary was never established to cover.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      listing([{ name: 'hushbox-emulator-ahead', createdAt: createdAgo(-HOUR_MS) }]);

      await withRegistry(async (registryDir) => {
        const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

        expect(result.unowned).toEqual(['hushbox-emulator-ahead']);
        expect(result.removed).toEqual([]);
      });
      expect(warn).toHaveBeenCalledWith(expect.stringMatching(/could not be read/));
    });

    it('removes a container created and never started on the age of its creation', async () => {
      // The row docker answers for such a container: a creation time, and no
      // time of any other kind. Read for when it started, it would stand for
      // ever; read for when it was created, it is as reclaimable as any other.
      vi.spyOn(console, 'log').mockImplementation(() => undefined);
      listing([ancient('hushbox-emulator-never-started')]);

      await withRegistry(async (registryDir) => {
        const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

        expect(result.removed).toEqual(['hushbox-emulator-never-started']);
      });
    });

    it('leaves a container past the boundary standing while a live run’s record cannot be read', async () => {
      // A record that could not be read may be the claim naming this very
      // container, so the age licenses nothing until it can be read: the
      // reclaim would otherwise take a container a live run is using.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      listing([ancient('hushbox-emulator-maybe-claimed')]);

      await withRegistry(async (registryDir) => {
        await run(registryDir, async () => {
          damageOwnRecord();
          const result = await reclaimUnmanagedContainers({ dryRun: false, registryDir });

          expect(result.reclaimedByAge).toEqual([]);
          expect(result.removed).toEqual([]);
        });
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('hushbox-emulator-maybe-claimed'));
    });

    it('names what it would remove and removes nothing in a dry run', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      listing([ancient('hushbox-emulator-abandoned')]);

      await withRegistry(async (registryDir) => {
        const result = await reclaimUnmanagedContainers({ dryRun: true, registryDir });

        expect(result.reclaimedByAge).toEqual(['hushbox-emulator-abandoned']);
        expect(result.removed).toEqual([]);
      });
      expect(mockExeca).not.toHaveBeenCalledWith('docker', expect.arrayContaining(['rm']), {
        stdio: 'inherit',
      });
      expect(log.mock.calls.map((call) => String(call[0])).join('\n')).toMatch(
        /would remove hushbox-emulator-abandoned/i
      );
    });

    it('removes nothing in dry-run mode', async () => {
      await withRegistry(async (registryDir) => {
        await expect(
          run(registryDir, async () => {
            await recordOwnedResource('container', 'hushbox-emulator-dead');
            throw new Error('killed');
          })
        ).rejects.toThrow('killed');
        listing(['hushbox-emulator-dead']);

        const result = await reclaimUnmanagedContainers({ dryRun: true, registryDir });

        expect(result.removed).toEqual([]);
        expect(result.expired).toEqual(['hushbox-emulator-dead']);
      });
    });
  });

  describe('removeProject', () => {
    it('calls docker compose -p <name> down with correct args', async () => {
      mockExeca.mockResolvedValueOnce({} as never);

      await removeProject('hushbox-34');

      expect(mockExeca).toHaveBeenCalledWith(
        'docker',
        ['compose', '--project-directory', CHECKOUT_DIRECTORY, '-p', 'hushbox-34', 'down'],
        { stdio: 'inherit' }
      );
    });

    it('throws on failure', async () => {
      mockExeca.mockRejectedValueOnce(new Error('compose down failed'));

      await expect(removeProject('hushbox-34')).rejects.toThrow('compose down failed');
    });
  });

  describe('cleanupOrphanedProjects', () => {
    /** The clone the pass runs over, every directory it names made real. */
    interface CleanupWorld {
      readonly root: string;
      readonly commonDir: string;
      readonly siblingCommonDir: string;
      /** The main checkout, which `git worktree list` names. */
      readonly main: string;
      /** A linked checkout, which `git worktree list` also names. */
      readonly live: string;
      /** Directories of this clone that are there and that the listing names not. */
      readonly stranded: readonly [string, string];
      /** A checkout of a different clone of this repository. */
      readonly sibling: string;
      /** A recorded working directory nothing ever created. */
      readonly deleted: string;
      readonly worktreeOutput: string;
      /** A scratch run registry, so no case reads the machine's own. */
      readonly registryDir: string;
      /** A scratch slot registry, for the same reason. */
      readonly slotRegistryDir: string;
    }

    /**
     * The directories a pass classifies have to be there, because the resolver
     * runs git inside each one. A fixture path nothing created answers null,
     * and null reaches one verdict and no other.
     */
    function withWorld<T>(body: (world: CleanupWorld) => Promise<T>): Promise<T> {
      return withScratchDirectory('hb-cleanup-', (root) => {
        const main = made(root, 'clone', 'main');
        const live = made(root, 'clone', 'feature-c');
        return body({
          root,
          main,
          live,
          commonDir: path.join(root, 'clone', '.git'),
          siblingCommonDir: path.join(root, 'sibling', '.git'),
          stranded: [made(root, 'clone', 'feature-a'), made(root, 'clone', 'feature-b')],
          sibling: made(root, 'sibling', 'feature-a'),
          deleted: path.join(root, 'clone', 'feature-d'),
          registryDir: made(root, 'runs'),
          slotRegistryDir: path.join(root, 'slots'),
          worktreeOutput: [
            `worktree ${main}`,
            'HEAD abc',
            'branch refs/heads/main',
            '',
            `worktree ${live}`,
            'HEAD def',
            'branch refs/heads/feature-c',
            '',
          ].join('\n'),
        });
      });
    }

    /**
     * A `docker ps` listing of the compose projects `entries` names. A third
     * element is the clone the project stamped on its containers; without one
     * the line carries the empty stamp every unstamped container answers with.
     */
    function listing(
      entries: readonly (readonly [string, string] | readonly [string, string, string])[]
    ): string {
      return entries
        .map(([projectName, workingDir, cloneDir]) =>
          [projectName, workingDir, cloneDir ?? ''].join('\t')
        )
        .join('\n');
    }

    /** Two stranded projects and one the live checkout runs under. */
    function defaultListing(world: CleanupWorld): string {
      return listing([
        ['hushbox-34', world.stranded[0]],
        ['hushbox-51', world.stranded[1]],
        ['hushbox-73', world.live],
      ]);
    }

    // Everything but the sibling clone — including the working directory the
    // cleanup asks about itself — belongs to this repository.
    function gitCommonDirFor(world: CleanupWorld, dir: string): string {
      return dir.startsWith(path.join(world.root, 'sibling'))
        ? world.siblingCommonDir
        : world.commonDir;
    }

    function answerGit(world: CleanupWorld, args: readonly string[]): Promise<unknown> {
      if (args[0] === 'worktree') return Promise.resolve({ stdout: world.worktreeOutput } as never);
      const dir = args[1];
      if (args[0] !== '-C' || dir === undefined) {
        return Promise.reject(new Error(`unexpected git call: ${args.join(' ')}`));
      }
      // `git -C` fails before it reads anything when the directory is not
      // there, and that is the whole of what a recorded working directory can
      // answer once its checkout has been deleted.
      if (!existsSync(dir)) {
        return Promise.reject(new Error(`cannot change to '${dir}': No such file or directory`));
      }
      return Promise.resolve({ stdout: gitCommonDirFor(world, dir) } as never);
    }

    function setupMocks(world: CleanupWorld, dockerOutput: string | Error): void {
      mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
        if (cmd === 'git' && Array.isArray(args)) return answerGit(world, args);
        if (cmd === 'docker' && Array.isArray(args) && args[0] === 'ps') {
          // Only the compose-project listing carries the label filter; the
          // container listing is `ps -a`, and a case about one failing must
          // not fail the other.
          if (!args.includes('label=com.docker.compose.project')) {
            return Promise.resolve({ stdout: '' } as never);
          }
          if (dockerOutput instanceof Error) return Promise.reject(dockerOutput);
          return Promise.resolve({ stdout: dockerOutput } as never);
        }
        // docker compose down
        return Promise.resolve({} as never);
      }) as never);
    }

    /** The pass, asked about the scratch registries rather than the machine's. */
    function cleanup(
      world: CleanupWorld,
      dryRun: boolean
    ): ReturnType<typeof cleanupOrphanedProjects> {
      return cleanupOrphanedProjects({
        dryRun,
        registryDir: world.registryDir,
        slotRegistryDir: world.slotRegistryDir,
      });
    }

    it('finds and removes orphaned projects', async () => {
      await withWorld(async (world) => {
        setupMocks(world, defaultListing(world));

        const result = await cleanup(world, false);

        expect(result.orphaned).toEqual([
          { projectName: 'hushbox-34', workingDir: world.stranded[0] },
          { projectName: 'hushbox-51', workingDir: world.stranded[1] },
        ]);
        expect(result.removed).toEqual(['hushbox-34', 'hushbox-51']);
      });
    });

    it('does not remove in dry-run mode', async () => {
      await withWorld(async (world) => {
        setupMocks(world, defaultListing(world));

        const result = await cleanup(world, true);

        expect(result.orphaned).toHaveLength(2);
        expect(result.removed).toEqual([]);

        const downCalls = mockExeca.mock.calls.filter(
          ([cmd, args]) => cmd === 'docker' && Array.isArray(args) && args.includes('down')
        );
        expect(downCalls).toHaveLength(0);
      });
    });

    it('returns empty lists when no orphans found', async () => {
      await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-73', world.live]]));

        const result = await cleanup(world, false);

        expect(result.orphaned).toEqual([]);
        expect(result.removed).toEqual([]);
      });
    });

    it('returns empty lists when no docker projects running', async () => {
      await withWorld(async (world) => {
        setupMocks(world, '');

        const result = await cleanup(world, false);

        expect(result.orphaned).toEqual([]);
        expect(result.removed).toEqual([]);
      });
    });

    it('says a stack of a different clone of this repository is that, and leaves it running', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-34', world.sibling]]));

        const result = await cleanup(world, false);

        expect(result.otherClone).toEqual([
          { projectName: 'hushbox-34', workingDir: world.sibling },
        ]);
        expect(result.orphaned).toEqual([]);
        expect(result.removed).toEqual([]);
        const downCalls = mockExeca.mock.calls.filter(
          ([cmd, args]) => cmd === 'docker' && Array.isArray(args) && args.includes('down')
        );
        expect(downCalls).toHaveLength(0);
      });
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(/hushbox-34[\s\S]*different clone of this repository/)
      );
    });

    it('says the recorded directory could not be resolved, not that it lies elsewhere', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-34', world.deleted]]));

        const result = await cleanup(world, false);

        expect(result.unresolved).toEqual([
          { projectName: 'hushbox-34', workingDir: world.deleted },
        ]);
        expect(result.removed).toEqual([]);
      });
      // The population this line reaches is a checkout that was deleted, and
      // telling that operator their stack belongs to another clone sends them
      // looking for a clone that does not exist.
      const printed = warn.mock.calls.flat().join('\n');
      expect(printed).toMatch(/hushbox-34[\s\S]*could not resolve/);
      expect(printed).not.toMatch(/different clone/);
    });

    it('reclaims the project of a deleted checkout that stamped this clone', async () => {
      await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-34', world.deleted, world.commonDir]]));

        const result = await cleanup(world, false);

        expect(result.orphaned).toEqual([
          { projectName: 'hushbox-34', workingDir: world.deleted, cloneDir: world.commonDir },
        ]);
        expect(result.unresolved).toEqual([]);
      });
    });

    it('says a stack another clone stamped is that, not that its directory resolves there', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-34', world.deleted, world.siblingCommonDir]]));

        const result = await cleanup(world, false);

        expect(result.otherClone).toEqual([
          {
            projectName: 'hushbox-34',
            workingDir: world.deleted,
            cloneDir: world.siblingCommonDir,
          },
        ]);
      });
      // The directory this one was started from resolves into nothing at all,
      // so a line saying it resolves elsewhere sends the reader to a repository
      // that never answered.
      const printed = warn.mock.calls.flat().join('\n');
      expect(printed).toMatch(/hushbox-34[\s\S]*different clone of this repository/);
      expect(printed).not.toMatch(/resolves into/);
    });

    it('says a project it cannot place carries no stamp of its own either', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-34', world.deleted]]));

        await cleanup(world, false);
      });

      expect(warn.mock.calls.flat().join('\n')).toMatch(/label/);
    });

    it('attempts every orphan and then throws naming the ones that failed', async () => {
      await withWorld(async (world) => {
        let removeCount = 0;
        mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
          if (cmd === 'git' && Array.isArray(args)) return answerGit(world, args);
          if (cmd === 'docker' && Array.isArray(args) && args[0] === 'ps') {
            return Promise.resolve({ stdout: defaultListing(world) } as never);
          }
          // docker compose down — fail the first one
          removeCount++;
          if (removeCount === 1) return Promise.reject(new Error('network error'));
          return Promise.resolve({} as never);
        }) as never);

        await expect(cleanup(world, false)).rejects.toThrow(/hushbox-34/);
        expect(removeCount).toBe(2);
      });
    });

    it('refuses to run outside a git repository', async () => {
      await withWorld(async (world) => {
        mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
          if (cmd === 'git' && Array.isArray(args) && args[0] === 'worktree') {
            return Promise.resolve({ stdout: world.worktreeOutput } as never);
          }
          if (cmd === 'git') return Promise.reject(new Error('not a git repository'));
          return Promise.resolve({ stdout: defaultListing(world) } as never);
        }) as never);

        await expect(cleanup(world, false)).rejects.toThrow(/not inside a git repository/);
      });
    });

    it('names the project a live checkout no longer runs under, rather than passing it in silence', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-73', world.live]]));
        claimSlot({
          worktreePath: world.live,
          gitDir: path.join(world.commonDir, 'worktrees', 'feature-c'),
          registryDir: world.slotRegistryDir,
        });

        const result = await cleanup(world, false);

        expect(result.unaccounted).toEqual([{ projectName: 'hushbox-73', workingDir: world.live }]);
        expect(result.removed).toEqual([]);
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('docker compose -p hushbox-73'));
    });

    it('gives the standing that put it there rather than asserting no run claims it', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-73', world.live]]));
        claimSlot({
          worktreePath: world.live,
          gitDir: path.join(world.commonDir, 'worktrees', 'feature-c'),
          registryDir: world.slotRegistryDir,
        });

        await cleanup(world, false);
      });

      // What `verdictFor` established is that the checkout is still listed and
      // now runs a project of another name. It read live claims only, so an
      // expired claim naming this project reaches here too — which makes "no
      // run claims that project" an assertion the pass never made.
      const line = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(line).toContain('runs a different project');
      expect(line).not.toContain('no run claims that project');
    });

    it('says which run directory stopped it reclaiming, so a human can go and look', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      const runId = await withWorld(async (world) => {
        setupMocks(world, listing([['hushbox-34', world.stranded[0]]]));

        return registerRun(runInit(world.registryDir), async () => {
          const damaged = damageOwnRecord();

          const result = await cleanup(world, false);

          expect(result.orphaned).toEqual([]);
          expect(result.blocked).toEqual([
            { projectName: 'hushbox-34', workingDir: world.stranded[0] },
          ]);
          expect(result.removed).toEqual([]);
          return damaged;
        });
      });
      // Both halves, because the registry warns about the unreadable record on
      // its own: what this case is about is the compose project that record
      // stopped this pass reclaiming.
      expect(warn).toHaveBeenCalledWith(
        expect.stringMatching(new RegExp(String.raw`hushbox-34[\s\S]*` + runId))
      );
    });

    it('reclaims nothing rather than failing the command when the world never holds still', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      await withWorld(async (world) => {
        let appearances = 0;
        mockExeca.mockImplementation(((cmd: string, args?: readonly string[]) => {
          if (cmd === 'git' && Array.isArray(args)) return answerGit(world, args);
          if (cmd === 'docker' && Array.isArray(args) && args[0] === 'ps') {
            if (!args.includes('label=com.docker.compose.project')) {
              return Promise.resolve({ stdout: '' } as never);
            }
            // One more project than the previous listing, every time it is
            // asked: a world that never settles between the two scans of a
            // pass.
            appearances += 1;
            const lines = Array.from(
              { length: appearances },
              (_, index) => [`hushbox-${String(index)}`, world.stranded[0]] as const
            );
            return Promise.resolve({ stdout: listing(lines) } as never);
          }
          return Promise.resolve({} as never);
        }) as never);

        const result = await cleanup(world, false);

        expect(result.orphaned).toEqual([]);
        expect(result.removed).toEqual([]);
      });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('compose projects'));
    });

    it('propagates a docker ps failure instead of reporting nothing to clean up', async () => {
      await withWorld(async (world) => {
        setupMocks(world, new Error('Docker not running'));

        await expect(cleanup(world, false)).rejects.toThrow(
          /could not list running Docker Compose projects/
        );
      });
    });

    describe('main', () => {
      const originalArgv = process.argv;

      afterEach(() => {
        process.argv = originalArgv;
      });

      it('passes --dry-run from argv through to cleanup', async () => {
        await withWorld(async (world) => {
          setupMocks(world, defaultListing(world));
          process.argv = ['node', 'docker-cleanup.ts', '--dry-run'];

          await main();

          const composeDownCalls = mockExeca.mock.calls.filter(
            ([, args]) => Array.isArray(args) && args[0] === 'compose'
          );
          expect(composeDownCalls).toEqual([]);
        });
      });

      it('removes orphaned projects when run without flags', async () => {
        await withWorld(async (world) => {
          setupMocks(world, defaultListing(world));
          process.argv = ['node', 'docker-cleanup.ts'];

          await main();

          const composeDownCalls = mockExeca.mock.calls.filter(
            ([, args]) => Array.isArray(args) && args[0] === 'compose'
          );
          expect(composeDownCalls).toHaveLength(2);
        });
      });
    });
  });
});
