/**
 * The read-only auditor over the scheduled gates: did each one's last run leave
 * the verdict it exists to produce?
 *
 * A gate that dies before it reaches a verdict and a gate that reaches a failing
 * one look the same from outside — a red run nobody opens — and the second is
 * the gate working. Only the first means nothing measured anything, and it is
 * the one with no signal of its own: the mutation gate failed every scheduled
 * run it has ever had, over months, and it took someone running the chain by
 * hand for an unrelated reason to notice.
 *
 * What separates the two is what the run left behind. A gate that reached a
 * verdict published it as an artifact, pass or fail; a gate that died before its
 * runner existed published nothing. That artifact is already how these gates
 * carry their reports, so this reads an existing channel rather than adding one.
 *
 * The alert is one issue, opened when a gate leaves no verdict and closed when
 * every gate leaves one — the same mechanism, and the same single-issue-per-
 * condition rule, as the auditor over the publication topology. Alerting stops
 * there deliberately: a second delivery path for the same condition is the thing
 * this repository does not build.
 *
 * The limit of the mechanism is stated in the table below rather than worked
 * around: an auditor cannot be the thing that reports its own absence, and a
 * gate that publishes nothing has nothing this can read.
 */
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import { readRepositories } from './configure-git-clone.js';
import {
  newestCompletedRun,
  reconcileIssue,
  runArtifactNames,
  type IssueAction,
  type RepositoryApi,
} from './lib/publication/api.js';
import {
  GUARDED_WORKFLOWS,
  PUBLIC_REPOSITORY_VARIABLE,
  triggerEventsOf,
  workflowFiles,
  type GuardedWorkflow,
} from './lib/publication/guarded-workflows.js';

/** The trigger that makes a workflow a scheduled one, and so this auditor's subject. */
const SCHEDULE_TRIGGER = 'schedule';

/** Stable, so the auditor recognises its own issue across passes. */
export const NO_VERDICT_ISSUE_TITLE = 'A scheduled gate produced no verdict';

/** A scheduled gate and the artifact its run publishes on reaching a verdict. */
export interface VerdictGate {
  readonly file: string;
  readonly verdict: string;
}

/** A scheduled workflow whose verdict no outside reader can see, and why. */
export interface ExcusedGate {
  readonly file: string;
  readonly reason: string;
}

export const VERDICT_GATES: readonly VerdictGate[] = [
  { file: 'mutation.yml', verdict: 'mutation-report' },
];

/**
 * The scheduled workflows in the repository this auditor reads whose verdict no
 * outside reader can see. An entry here is a limit of the mechanism stated where
 * a reader will meet it, not a file nobody looked at, which is why the
 * reconciliation reads this list rather than skipping what the watched table
 * does not carry. A workflow excused for running somewhere else is not written
 * here — {@link excusedGates} derives that from the guarded table.
 */
export const GATES_WITHOUT_A_READABLE_VERDICT: readonly ExcusedGate[] = [
  {
    file: 'backup.yml',
    reason:
      'publishes nothing an outside reader can open, so its run conclusion is the whole verdict ' +
      'and the two cases this auditor separates are one case there',
  },
  {
    file: 'gate-auditor.yml',
    reason:
      'this auditor. One auditor cannot be what reports its own absence, and a second one ' +
      'watching the first would be the backup path this mechanism refuses',
  },
];

/** Which repository's runs this auditor asks about, as a workflow guard names it. */
const AUDITED_REPOSITORY_VARIABLE = PUBLIC_REPOSITORY_VARIABLE;

const elsewhereReason = (variable: string): string =>
  `runs in the repository ${variable} names rather than the one this auditor reads, so no run ` +
  'of it is visible from here';

/**
 * Every scheduled workflow this auditor cannot report on: the ones stated above,
 * and the ones the guarded table confines to a repository this auditor never
 * asks. The second set is derived rather than restated, so a workflow re-pointed
 * at the audited repository stops being excused with no list to edit — and then
 * has to be watched or stated before the completeness assertion passes again.
 */
