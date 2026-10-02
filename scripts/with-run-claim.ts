#!/usr/bin/env tsx
/**
 * Runs a sequence of commands under one run claim.
 *
 * A composite command — prepare the stack, then do the work — used to be two
 * processes joined by a shell conjunction. Each registered its own run claim and
 * released it on exit, so between them the slot carried no live claim and a
 * destructive command taking the section in that window found nothing to refuse
 * and wiped the volumes the first half had just prepared. This holds one claim
 * across every stage instead: the stages inherit it through `HB_RUN_CLAIM` and
 * adopt rather than register, so the slot is continuously spoken for from the
 * first stage's start to the last stage's end.
 *
 * Stages are separated by {@link STAGE_SEPARATOR} and run in order, stopping at
 * the first failure and returning its exit code — the shell conjunction's
 * semantics, kept so wrapping a script changes nothing a caller can observe. A
 * package manager appends a caller's arguments to the end of the whole script
 * line, where they reach the last stage, which is where the conjunction put them
 * too.
 */
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse as parseEnvFile } from 'dotenv';
import { isMainModule } from './lib/cli/is-main.js';
import { messageChain, runMain } from './lib/cli/run-main.js';
import { generatedEnvPaths } from './generate-env.js';
import { spawnLongLived } from './lib/spawn/long-lived.js';
import { STACK_SLOT_VARIABLE, stackSlotFrom } from './lib/stack/stack-slot.js';
import { stackModeFor, stackModeFrom } from './lib/stack/stack-mode.js';
import { parseEnvModeSelection, withRunClaim } from './with-env.js';
import { STACK_MODES } from './lib/stack/port-plan.js';
import type { StackMode } from './lib/stack/port-plan.js';

/**
 * What stands where the shell conjunction stood. It is a word rather than `&&`
 * because the shell would take that one for itself, and no stage of any
 * composite carries a flag of this name.
 */
export const STAGE_SEPARATOR = '--then';

/** One command of a chain, spelled the way a spawn takes it. */
export interface Stage {
  readonly file: string;
  readonly args: readonly string[];
}

function toStage(tokens: readonly string[]): Stage {
  const [file, ...args] = tokens;
  if (file === undefined) {
    throw new Error(
      `with-run-claim: a stage is missing its command. Stages are separated by ` +
        `\`${STAGE_SEPARATOR}\`, and each names a command to run.`
    );
  }
  // No command is named as a flag, so one here is a separator that split an
  // argument list rather than a chain — the hazard of reserving a word the
  // shell did not reserve. Refused before the first stage runs, because the
  // stage that would fail is the last and the ones before it are the slow ones.
  if (file.startsWith('-')) {
    throw new Error(
      `with-run-claim: "${file}" names no command, so \`${STAGE_SEPARATOR}\` before it was ` +
        `taken for a stage separator when it was meant as an argument. Stage separators are ` +
        `the chain's own; a stage cannot carry one in its arguments.`
    );
  }
  return { file, args };
}

/** The stages of a chain, in the order the conjunction ran them. */
export function parseStages(argv: readonly string[]): Stage[] {
  if (argv.length === 0) {
    throw new Error(
      'with-run-claim: nothing to run. Usage: with-run-claim [--env-mode <mode>] ' +
        `<command> [...args] [${STAGE_SEPARATOR} <command> [...args]]...`
    );
  }

  const groups: string[][] = [[]];
  for (const token of argv) {
    if (token === STAGE_SEPARATOR) groups.push([]);
    else groups.at(-1)?.push(token);
  }
  return groups.map((group) => toStage(group));
}

/** How a stage is actually run. Injected so a test drives the sequence itself. */
export type StageRunner = (stage: Stage) => Promise<number>;

/**
 * Runs the stages in order and answers the first non-zero exit code, leaving
 * the rest unrun. Failure propagation is the conjunction's, so a wrapped script
 * fails where and how it failed before.
 */
export async function runStages(stages: readonly Stage[], run: StageRunner): Promise<number> {
  for (const stage of stages) {
    const exitCode = await run(stage);
    if (exitCode !== 0) return exitCode;
  }
  return 0;
}

/**
 * A generated scripts file's bytes, or null when that stack's has never been
 * written. Absent is the case where nothing has been generated yet; anything
 * else is a checkout that cannot be read, which no chain should run over.
 */
