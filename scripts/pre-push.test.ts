import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('./lib/privacy/gitleaks.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./lib/privacy/gitleaks.js')>()),
  ensureGitleaks: vi.fn((): Promise<string> => Promise.resolve('/cache/gitleaks/8.24.3/gitleaks')),
}));

import { execa } from 'execa';
import { ensureGitleaks } from './lib/privacy/gitleaks.js';
import {
  PARALLEL_TASKS,
  TEST_TASK,
  runParallel,
  runSequential,
  main,
  buildGitleaksTask,
  buildTreeScanTasks,
  buildPrivacyGateTask,
  budgetShares,
  launcherFailure,
  type Task,
} from './pre-push.js';

const mockExeca = vi.mocked(execa);
const mockEnsure = vi.mocked(ensureGitleaks);

/**
 * The exit state sits under the runtime process rather than on the handle,
 * because that is where the process library carries it — a fake holding it on
 * the handle stands in for a shape no caller is ever handed, and passes for
 * production code reading a field that is always absent there.
 */
interface FakeProcess extends Promise<void> {
  nodeChildProcess: { exitCode: number | null; killed: boolean };
  kill: ReturnType<typeof vi.fn>;
  _resolve: () => void;
  _reject: (error: Error) => void;
}

function makeFakeProcess(): FakeProcess {
  let resolveFunction!: () => void;
  let rejectFunction!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => {
    resolveFunction = () => {
      resolve();
    };
    rejectFunction = reject;
  });
  const fake = Object.assign(promise, {
    nodeChildProcess: { exitCode: null as number | null, killed: false },
    kill: vi.fn(),
    _resolve: () => {
      fake.nodeChildProcess.exitCode = 0;
      resolveFunction();
    },
    _reject: (error: Error) => {
      fake.nodeChildProcess.exitCode = 1;
      rejectFunction(error);
    },
  }) as unknown as FakeProcess;
  fake.kill.mockImplementation(() => {
    fake.nodeChildProcess.killed = true;
    fake.nodeChildProcess.exitCode = 143;
    rejectFunction(new Error('killed by SIGTERM'));
    return true;
  });
  return fake;
}

function captureProcs(): FakeProcess[] {
  const procs: FakeProcess[] = [];
  mockExeca.mockImplementation((() => {
    const p = makeFakeProcess();
    procs.push(p);
    return p;
  }) as never);
  return procs;
}

async function waitForExecaCalls(n: number): Promise<void> {
  while (mockExeca.mock.calls.length < n) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
}

