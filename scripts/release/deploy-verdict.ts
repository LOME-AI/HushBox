/**
 * The one gate between the checks and everything that publishes: judges the
 * `needs` context of the `verdict` job and fails unless every check either
 * succeeded here, was borrowed from staging's proof of this exact commit, or
 * was skipped by a hand-pressed dispatch that ships without the checks.
 *
 * The publishing jobs run past skips only on the success of each direct need,
 * this job included, so this job's success is what stands for every check.
 * This job also runs past skipped needs, which is what lets a borrowed run
 * reach it at all, so everything a skip could hide is judged here instead: a
 * failed or cancelled need refuses in every mode, a skipped check passes only
 * in borrow or dispatch mode, and a need it was not written to judge, or one
 * missing, refuses rather than being read as fine.
 */
import { z } from 'zod';

import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from '../lib/cli/command-line.js';
import { runMain } from '../lib/cli/run-main.js';
import { BORROWED_JOBS } from '../lib/publication/borrowed-jobs.js';

/** The job whose `borrowed` output selects borrow mode. */
const BORROW_JOB = 'borrow';

/** The triggering event that selects dispatch mode: a human chose to ship without the checks. */
const DISPATCH_EVENT = 'workflow_dispatch';

const needSchema = z.object({
  result: z.enum(['success', 'failure', 'cancelled', 'skipped']),
  outputs: z.record(z.string(), z.string()),
});

const needsSchema = z.record(z.string(), needSchema);

export type Need = z.infer<typeof needSchema>;
export type Needs = Readonly<Record<string, Need>>;

export interface Verdict {
  readonly deploy: boolean;
  readonly reason: string;
}

const JUDGED: readonly string[] = [BORROW_JOB, ...BORROWED_JOBS];

const refuse = (reason: string): Verdict => ({ deploy: false, reason });

export function judgeVerdict(needs: Needs, event: string): Verdict {
  const named = Object.keys(needs);
  const unknown = named.filter((name) => !JUDGED.includes(name));
  if (unknown.length > 0) return refuse(`Needs this gate does not judge: ${unknown.join(', ')}.`);
  const missing = JUDGED.filter((name) => !named.includes(name));
  const borrow = needs[BORROW_JOB];
  if (missing.length > 0 || borrow === undefined) {
    return refuse(`Needs this gate cannot see: ${missing.join(', ')}.`);
  }

  const entries = Object.entries(needs);
  const stopped = entries
    .filter(([, need]) => need.result === 'failure' || need.result === 'cancelled')
    .map(([name]) => name);
  if (stopped.length > 0) return refuse(`Failed or cancelled: ${stopped.join(', ')}.`);

  const skipped = entries.filter(([, need]) => need.result === 'skipped').map(([name]) => name);
  if (event === DISPATCH_EVENT && skipped.length > 0) {
    return {
      deploy: true,
      reason: `Dispatched by hand: this release ships without the code-quality checks. Skipped: ${skipped.join(', ')}.`,
    };
  }

  if (borrow.result === 'success' && borrow.outputs['borrowed'] === 'true') {
    return {
      deploy: true,
      reason: "Every check succeeded here or was borrowed from staging's proof.",
    };
  }
  const unproven = entries.filter(([, need]) => need.result !== 'success').map(([name]) => name);
  if (unproven.length > 0) {
    return refuse(`Not borrowed, and these did not succeed here: ${unproven.join(', ')}.`);
  }
  return { deploy: true, reason: 'Every check succeeded here.' };
}

export function parseNeeds(text: string | undefined): Needs {
  if (text === undefined || text === '') {
    throw new Error('NEEDS, the serialized needs context, was not set.');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error: unknown) {
    throw new Error('NEEDS is not JSON.', { cause: error });
  }
  const parsed = needsSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(
      `NEEDS is not a needs context: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

function readEvent(text: string | undefined): string {
  if (text === undefined || text === '') {
    throw new Error('GITHUB_EVENT_NAME, the event that triggered this run, was not set.');
  }
  return text;
}

export function main(env: NodeJS.ProcessEnv): number {
  const needs = parseNeeds(env['NEEDS']);
  const verdict = judgeVerdict(needs, readEvent(env['GITHUB_EVENT_NAME']));
  process.stdout.write(`${verdict.reason}\n`);
  return verdict.deploy ? 0 : 1;
}

export const COMMAND_LINE = {
  command: 'tsx scripts/release/deploy-verdict.ts',
  summary: 'Judges whether every check proved this commit, so the release may proceed.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    return main(process.env);
  });
}
/* v8 ignore stop */
