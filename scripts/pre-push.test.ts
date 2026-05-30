import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('execa', () => ({ execa: vi.fn() }));

import { execa } from 'execa';
import {
  PARALLEL_TASKS,
  TEST_TASK,
  runParallel,
  runSequential,
  main,
  type Task,
} from './pre-push.js';

const mockExeca = vi.mocked(execa);

interface FakeProcess extends Promise<void> {
  exitCode: number | null;
  killed: boolean;
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
    exitCode: null as number | null,
    killed: false,
    kill: vi.fn(),
    _resolve: () => {
      fake.exitCode = 0;
      resolveFunction();
    },
    _reject: (error: Error) => {
      fake.exitCode = 1;
      rejectFunction(error);
    },
  }) as unknown as FakeProcess;
  fake.kill.mockImplementation(() => {
    fake.killed = true;
    fake.exitCode = 143;
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
    it('contains the four static checks in expected order', () => {
      expect(PARALLEL_TASKS.map((t) => t.name)).toEqual([
        'lint:duplication',
        'lint:unused',
        'lint',
        'typecheck',
      ]);
    });

    it('each task invokes pnpm <name>', () => {
      for (const task of PARALLEL_TASKS) {
        expect(task.command).toBe('pnpm');
        expect(task.args).toEqual([task.name]);
      }
    });
  });

  describe('TEST_TASK', () => {
    it('is pnpm test', () => {
      expect(TEST_TASK).toEqual({ name: 'test', command: 'pnpm', args: ['test'] });
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

  describe('main', () => {
    it('runs all parallel tasks then test on success', async () => {
      const procs = captureProcs();
      const promise = main();
      await waitForExecaCalls(4);
      for (let index = 0; index < 4; index++) {
        procs[index]!._resolve();
      }
      await waitForExecaCalls(5);
      procs[4]!._resolve();
      await expect(promise).resolves.toBeUndefined();
      expect(mockExeca).toHaveBeenCalledTimes(5);
      expect(mockExeca).toHaveBeenLastCalledWith(
        'pnpm',
        ['test'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });

    it('does not run test when a parallel task fails', async () => {
      const procs = captureProcs();
      const promise = main();
      await waitForExecaCalls(4);
      procs[0]!._reject(new Error('lint failed'));
      await expect(promise).rejects.toThrow('lint failed');
      expect(mockExeca).toHaveBeenCalledTimes(4);
      expect(mockExeca).not.toHaveBeenCalledWith(
        'pnpm',
        ['test'],
        expect.objectContaining({ stdio: 'inherit' })
      );
    });
  });
});