describe('pre-push', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('PARALLEL_TASKS', () => {
    it('contains the static checks in expected order', () => {
      expect(PARALLEL_TASKS.map((t) => t.name)).toEqual([
        'lint:duplication',
        'lint:unused',
        'lint',
        'typecheck',
        'arch:check',
        'docket:validate',
        'verify:licenses',
        'verify:doc-paths',
        'verify:design-tokens',
      ]);
    });

    it('invokes each check as a pnpm script', () => {
      expect(PARALLEL_TASKS.map((t) => [t.command, ...t.args])).toEqual([
        ['pnpm', 'lint:duplication'],
        ['pnpm', 'lint:unused'],
        ['pnpm', 'lint'],
        ['pnpm', 'typecheck'],
        ['pnpm', 'arch:check'],
        ['pnpm', 'docket', '--validate'],
        ['pnpm', 'verify:licenses'],
        ['pnpm', 'verify:doc-paths'],
        ['pnpm', 'verify:design-tokens'],
      ]);
    });
  });

  describe('TEST_TASK', () => {
    it('is pnpm test', () => {
      expect(TEST_TASK).toEqual({ name: 'test', command: 'pnpm', args: ['test'] });
    });
  });

  describe('budgetShares', () => {
    it('splits one budget between the tasks that size themselves by it', () => {
      const shares = budgetShares(PARALLEL_TASKS, 16_000_000);
      expect([...shares.entries()].toSorted(([a], [b]) => a.localeCompare(b))).toEqual([
        ['lint', 8_000_000],
        ['typecheck', 8_000_000],
      ]);
    });

    it('gives no share to a gate that exposes no concurrency to size', () => {
      const shares = budgetShares(PARALLEL_TASKS, 16_000_000);
      expect(shares.has('arch:check')).toBe(false);
      expect(shares.has('lint:unused')).toBe(false);
      expect(shares.has('lint:duplication')).toBe(false);
    });

    it('is empty when the machine would not say how much memory it has', () => {
      expect(budgetShares(PARALLEL_TASKS).size).toBe(0);
    });

    it('is empty when no task is budgeted', () => {
      expect(budgetShares([{ name: 'x', command: 'pnpm', args: ['x'] }], 100).size).toBe(0);
    });
  });

  describe('runParallel', () => {
    it('spawns each task with stdio inherit', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(2);
      procs[0]!._resolve();
      procs[1]!._resolve();
      await promise;
      expect(mockExeca).toHaveBeenCalledTimes(2);
      expect(mockExeca).toHaveBeenNthCalledWith(
        1,
        'pnpm',
        ['a'],
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).toHaveBeenNthCalledWith(
        2,
        'pnpm',
        ['b'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('resolves when all tasks succeed', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(2);
      procs[0]!._resolve();
      procs[1]!._resolve();
      await expect(promise).resolves.toBeUndefined();
    });

    it('kills siblings with SIGTERM when one task fails', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
        { name: 'c', command: 'pnpm', args: ['c'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(3);
      procs[0]!._reject(new Error('boom'));
      await expect(promise).rejects.toThrow('boom');
      expect(procs[1]!.kill).toHaveBeenCalledWith('SIGTERM');
      expect(procs[2]!.kill).toHaveBeenCalledWith('SIGTERM');
      expect(procs[0]!.kill).not.toHaveBeenCalled();
    });

    it('does not kill already-completed siblings', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(2);
      procs[0]!._resolve();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      procs[1]!._reject(new Error('failure'));
      await expect(promise).rejects.toThrow('failure');
      expect(procs[0]!.kill).not.toHaveBeenCalled();
    });

    it('throws the first failure even when later ones fail too', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [
        { name: 'a', command: 'pnpm', args: ['a'] },
        { name: 'b', command: 'pnpm', args: ['b'] },
      ];
      const promise = runParallel(tasks);
      await waitForExecaCalls(2);
      procs[1]!._reject(new Error('first failure'));
      await expect(promise).rejects.toThrow('first failure');
    });

    it('wraps a non-Error rejection in an Error', async () => {
      const procs = captureProcs();
      const tasks: Task[] = [{ name: 'a', command: 'pnpm', args: ['a'] }];
      const promise = runParallel(tasks);
      await waitForExecaCalls(1);
      procs[0]!._reject('plain string failure' as unknown as Error);
      await expect(promise).rejects.toThrow('plain string failure');
    });
  });

  describe('runSequential', () => {
    it('runs the task with stdio inherit and resolves on success', async () => {
      const procs = captureProcs();
      const promise = runSequential({ name: 'test', command: 'pnpm', args: ['test'] });
      await waitForExecaCalls(1);
      procs[0]!._resolve();
      await expect(promise).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledWith(
        'pnpm',
        ['test'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('rejects when the task fails', async () => {
      const procs = captureProcs();
      const promise = runSequential({ name: 'test', command: 'pnpm', args: ['test'] });
      await waitForExecaCalls(1);
      procs[0]!._reject(new Error('test failed'));
      await expect(promise).rejects.toThrow('test failed');
    });
  });

  describe('buildGitleaksTask', () => {
    const ZERO = '0'.repeat(40);

    it('scans the last commit when run from a TTY', async () => {
      const task = await buildGitleaksTask('', true, []);
      expect(task).toEqual({
        name: 'gitleaks',
        command: '/cache/gitleaks/8.24.3/gitleaks',
        args: ['git', '--redact', '--no-banner', '--log-opts=-1 --diff-merges=first-parent'],
      });
      expect(mockEnsure).toHaveBeenCalledTimes(1);
    });

    it('falls back to the last commit when stdin is empty', async () => {
      const task = await buildGitleaksTask('', false, []);
      expect(task!.args).toContain('--log-opts=-1 --diff-merges=first-parent');
    });

    it('scans the pushed range from stdin', async () => {
      const task = await buildGitleaksTask(
        'refs/heads/main newsha refs/heads/main oldsha',
        false,
        []
      );
      expect(task!.args).toContain('--log-opts=oldsha..newsha --diff-merges=first-parent');
    });

    it('scopes a new branch to what the destination advertises', async () => {
      const task = await buildGitleaksTask(
        `refs/heads/feat newsha refs/heads/feat ${ZERO}`,
        false,
        ['advertisedsha']
      );
      // The trailing `--not` restores polarity for anything after this group;
      // with nothing after it, git reads it as the no-op it is.
      expect(task!.args).toContain(
        '--log-opts=newsha --not advertisedsha --not --diff-merges=first-parent'
      );
    });

    it('takes no exclusions from this half of the hook, whatever the push shape', async () => {
      const procs = captureProcs();
      const promise = main(
        `refs/heads/feat newsha refs/heads/feat ${ZERO}`,
        false,
        'origin',
        'url'
      );
      await waitForExecaCalls(12);
      for (let index = 0; index < 12; index++) procs[index]!._resolve();
      await waitForExecaCalls(13);
      procs[12]!._resolve();
      await promise;
      // Asking here would have to be awaited before the parallel set starts, so
      // a hanging destination would cost a whole bound of dead time. The gate
      // asks inside the set, where a bound is absorbed rather than serial.
      expect(mockExeca).toHaveBeenCalledWith(
        '/cache/gitleaks/8.24.3/gitleaks',
        [
          'git',
          '--redact',
          '--no-banner',
          '--log-opts=newsha --not --not --diff-merges=first-parent',
        ],
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).not.toHaveBeenCalledWith('git', expect.anything(), expect.anything());
    });

    it('returns null and does not resolve the binary when only deletions are pushed', async () => {
      const task = await buildGitleaksTask(
        `refs/heads/gone ${ZERO} refs/heads/gone oldsha`,
        false,
        []
      );
      expect(task).toBeNull();
      expect(mockEnsure).not.toHaveBeenCalled();
    });
  });

  describe('buildTreeScanTasks', () => {
    const ZERO = '0'.repeat(40);

    it('scans the checkout tip when the hook is run by hand', () => {
      expect(buildTreeScanTasks('', true, [])).toEqual([
        {
          name: 'gitleaks:tree HEAD',
          command: 'node',
          args: ['--import', 'tsx', 'scripts/gitleaks-scan.ts', '--revision', 'HEAD'],
          forceKillAfterDelay: 60_000,
        },
      ]);
    });

    it('scans each pushed ref at its own tip', () => {
      const tasks = buildTreeScanTasks(
        'refs/heads/main newsha refs/heads/main oldsha\nrefs/heads/side sidesha refs/heads/side othersha',
        false,
        []
      );

      expect(tasks.map((task) => task.args)).toEqual([
        ['--import', 'tsx', 'scripts/gitleaks-scan.ts', '--revision', 'newsha'],
        ['--import', 'tsx', 'scripts/gitleaks-scan.ts', '--revision', 'sidesha'],
      ]);
    });

    it('names each task after the ref whose tree it judges', () => {
      const tasks = buildTreeScanTasks(
        'refs/heads/main newsha refs/heads/main oldsha\nrefs/heads/side sidesha refs/heads/side othersha',
        false,
        []
      );

      expect(tasks.map((task) => task.name)).toEqual([
        'gitleaks:tree refs/heads/main',
        'gitleaks:tree refs/heads/side',
      ]);
    });

    it('scans nothing when the push only deletes a ref', () => {
      expect(
        buildTreeScanTasks(`refs/heads/gone ${ZERO} refs/heads/gone oldsha`, false, [])
      ).toEqual([]);
    });

    it('judges a new ref at its tip whatever the destination advertises', () => {
      const tasks = buildTreeScanTasks(`refs/heads/feat newsha refs/heads/feat ${ZERO}`, false, [
        'advertisedsha',
      ]);

      expect(tasks).toEqual([
        {
          name: 'gitleaks:tree refs/heads/feat',
          command: 'node',
          args: ['--import', 'tsx', 'scripts/gitleaks-scan.ts', '--revision', 'newsha'],
          forceKillAfterDelay: 60_000,
        },
      ]);
    });
  });

  describe('buildPrivacyGateTask', () => {
    it('runs the gate at its push stage with the destination git named', () => {
      const stdin = 'refs/heads/main newsha refs/heads/main oldsha\n';
      expect(buildPrivacyGateTask(stdin, 'origin', 'git@host:owner/name.git')).toEqual({
        name: 'privacy-gate',
        command: 'tsx',
        args: ['scripts/privacy-gate.ts', 'push', 'origin', 'git@host:owner/name.git'],
        input: stdin,
      });
    });

    it('hands the gate the ref lines git fed the hook', () => {
      const stdin = `refs/heads/gone ${'0'.repeat(40)} refs/heads/gone oldsha\n`;
      expect(buildPrivacyGateTask(stdin, 'origin', 'url').input).toBe(stdin);
    });
  });

  describe('launcherFailure', () => {
    // Assembled at runtime: a location specimen written out as a literal would
    // seed the very finding the gates look for in this file.
    const location = `${['dev', 'example-host'].join('@')}:${['', 'example', 'first.last', 'clone.git'].join('/')}`;

    it('redacts the destination the runner quotes back from the failed command line', () => {
      const line = launcherFailure(
        new Error(
          `Command failed with exit code 1: tsx scripts/privacy-gate.ts push '${location}' '${location}'`
        )
      );
      expect(line).not.toContain(location);
      expect(line).not.toContain('example-host');
      expect(line).not.toContain('first.last');
      expect(line).toContain('pre-push failed:');
    });

    it('redacts an absolute binary path a failing sibling quotes back', () => {
      const binary = ['', 'example', 'first.last', 'clone', '.cache', 'gitleaks'].join('/');
      const line = launcherFailure(new Error(`Command failed with exit code 1: ${binary} git`));
      expect(line).not.toContain(binary);
      expect(line).not.toContain('first.last');
    });

    it('reports a rejection that is not an Error', () => {
      expect(launcherFailure('plain string failure')).toBe('pre-push failed: plain string failure');
    });
  });

  describe('main', () => {
    it('runs parallel checks plus gitleaks and the gate, then test on success', async () => {
      const procs = captureProcs();
      const promise = main('', true, 'origin', 'url');
      await waitForExecaCalls(12);
      for (let index = 0; index < 12; index++) {
        procs[index]!._resolve();
      }
      await waitForExecaCalls(13);
      procs[12]!._resolve();
      await expect(promise).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledTimes(13);
      expect(mockExeca).toHaveBeenCalledWith(
        '/cache/gitleaks/8.24.3/gitleaks',
        ['git', '--redact', '--no-banner', '--log-opts=-1 --diff-merges=first-parent'],
        expect.objectContaining({ stdio: 'inherit' })
      );
      // The history scan and the tree scan answer different questions — what
      // these commits introduce, and what the tree they publish holds — so the
      // hook runs both.
      expect(mockExeca).toHaveBeenCalledWith(
        'node',
        ['--import', 'tsx', 'scripts/gitleaks-scan.ts', '--revision', 'HEAD'],
        expect.objectContaining({ stdio: 'inherit' })
      );
      expect(mockExeca).toHaveBeenCalledWith(
        'tsx',
        ['scripts/privacy-gate.ts', 'push', 'origin', 'url'],
        expect.objectContaining({ input: '' })
      );
      expect(mockExeca).toHaveBeenLastCalledWith(
        'pnpm',
        ['test'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('keeps the gate when only deletions are pushed, and drops gitleaks', async () => {
      const procs = captureProcs();
      const promise = main(
        `refs/heads/gone ${'0'.repeat(40)} refs/heads/gone oldsha`,
        false,
        'origin',
        'url'
      );
      await waitForExecaCalls(10);
      for (let index = 0; index < 10; index++) {
        procs[index]!._resolve();
      }
      await waitForExecaCalls(11);
      procs[10]!._resolve();
      await expect(promise).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledTimes(11);
      expect(mockExeca).toHaveBeenCalledWith(
        'tsx',
        ['scripts/privacy-gate.ts', 'push', 'origin', 'url'],
        expect.anything()
      );
      expect(mockExeca).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.arrayContaining(['scripts/gitleaks-scan.ts']),
        expect.anything()
      );
    });

    it('does not run test when a parallel task fails', async () => {
      const procs = captureProcs();
      const promise = main('', true, 'origin', 'url');
      await waitForExecaCalls(7);
      procs[0]!._reject(new Error('lint failed'));
      await expect(promise).rejects.toThrow('lint failed');
      expect(mockExeca).not.toHaveBeenCalledWith(
        'pnpm',
        ['test'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });
  });
});
