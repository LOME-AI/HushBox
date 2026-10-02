/**
 * Commit-date conformance as continuous integration asks it.
 *
 * The local hook normalizes and the push gate refuses, and both are skippable
 * by design — so the class the privacy objective names first, when work
 * happened, was protected by nothing a bypass could not turn off. This is the
 * check that cannot be turned off.
 *
 * It judges the commits the event introduces and never history. This
 * repository's own history deliberately does not conform, so a check reaching
 * behind the event's own starting point would be unpassable rather than useful
 * — and it is refused rather than clamped, because a range that silently became
 * "everything" is the shape that turns a gate into a permanent red.
 *
 * The range's two ends arrive through the environment rather than being
 * computed here: which two commits an event introduced is the workflow's
 * question, and every event answers it with different fields. The absent object
 * a branch creation reports is refused for the same reason: it names all of
 * history, which is the one range this must never walk.
 */
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { commitDateRefusals, type GateOutcome } from './privacy-gate.js';

export const BASE_VARIABLE = 'COMMIT_DATE_BASE';
export const HEAD_VARIABLE = 'COMMIT_DATE_HEAD';

/** Git reports a ref that did not exist as an all-zero object id. */
const ABSENT_OBJECT = /^0+$/;

function required(env: NodeJS.ProcessEnv, variable: string): string {
  const value = env[variable]?.trim() ?? '';
  if (value === '') {
    throw new Error(`${variable} names no commit, so this event's range cannot be built.`);
  }
  return value;
}

export function revisionsFromEnvironment(env: NodeJS.ProcessEnv): string[] {
  const base = required(env, BASE_VARIABLE);
  const head = required(env, HEAD_VARIABLE);
  if (ABSENT_OBJECT.test(base)) {
    throw new Error(
      `${BASE_VARIABLE} names no starting commit, so the range would be the whole history.`
    );
  }
  return [`${base}..${head}`];
}

export async function runCommitDateCheck(
  cwd: string,
  env: NodeJS.ProcessEnv
): Promise<GateOutcome> {
  const refusals = await commitDateRefusals(cwd, revisionsFromEnvironment(env));
  const report = [
    'Commit dates: every commit this event introduces, at day resolution on both stamps.',
    ...(refusals.length === 0
      ? ['  no findings']
      : refusals.map((refusal) => `  ${refusal.check}  ${refusal.detail}`)),
  ].join('\n');
  return { report, code: refusals.length === 0 ? 0 : 1 };
}

export const COMMAND_LINE = {
  command: 'tsx scripts/verify-commit-dates.ts',
  summary: "Checks that the event's commits carry day-resolution dates.",
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const outcome = await runCommitDateCheck(process.cwd(), process.env);
    console.log(outcome.report);
    return outcome.code;
  });
}
/* v8 ignore stop */