export function excusedGates(
  directory: string,
  guarded: readonly GuardedWorkflow[] = GUARDED_WORKFLOWS
): ExcusedGate[] {
  const elsewhere = scheduledWorkflowFiles(directory).flatMap((file) => {
    const variable = guarded.find((workflow) => workflow.file === file)?.variable;
    if (variable === undefined || variable === AUDITED_REPOSITORY_VARIABLE) return [];
    return [{ file, reason: elsewhereReason(variable) }];
  });
  return [...GATES_WITHOUT_A_READABLE_VERDICT, ...elsewhere].toSorted((left, right) =>
    left.file.localeCompare(right.file)
  );
}

/** A watched gate whose last run left no verdict, and where that run can be opened. */
export interface GateFinding {
  readonly file: string;
  readonly verdict: string;
  /** The run that left nothing, or `null` where no run of the gate has finished. */
  readonly run: string | null;
}

export interface GateAuditResult {
  readonly findings: GateFinding[];
  readonly issue: IssueAction;
}

/** Every workflow file in the directory a schedule can start. */
export function scheduledWorkflowFiles(directory: string): string[] {
  return workflowFiles(directory).filter((name) =>
    triggerEventsOf(directory, name).includes(SCHEDULE_TRIGGER)
  );
}

/**
 * The newest run that finished is what is asked about, whatever it concluded. A
 * gate that failed and published its report is reporting; a gate whose newest
 * green run predates the breakage would answer for a run that is no longer the
 * state of anything.
 */
async function judge(api: RepositoryApi, gate: VerdictGate): Promise<GateFinding | null> {
  const run = await newestCompletedRun(api, gate.file);
  if (run === null) return { file: gate.file, verdict: gate.verdict, run: null };
  const published = await runArtifactNames(api, run.id);
  if (published.includes(gate.verdict)) return null;
  return { file: gate.file, verdict: gate.verdict, run: run.url };
}

/**
 * Every gate is asked on every pass. Stopping at the first would report one
 * silent gate and hide the rest behind it, and a gate nobody is told about is
 * the whole failure this exists to end.
 */
export async function findViolations(
  api: RepositoryApi,
  gates: readonly VerdictGate[]
): Promise<GateFinding[]> {
  const judged = await Promise.all(gates.map(async (gate) => judge(api, gate)));
  return judged.filter((finding): finding is GateFinding => finding !== null);
}

const ALL_CLEAR = 'Every watched scheduled gate’s newest finished run published its verdict.';

const NO_VERDICT_TEXT =
  'A scheduled gate finished without producing a verdict. A gate that runs and reports a ' +
  'failing verdict is working, and is not reported here; each gate below left nothing to read ' +
  'at all, so nothing has measured what it measures.';

function describeFinding(finding: GateFinding): string {
  if (finding.run === null) {
    return `${finding.file} has no completed run, so its gate has never reported.`;
  }
  return (
    `${finding.file} finished without publishing ${finding.verdict}, the artifact its gate ` +
    `leaves whenever it reaches a verdict, so nothing states what it found. The run: ${finding.run}`
  );
}

export function describeFindings(findings: readonly GateFinding[]): string {
  if (findings.length === 0) return ALL_CLEAR;
  return [NO_VERDICT_TEXT, ...findings.map((finding) => describeFinding(finding))].join('\n\n');
}

export async function audit(
  api: RepositoryApi,
  gates: readonly VerdictGate[]
): Promise<GateAuditResult> {
  const findings = await findViolations(api, gates);
  const alert = findings.length > 0 ? describeFindings(findings) : null;
  return { findings, issue: await reconcileIssue(api, NO_VERDICT_ISSUE_TITLE, alert) };
}

/** The workflow token, which is all this needs: it reads runs and files one issue. */
const TOKEN_VARIABLE = 'GITHUB_TOKEN';

export const COMMAND_LINE = {
  command: 'tsx scripts/gate-auditor.ts',
  summary: 'Reports on scheduled gates whose last run produced no verdict.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point, exercised through CI */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const token = process.env[TOKEN_VARIABLE];
    if (token === undefined || token === '') {
      throw new Error(`The gate auditor needs ${TOKEN_VARIABLE}; it was not provided.`);
    }
    const { publicRepo } = await readRepositories();
    const result = await audit({ fetchImpl: fetch, token, repository: publicRepo }, VERDICT_GATES);
    const report = describeFindings(result.findings);
    if (result.findings.length > 0) {
      console.error(report);
      return 1;
    }
    console.log(report);
    return 0;
  });
}
/* v8 ignore stop */