function readGeneratedScripts(rootDir: string, stackMode: StackMode): string | null {
  try {
    return readFileSync(path.join(rootDir, generatedEnvPaths(stackMode).scripts), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * The slot this checkout holds, read out of a generated scripts file, or null
 * when no stack of it has been generated yet.
 *
 * A slot is checkout-scoped and not per-mode — one checkout holds at most one,
 * and every mode's generated file carries that same number — so any stack's
 * file answers the question. The named mode's file is read first and the other
 * stacks' after it, because a mode's file is written only once that mode's
 * stack has been brought up: a checkout that has run `pnpm dev` but never
 * `pnpm e2e` has no e2e file, and reading only that one would leave the whole
 * first e2e chain on the unclaimed path — the window this wrapper exists to
 * close.
 *
 * Read from the file rather than from the environment because nothing has
 * loaded the environment this early, and parsed into a value of its own rather
 * than into `process.env` because the stages must see exactly the environment
 * the shell conjunction handed them — a stack mode leaked into a stage that
 * names none would silently move it onto another stack. {@link stackSlotFrom}
 * still decides what the value means, so there is one answer to what a slot is.
 */
export function readStackSlot(rootDir: string, stackMode: StackMode): number | null {
  const modes = [stackMode, ...STACK_MODES.filter((mode) => mode !== stackMode)];
  for (const mode of modes) {
    const contents = readGeneratedScripts(rootDir, mode);
    if (contents === null) continue;
    const value = parseEnvFile(contents)[STACK_SLOT_VARIABLE];
    if (value === undefined) return null;
    return stackSlotFrom({ [STACK_SLOT_VARIABLE]: value });
  }
  return null;
}

export interface CompositeInit {
  /** This checkout's slot, or null when nothing has claimed one yet. */
  readonly slot: number | null;
  readonly mode: StackMode;
  readonly rootDir: string;
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string | undefined;
}

/**
 * Runs the chain, holding one run claim over the whole of it.
 *
 * The stages inherit the claim through the environment and adopt it, so the
 * slot is spoken for from the first stage's start to the last stage's end and a
 * wipe arriving anywhere in between is refused by the run it would have
 * destroyed. Without a slot there is nothing to be named on, and the chain runs
 * exactly as the conjunction ran it — each stage claiming for itself.
 */
export async function runComposite(
  init: CompositeInit,
  stages: readonly Stage[],
  run: StageRunner
): Promise<number> {
  if (init.slot === null) return runStages(stages, run);

  // The claim is registered at whatever the environment says the slot is, and
  // nothing has loaded the environment yet. Setting it is also what carries the
  // answer to the stages, which is inert: every stage loads the generated files
  // over it, and the slot they carry is the one read here.
  process.env[STACK_SLOT_VARIABLE] = String(init.slot);

  return withRunClaim(
    {
      command: 'with-run-claim',
      mode: init.mode,
      rootDir: init.rootDir,
      registryDir: init.registryDir,
    },
    () => runStages(stages, run)
  );
}

/** What a shell answers for a command it could not run at all. */
const NOT_RUN_EXIT_CODE = 127;

/**
 * A stage, run the way the shell conjunction ran it: inheriting this process's
 * streams and its environment, and answering an exit code rather than throwing
 * — so what a caller sees on a stage failure is what they saw before.
 *
 * Started through the long-lived spawner, which is what puts a lifeline in the
 * stage's hands. This is the outermost process of the command, so it is the one
 * an operator finds and kills when that command wedges; a stage holding no
 * lifeline outlives that kill along with everything it started, and a signal
 * aimed at this single process leaves the whole stack standing. The spawner
 * also gives the stage a group of its own and forwards to it whatever this
 * process is asked to take, which is what keeps a terminal's Ctrl+C reaching
 * the chain now that the stage is not in the terminal's own group.
 *
 * The code answered is the stage's own exit code, and a stage a signal ended
 * answers 1 rather than the shell's 128 plus the signal number: the spawner
 * reports how a child exited and not the signal behind it, which is the answer
 * `with-env` has always given for the stage it starts.
 */
export async function execStage(stage: Stage): Promise<number> {
  try {
    const child = await spawnLongLived(stage.file, stage.args, { stdio: 'inherit', ports: [] });
    return await child.exit;
  } catch (error) {
    // A stage that never started carries the spawn's own reason nowhere else:
    // unprinted, the chain would end on a bare failure saying nothing about a
    // command that does not exist. A shell prints the reason too.
    console.error(
      `with-run-claim: the stage \`${stage.file}\` never started: ${messageChain(error)}`
    );
    return NOT_RUN_EXIT_CODE;
  }
}

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const rootDir = path.resolve(scriptDir, '..');
    const { envMode, rest } = parseEnvModeSelection(process.argv.slice(2));
    const mode = envMode === undefined ? stackModeFrom(process.env) : stackModeFor(envMode);
    return runComposite(
      { slot: readStackSlot(rootDir, mode), mode, rootDir },
      parseStages(rest),
      execStage
    );
  });
}
/* v8 ignore stop */
