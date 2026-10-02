#!/usr/bin/env tsx
/**
 * Runs every check unconditionally and aggregates the result, so a failing
 * check can never keep a later one from running or from being reported.
 * Replaces `&&`-chained package scripts, where a failure in an earlier
 * command silently skipped every command after it while the shell still
 * reported one verdict.
 *
 * Command syntax: repeated `:: <label> <program> [args...]` groups, optionally
 * closed by `::end`. The scripts that invoke this file are the worked examples.
 *
 * A package manager appends a caller's arguments to the end of the whole script
 * line, where they join the last group's own arguments and reach that one lane
 * only. `::end` marks where the declaration stops, so anything after it is a
 * caller's appended argument and the run refuses it, naming each lane's command
 * so the caller can put the argument on the lane that answers it. A composition
 * that leaves the terminator off keeps the forwarding, which is what a lane
 * built to take passthrough arguments needs.
 */
import { isMainModule } from './lib/cli/is-main.js';
import { runMain } from './lib/cli/run-main.js';
import { FORWARDED_SIGNALS, spawnLongLived, type TreeSignal } from './lib/spawn/long-lived.js';

/** The sequence that stands between the groups of a composed command. */
export const GROUP_SEPARATOR = '::';

/**
 * The sequence that closes a declaration, after which anything is a package
 * manager's appended argument rather than a group's own.
 */
export const DECLARATION_END = '::end';

export interface CheckSpec {
  readonly label: string;
  readonly program: string;
  readonly args: readonly string[];
}

/** Parses one `<label> <program> [args...]` group starting just after its separator. */
function parseGroup(args: readonly string[], start: number): { spec: CheckSpec; next: number } {
  const label = args[start];
  if (label === undefined) {
    throw new Error(`Missing label after "${GROUP_SEPARATOR}"`);
  }
  const tail = args.slice(start + 1);
  const relativeEnd = tail.indexOf(GROUP_SEPARATOR);
  const next = relativeEnd === -1 ? args.length : start + 1 + relativeEnd;
  const [program, ...rest] = relativeEnd === -1 ? tail : tail.slice(0, relativeEnd);
  if (program === undefined) {
    throw new Error(`Missing command for check "${label}"`);
  }
  return { spec: { label, program, args: rest }, next };
}

/**
 * The refusal a caller reads instead of watching their argument land on one
 * lane. Every lane is printed through `pnpm exec` so the line is runnable as
 * printed from the repository root — a lane program is a workspace binary, on
 * PATH inside a package script and nowhere else.
 */
function appendedArgumentsMessage(
  appended: readonly string[],
  checks: readonly CheckSpec[]
): string {
  const lanes = checks.map(
    (check) => `  [${check.label}] pnpm exec ${[check.program, ...check.args].join(' ')}`
  );
  return [
    `run-checks: this command takes no arguments of its own; got: ${appended.join(' ')}`,
    'A package manager appends them to the end of the whole script line, so they reach whichever',
    'lane is written last instead of the one meant to answer them. Run the lane that answers them',
    'directly, with the arguments on it:',
    ...lanes,
  ].join('\n');
}

/** Parses repeated `:: <label> <program> [args...]` groups into check specs. */
export function parseChecks(args: readonly string[]): CheckSpec[] {
  const terminator = args.indexOf(DECLARATION_END);
  const declared = terminator === -1 ? args : args.slice(0, terminator);
  const checks: CheckSpec[] = [];
  let index = 0;
  while (index < declared.length) {
    if (declared[index] !== GROUP_SEPARATOR) {
      throw new Error(`Expected "${GROUP_SEPARATOR}" at position ${String(index)}`);
    }
    const { spec, next } = parseGroup(declared, index + 1);
    checks.push(spec);
    index = next;
  }
  if (checks.length === 0) {
    throw new Error(`run-checks requires at least one "${GROUP_SEPARATOR}" group`);
  }
  const appended = terminator === -1 ? [] : args.slice(terminator + 1);
  if (appended.length > 0) {
    throw new Error(appendedArgumentsMessage(appended, checks));
  }
  return checks;
}

export interface CheckOutcome {
  readonly label: string;
  readonly exitCode: number;
}

export interface CheckRunner {
  readonly run: (check: CheckSpec) => Promise<number>;
}

/**
 * One lane, run the way a shell conjunction ran it: inheriting this process's
 * streams and answering an exit code.
 *
 * Started through the long-lived spawner, which is what puts a lifeline in the
 * lane's hands. This process is the outermost of the command — `dev:restart` is
 * this file with the development stack as a lane — so it is the one an operator
 * finds and kills when that command wedges; a lane holding no lifeline outlives
 * that kill along with everything it started, and a signal aimed at this single
 * process leaves the whole stack standing. The spawner also gives the lane a
 * group of its own and forwards to it whatever this process is asked to take,
 * which is what keeps a terminal's Ctrl+C reaching the lane now that the lane
 * is not in the terminal's own group.
 *
 * No port is claimed here: what a lane binds is known only where that lane was
 * chosen, and the entry points that start servers claim their own.
 *
 * `interrupted` is asked again on the far side of the spawn because the lane's
 * forwarder is armed inside it: a signal arriving while the lane was starting
 * reaches this process's watch and reaches nothing that would end the lane, so
 * without this second reading the lane runs on — and where the lane is the
 * development stack, it runs on for good.
 */
