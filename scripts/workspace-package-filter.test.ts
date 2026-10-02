import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { describe, it, expect } from 'vitest';

const execFileAsync = promisify(execFile);

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

/**
 * A package name no workspace carries. It stands in for a package that was
 * renamed without its call sites: the exposure is a filter that stops matching,
 * and the reason it stopped is immaterial.
 */
const UNMATCHED_FILTER = '@hushbox/no-such-package';

/**
 * pnpm's default for a filter that matches nothing is a printed message and a
 * successful exit, so every command addressed to a package this way is a silent
 * no-op the moment the name drifts — including the production migration and the
 * migration-drift check in `.github/workflows/ci.yml`. What makes it non-zero is
 * `failIfNoMatch` in `pnpm-workspace.yaml`. Only running the real binary can tell
 * a setting that took effect from one that is inert, which is why these cases
 * spawn it.
 */
const SPAWN_BUDGET_MS = 180_000;

/**
 * The per-case budget exceeds the spawn's own, so a pnpm that never finishes is
 * killed here and reported as a spawn that produced no verdict, rather than
 * surfacing as vitest's generic "test timed out". Both numbers are sized to be
 * unreachable by a spawn that is merely slow — a whole-repo run starts this one
 * while the rest of the suite saturates the machine — so anything that reaches
 * them is wedged. A budget near the spawn's real cost would instead fail on
 * load, reporting a machine's speed as a verdict about the filter.
 */
const CASE_TIMEOUT_MS = SPAWN_BUDGET_MS + 30_000;

/**
 * pnpm's own wording for the rejection under test. Asserting it is what
 * separates this exit 1 from any other exit 1 the command could produce — a
 * missing script, say — so the cases cannot pass without pnpm having resolved
 * the filter and found nothing.
 */
const NO_MATCH_MESSAGE = 'No projects matched the filters';

function textOf(stream: unknown): string {
  return typeof stream === 'string' ? stream : '';
}

/** `undefined` where the process never reached an exit code of its own. */
function exitCodeOf(error: unknown): number | undefined {
  const { code } = error as { code?: unknown };

  return typeof code === 'number' ? code : undefined;
}

/**
 * A non-numeric `code` means the spawn itself failed — pnpm missing from PATH,
 * killed at the budget above — so pnpm never evaluated the filter and there is no
 * verdict to assert on. Failing loudly and by that name is the point: the earlier
 * shape collapsed this case to a sentinel the negative assertion accepted, so a
 * pnpm that never ran satisfied every case here.
 *
 * The two streams are joined because pnpm 10.26.0 prints the no-match message on
 * stdout, not stderr, and which stream carries it is not the property under test.
 */
async function runPnpm(args: readonly string[]): Promise<{ exitCode: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('pnpm', [...args], {
      cwd: REPO_ROOT,
      timeout: SPAWN_BUDGET_MS,
    });

    return { exitCode: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    const exitCode = exitCodeOf(error);

    if (exitCode === undefined) {
      throw new Error(
        `pnpm never produced a filter verdict for \`pnpm ${args.join(' ')}\` — the spawn itself failed within ${String(SPAWN_BUDGET_MS)} ms, so nothing about the filter was measured`,
        { cause: error }
      );
    }

    const { stdout, stderr } = error as { stdout?: unknown; stderr?: unknown };

    return { exitCode, output: `${textOf(stdout)}${textOf(stderr)}` };
  }
}

function expectUnmatchedFilterRejected({
  exitCode,
  output,
}: {
  exitCode: number;
  output: string;
}): void {
  expect(exitCode).toBe(1);
  expect(output).toContain(NO_MATCH_MESSAGE);
}

describe('workspace package filter', () => {
  it(
    'fails an explicit script run whose filter matches no package',
    async () => {
      expectUnmatchedFilterRejected(await runPnpm(['--filter', UNMATCHED_FILTER, 'run', 'build']));
    },
    CASE_TIMEOUT_MS
  );

  it(
    'fails a bare script invocation whose filter matches no package',
    async () => {
      expectUnmatchedFilterRejected(await runPnpm(['--filter', UNMATCHED_FILTER, 'db:migrate']));
    },
    CASE_TIMEOUT_MS
  );

  it(
    'fails an exec invocation whose filter matches no package',
    async () => {
      expectUnmatchedFilterRejected(
        await runPnpm(['--filter', UNMATCHED_FILTER, 'exec', 'node', '--version'])
      );
    },
    CASE_TIMEOUT_MS
  );
});
