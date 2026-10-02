import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  formatReport,
  packageVitestTaskStatus,
  playwrightTaskStatus,
  poolTaskEstimates,
  poolTaskStatus,
  vitestTaskStatus,
  type MachineSummary,
  type TaskStatus,
} from './lib/pool/concurrency-report.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { describeMachine, machineFingerprint, performanceCoreCount } from './lib/pool/machine.js';
import { ledgerPath, readLedger } from './lib/pool/ledger.js';
import { PLANNING_MEMORY_FRACTION, memoryBudgetKb } from './lib/pool/memory.js';
import { E2E_WORKER_POOL_SIZE, resolveLocalWorkerCount } from './lib/playwright/worker-count.js';
import { runMain } from './lib/cli/run-main.js';
import {
  deriveRepositoryVitestWorkers,
  type VitestWorkerDerivation,
} from './lib/vitest/workers.js';

import type { RunObservation } from './lib/pool/schedule.js';

/**
 * `pnpm concurrency` — what each check would open if it ran now, and whether
 * the pool has finished working that number out. Reads only; it starts no work,
 * which is the property that makes it the one command safe to run beside live
 * work, and it is why a count here is resolved by calling the derivation that
 * owns it rather than by loading the configuration that declares it.
 *
 * A check the pool does not tune earns a row all the same: the question the
 * command answers is where a number came from, and a mechanism it omits is that
 * question answered wrongly by silence.
 *
 * The memory budget is read once per derivation rather than once per command,
 * so one report carries several figures and they disagree whenever the
 * machine's free memory moved between them. That is the behaviour a real run
 * has — each count is priced against what was free when it was derived — and
 * hoisting the readings to one would change every count that reads a later one.
 * What keeps the disagreement from reading as a fault is the memory section
 * saying so, in `lib/pool/concurrency-report.ts`.
 */

/* v8 ignore start -- CLI assembly over libraries that carry their own tests */
const POOL_TASKS = ['lint', 'typecheck'] as const;

/**
 * Reported against every package on record, or against a stand-in set where the
 * ledger names none, which is the answer a run with a cold turbo cache would
 * get. A run where most packages replay executes fewer tasks and correctly opens
 * fewer lanes, so the figure here is the ceiling of what the day will ask for
 * rather than what the next command will use.
 */
function poolStatus(repoRoot: string, fingerprint: string, task: string): TaskStatus {
  const { runs, tasks } = readLedger(ledgerPath(repoRoot, fingerprint, task));
  return poolTaskStatus({
    task,
    tasks: poolTaskEstimates(tasks),
    runs,
    ceiling: performanceCoreCount(),
    memoryBudgetKb: memoryBudgetKb(PLANNING_MEMORY_FRACTION),
  });
}

interface VitestInputs {
  readonly derivation: VitestWorkerDerivation;
  readonly runs: readonly RunObservation[];
  /** The share the count had to fit into; undefined where none could be read. */
  readonly memoryBudgetKb: number | undefined;
}

/**
 * What both vitest rows are derived from.
 *
 * One store holds every vitest invocation's history, so the two shapes read the
 * same rows and the same file walls here; what separates a real run of either
 * is the unit set it names, and neither one's is knowable before a command is
 * typed. Read once rather than per row, so the rows cannot come to disagree
 * about a store they share, and so the fold is paid once.
 *
 * Through the shared assembly rather than a list of arguments spelled here,
 * because the count this command reports is a claim about what a real run will
 * open: a second assembly resolving differently would leave this command
 * reporting a width no run takes. Every file on record is what that assembly
 * weighs, which is the ceiling of what the day will ask for rather than what
 * the next command will use.
 */
function vitestInputs(repoRoot: string, fingerprint: string): VitestInputs {
  const { derivation, observations, memoryBudgetKb } = deriveRepositoryVitestWorkers(
    repoRoot,
    fingerprint
  );
  return { derivation, runs: observations, memoryBudgetKb };
}

export function buildReport(repoRoot: string): string {
  const fingerprint = machineFingerprint();
  const descriptor = describeMachine();
  const machine: MachineSummary = {
    fingerprint,
    cpuModel: descriptor.cpuModel,
    threads: descriptor.threads,
    cores: performanceCoreCount(),
    totalMemBytes: descriptor.totalMemBytes,
  };
  const vitest = vitestInputs(repoRoot, fingerprint);
  const statuses = [
    ...POOL_TASKS.map((task) => poolStatus(repoRoot, fingerprint, task)),
    vitestTaskStatus(vitest),
    packageVitestTaskStatus(vitest),
    playwrightTaskStatus({
      workers: resolveLocalWorkerCount(),
      personaPoolSize: E2E_WORKER_POOL_SIZE,
    }),
  ];
  return formatReport(machine, statuses);
}

export const COMMAND_LINE = {
  command: 'pnpm concurrency',
  summary: 'Prints what each check would open right now, and where each number came from.',
  flags: [],
  positionals: { kind: 'none' },
  effect: 'reports',
} as const satisfies CommandSpec;

if (isMainModule(import.meta.url)) {
  await runMain(() => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    console.log(buildReport(path.dirname(scriptDir)));
    return Promise.resolve(0);
  });
}
/* v8 ignore stop */