export async function execCheck(
  check: CheckSpec,
  spawn: typeof spawnLongLived = spawnLongLived,
  interrupted: () => boolean = () => false
): Promise<number> {
  const child = await spawn(check.program, check.args, { stdio: 'inherit', ports: [] });
  if (interrupted()) return child.kill();
  return child.exit;
}

/**
 * Runs every check regardless of an earlier one's outcome — including a
 * runner that throws, so a crashed check still leaves the rest attributed
 * rather than aborting the whole aggregation.
 *
 * `interrupted` is the one thing that stops it early, and it is asked rather
 * than inferred: a lane ended by a signal and a lane that failed both answer
 * the same exit code, so nothing in an outcome can tell an operator's Ctrl+C
 * from a red check. Carrying on past a red check is the reason this runner
 * exists; carrying on past a stop would start the next lane — the development
 * stack, or a whole package batch — after the operator asked for none.
 */
export async function runChecks(
  checks: readonly CheckSpec[],
  runner: CheckRunner,
  interrupted: () => boolean = () => false
): Promise<CheckOutcome[]> {
  const outcomes: CheckOutcome[] = [];
  for (const check of checks) {
    if (interrupted()) break;
    let exitCode: number;
    try {
      exitCode = await runner.run(check);
    } catch (error: unknown) {
      console.error(`[${check.label}] ${error instanceof Error ? error.message : String(error)}`);
      exitCode = 1;
    }
    outcomes.push({ label: check.label, exitCode });
  }
  return outcomes;
}

/**
 * Failure if any check failed, and failure if the run was stopped before it
 * reached every check: a command an operator interrupted has not passed,
 * whatever the checks that did run answered. Names every failing label so a
 * red verdict is attributable without re-running anything.
 */
export function summarize(
  outcomes: readonly CheckOutcome[],
  stopped = false
): {
  readonly exitCode: number;
  readonly message: string;
} {
  const failed = outcomes.filter((outcome) => outcome.exitCode !== 0);
  const lines: string[] = [];
  if (failed.length > 0) {
    const names = failed.map((outcome) => outcome.label).join(', ');
    lines.push(`FAILED: ${names} (${String(failed.length)}/${String(outcomes.length)})`);
  }
  if (stopped) lines.push('STOPPED: interrupted, so nothing after it was run');
  return { exitCode: lines.length === 0 ? 0 : 1, message: lines.join('\n') };
}

/** Where a process is asked to stop, seen from this runner. */
export interface InterruptWatchHost {
  readonly on: (signal: TreeSignal, handler: () => void) => void;
  readonly off: (signal: TreeSignal, handler: () => void) => void;
}

export interface InterruptWatch {
  /** Whether a terminating signal has reached this process. */
  readonly interrupted: () => boolean;
  /** Gives every watched signal back the action it had. */
  readonly release: () => void;
}

/** The process this runner is, which is what it watches in production. */
function processInterrupts(): InterruptWatchHost {
  return {
    on: (signal, handler) => {
      process.on(signal, handler);
    },
    off: (signal, handler) => {
      process.off(signal, handler);
    },
  };
}

/**
 * Records that this process was asked to stop.
 *
 * The signals are the ones the spawner forwards to a lane, because that is the
 * same event seen from the other side: the operator's signal reaches this
 * process, the spawner's forwarder passes it down to the lane's group, and this
 * is what remembers it happened once the lane's exit code — indistinguishable
 * from any other failure — comes back.
 *
 * Watching a signal suppresses its default action, so the watch ends at the
 * first one it sees: a second signal then reaches the escalation the spawner's
 * forwarder offers, or the default action, which is what an operator pressing
 * Ctrl+C twice is asking for.
 */
export function watchInterrupts(host: InterruptWatchHost = processInterrupts()): InterruptWatch {
  let seen = false;

  function release(): void {
    for (const signal of FORWARDED_SIGNALS) host.off(signal, onSignal);
  }

  function onSignal(): void {
    seen = true;
    release();
  }

  for (const signal of FORWARDED_SIGNALS) host.on(signal, onSignal);

  return { interrupted: () => seen, release };
}

/* v8 ignore start -- CLI entry point exercised via the package `typecheck` scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const checks = parseChecks(process.argv.slice(2));
    const watch = watchInterrupts();
    const outcomes = await runChecks(
      checks,
      {
        run: async (check) => {
          console.log(`\n> [${check.label}] ${check.program} ${check.args.join(' ')}`);
          return execCheck(check, spawnLongLived, watch.interrupted);
        },
      },
      watch.interrupted
    );
    watch.release();
    const { exitCode, message } = summarize(outcomes, watch.interrupted());
    if (message) console.error(`\n${message}`);
    return exitCode;
  });
}
/* v8 ignore stop */
