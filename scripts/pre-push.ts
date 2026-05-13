import { execa } from 'execa';

export interface Task {
  name: string;
  command: string;
  args: readonly string[];
}

export const PARALLEL_TASKS: readonly Task[] = [
  { name: 'lint:duplication', command: 'pnpm', args: ['lint:duplication'] },
  { name: 'lint:unused', command: 'pnpm', args: ['lint:unused'] },
  { name: 'lint', command: 'pnpm', args: ['lint'] },
  { name: 'typecheck', command: 'pnpm', args: ['typecheck'] },
];

export const TEST_TASK: Task = { name: 'test', command: 'pnpm', args: ['test'] };

type Subprocess = ReturnType<typeof execa>;

function killSiblings(subprocesses: readonly Subprocess[], except: Subprocess): void {
  for (const sp of subprocesses) {
    if (sp !== except && sp.exitCode === null && !sp.killed) {
      sp.kill('SIGTERM');
    }
  }
}

export async function runParallel(tasks: readonly Task[]): Promise<void> {
  const subprocesses: Subprocess[] = tasks.map((t) =>
    execa(t.command, [...t.args], { stdio: 'inherit', reject: true })
  );

  let firstError: Error | undefined;

  async function watch(sp: Subprocess): Promise<void> {
    try {
      await sp;
    } catch (error: unknown) {
      if (firstError !== undefined) return;
      firstError = error instanceof Error ? error : new Error(String(error));
      killSiblings(subprocesses, sp);
    }
  }

  await Promise.all(subprocesses.map((sp) => watch(sp)));

  if (firstError !== undefined) {
    throw firstError;
  }
}

export async function runSequential(task: Task): Promise<void> {
  await execa(task.command, [...task.args], { stdio: 'inherit', reject: true });
}

export async function main(): Promise<void> {
  console.log(`Running in parallel: ${PARALLEL_TASKS.map((t) => t.name).join(', ')}`);
  await runParallel(PARALLEL_TASKS);
  console.log('Static checks passed. Running tests...');
  await runSequential(TEST_TASK);
}

/* v8 ignore start -- CLI entry point uses process.exit, exercised via husky */
const isMain = import.meta.url === `file://${String(process.argv[1])}`;
if (isMain) {
  void (async () => {
    try {
      await main();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`pre-push failed: ${message}`);
      process.exit(1);
    }
  })();
}
/* v8 ignore stop */
