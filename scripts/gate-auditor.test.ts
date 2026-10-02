import { cp } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { parse } from 'yaml';
import { describe, it, expect } from 'vitest';
import { withScratchDirectory } from './lib/scratch-directory.js';
import {
  GUARDED_WORKFLOWS,
  PUBLIC_REPOSITORY_VARIABLE,
  STAGING_REPOSITORY_VARIABLE,
  WORKFLOWS_DIRECTORY,
  type GuardedWorkflow,
} from './lib/publication/guarded-workflows.js';
import {
  GATES_WITHOUT_A_READABLE_VERDICT,
  NO_VERDICT_ISSUE_TITLE,
  VERDICT_GATES,
  audit,
  describeFindings,
  excusedGates,
  findViolations,
  scheduledWorkflowFiles,
  type GateFinding,
  type VerdictGate,
} from './gate-auditor.js';
import type { RepositoryApi } from './lib/publication/api.js';

const TOKEN = 'workflow-token';
const REPOSITORY = 'Example-Org/Example';
const GATE: VerdictGate = { file: 'example.yml', verdict: 'example-report' };
const RUN_URL = 'https://example.invalid/runs/12';

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: string | undefined;
}

interface StubOptions {
  readonly run?: { readonly id: number; readonly url: string } | null;
  readonly artifacts?: readonly string[];
  readonly openIssues?: readonly { number: number; title: string }[];
}

/** The run listing, which answers with the newest finished run or with none. */
function runsAnswer(options: StubOptions): Response {
  const run = options.run === undefined ? { id: 12, url: RUN_URL } : options.run;
  const runs = run === null ? [] : [{ id: run.id, html_url: run.url }];
  return Response.json({ workflow_runs: runs }, { status: 200 });
}

/**
 * The endpoints one pass touches: the newest finished run of each watched gate,
 * what that run published, the open issues, and the two writes.
 */
function answerFor(url: string, options: StubOptions): Response {
  if (url.includes('/actions/workflows/')) return runsAnswer(options);
  if (url.includes('/artifacts')) {
    const artifacts = (options.artifacts ?? []).map((name) => ({ name }));
    return Response.json({ artifacts }, { status: 200 });
  }
  if (url.includes('/issues?')) return Response.json(options.openIssues ?? [], { status: 200 });
  return Response.json({ number: 1 }, { status: 200 });
}

function stubApi(options: StubOptions): { api: RepositoryApi; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = ((url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return Promise.resolve(answerFor(url, options));
  }) as unknown as typeof fetch;
  return { api: { fetchImpl, token: TOKEN, repository: REPOSITORY }, calls };
}

describe('the verdict a run leaves behind', () => {
  it('reads a run that published the gate’s verdict as having produced one', async () => {
    const { api } = stubApi({ artifacts: [GATE.verdict] });

    expect(await findViolations(api, [GATE])).toEqual<GateFinding[]>([]);
  });

  it('reads a run that published nothing as having produced no verdict', async () => {
    const { api } = stubApi({ artifacts: [] });

    expect(await findViolations(api, [GATE])).toEqual<GateFinding[]>([
      { file: GATE.file, verdict: GATE.verdict, run: RUN_URL },
    ]);
  });

  /**
   * The whole distinction this exists to draw. Both runs failed; one reported
   * what it found and one never got far enough to find anything, and only the
   * second is a gate nobody can read.
   */
  it('separates a gate that failed with a verdict from one that failed without one', async () => {
    const reported = stubApi({ artifacts: [GATE.verdict] });
    const silent = stubApi({ artifacts: [] });

    expect(await findViolations(reported.api, [GATE])).toEqual<GateFinding[]>([]);
    expect(await findViolations(silent.api, [GATE])).toEqual<GateFinding[]>([
      { file: GATE.file, verdict: GATE.verdict, run: RUN_URL },
    ]);
  });

  it('reads a run that published something else as having produced no verdict', async () => {
    const { api } = stubApi({ artifacts: ['a-different-upload'] });

    expect(await findViolations(api, [GATE])).toEqual<GateFinding[]>([
      { file: GATE.file, verdict: GATE.verdict, run: RUN_URL },
    ]);
  });

  it('reads a gate no run has ever completed as having produced no verdict', async () => {
    const { api } = stubApi({ run: null });

    expect(await findViolations(api, [GATE])).toEqual<GateFinding[]>([
      { file: GATE.file, verdict: GATE.verdict, run: null },
    ]);
  });

  it('asks every watched gate rather than stopping at the first that answered', async () => {
    const other: VerdictGate = { file: 'other.yml', verdict: 'other-report' };
    const { api } = stubApi({ artifacts: [] });

    const findings = await findViolations(api, [GATE, other]);

    expect(findings.map((finding) => finding.file)).toEqual([GATE.file, other.file]);
  });
});

describe('what the alert says', () => {
  it('names the gate, the verdict it owes and the run that left none', () => {
    const text = describeFindings([{ file: GATE.file, verdict: GATE.verdict, run: RUN_URL }]);

    expect(text).toContain(GATE.file);
    expect(text).toContain(GATE.verdict);
    expect(text).toContain(RUN_URL);
  });

  it('says so plainly when a gate has never run at all', () => {
    const text = describeFindings([{ file: GATE.file, verdict: GATE.verdict, run: null }]);

    expect(text).toContain('no completed run');
  });

  it('reports every gate rather than only the first', () => {
    const text = describeFindings([
      { file: GATE.file, verdict: GATE.verdict, run: RUN_URL },
      { file: 'other.yml', verdict: 'other-report', run: null },
    ]);

    expect(text).toContain(GATE.file);
    expect(text).toContain('other.yml');
  });

  it('states the all-clear when every watched gate left its verdict', () => {
    expect(describeFindings([])).toContain('verdict');
  });
});

describe('the alert', () => {
  it('is filed when a watched gate produced no verdict', async () => {
    const { api, calls } = stubApi({ artifacts: [] });

    const result = await audit(api, [GATE]);

    expect(result.issue).toBe('opened');
    expect(JSON.parse(calls.at(-1)?.body ?? '{}')).toEqual({
      title: NO_VERDICT_ISSUE_TITLE,
      body: describeFindings([{ file: GATE.file, verdict: GATE.verdict, run: RUN_URL }]),
    });
  });

  it('is closed once every watched gate leaves its verdict again', async () => {
    const { api, calls } = stubApi({
      artifacts: [GATE.verdict],
      openIssues: [{ number: 9, title: NO_VERDICT_ISSUE_TITLE }],
    });

    const result = await audit(api, [GATE]);

    expect(result.issue).toBe('closed');
    expect(calls.at(-1)?.method).toBe('PATCH');
  });
});

/** A workflow the guarded table places in the repository this auditor never reads. */
const ELSEWHERE = 'groom-linear.yml';

/** The same table with one row moved to the repository this auditor does read. */
const rePointedAt = (variable: string): readonly GuardedWorkflow[] =>
  GUARDED_WORKFLOWS.map((workflow) =>
    workflow.file === ELSEWHERE ? { ...workflow, variable } : workflow
  );

describe('the excuses this auditor gives', () => {
  it('excuses a workflow the guarded table places in another repository', () => {
    const excused = excusedGates(WORKFLOWS_DIRECTORY).map((gate) => gate.file);

    expect(excused).toContain(ELSEWHERE);
  });

  it('takes no entry of its own to excuse it, so the excuse cannot be a stale sentence', () => {
    const stated = GATES_WITHOUT_A_READABLE_VERDICT.map((gate) => gate.file);

    expect(stated).not.toContain(ELSEWHERE);
  });

  it('stops excusing it once the table points it at the repository this auditor reads', () => {
    const excused = excusedGates(WORKFLOWS_DIRECTORY, rePointedAt(PUBLIC_REPOSITORY_VARIABLE)).map(
      (gate) => gate.file
    );

    expect(excused).not.toContain(ELSEWHERE);
  });

  it('names the variable that placed a workflow elsewhere, rather than asserting where it runs', () => {
    const excused = excusedGates(WORKFLOWS_DIRECTORY).find((gate) => gate.file === ELSEWHERE);

    expect(excused?.reason).toContain(STAGING_REPOSITORY_VARIABLE);
  });

  it('says of every excused file why no verdict of it can be read', () => {
    const silent = excusedGates(WORKFLOWS_DIRECTORY).filter((gate) => gate.reason === '');

    expect(silent).toEqual([]);
  });
});

/** A scheduled workflow no list here carries, staged only inside a copy. */
const UNPLACED_WORKFLOW = 'an-unplaced-gate.yml';

const SCHEDULED_WORKFLOW_BODY = "on:\n  schedule:\n    - cron: '0 0 * * *'\n";

/**
 * The assertions below are properties of a workflow directory, so they are
 * driven against a copy. Nothing here writes into the directory the repository
 * ships.
 */
async function withWorkflowsCopy(body: (directory: string) => void | Promise<void>): Promise<void> {
  await withScratchDirectory('hushbox-gate-auditor-workflows-', async (scratch) => {
    const directory = path.join(scratch, 'workflows');
    await cp(WORKFLOWS_DIRECTORY, directory, { recursive: true });
    await body(directory);
  });
}

/**
 * The union the completeness assertion measures the directory against: every
 * scheduled workflow this auditor watches, plus every one it is excused from.
 */
function placedFiles(
  directory: string,
  guarded: readonly GuardedWorkflow[] = GUARDED_WORKFLOWS
): string[] {
  return [
    ...VERDICT_GATES.map((gate) => gate.file),
    ...excusedGates(directory, guarded).map((gate) => gate.file),
  ].toSorted((left, right) => left.localeCompare(right));
}

describe('the table against the workflows directory', () => {
  it('places every workflow a schedule can start', () => {
    expect(scheduledWorkflowFiles(WORKFLOWS_DIRECTORY)).toEqual(placedFiles(WORKFLOWS_DIRECTORY));
  });

  it('places each of them once, so a file cannot be both watched and excused', () => {
    const watched = VERDICT_GATES.map((gate) => gate.file);
    const excused = new Set(excusedGates(WORKFLOWS_DIRECTORY).map((gate) => gate.file));

    expect(watched.filter((file) => excused.has(file))).toEqual([]);
  });

  it('reads the same directory as placed when nothing has been added to it', async () => {
    await withWorkflowsCopy((directory) => {
      expect(scheduledWorkflowFiles(directory)).toEqual(placedFiles(directory));
    });
  });

  /**
   * The assertion above is only worth having while it can fail, so this drives
   * the identical comparison against a copy holding a scheduled workflow neither
   * list places. The pair also separates the two ways it could fail: the copy
   * alone still passes, so what fails below is the added file and not the copy.
   */
  it('reads a scheduled workflow neither list places as unplaced', async () => {
    await withWorkflowsCopy((directory) => {
      writeFileSync(path.join(directory, UNPLACED_WORKFLOW), SCHEDULED_WORKFLOW_BODY);

      expect(scheduledWorkflowFiles(directory)).not.toEqual(placedFiles(directory));
    });
  });

  it('places it again once the guarded table says which repository runs it', async () => {
    await withWorkflowsCopy((directory) => {
      writeFileSync(path.join(directory, UNPLACED_WORKFLOW), SCHEDULED_WORKFLOW_BODY);
      const guarded = [
        ...GUARDED_WORKFLOWS,
        { file: UNPLACED_WORKFLOW, variable: STAGING_REPOSITORY_VARIABLE, jobs: [] },
      ];

      expect(scheduledWorkflowFiles(directory)).toEqual(placedFiles(directory, guarded));
    });
  });
});

/** What a workflow calls the step that publishes an artifact. */
const UPLOAD_ARTIFACT_ACTION = 'actions/upload-artifact';

const RENAMED_ARTIFACT = 'a-renamed-artifact';

interface UploadStep {
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
}

interface ParsedWorkflow {
  readonly jobs?: Record<string, { readonly steps?: UploadStep[] }>;
}

/** The names a workflow's own upload steps give the artifacts they publish. */
function uploadedArtifactNames(directory: string, file: string): string[] {
  const workflow = parse(readFileSync(path.join(directory, file), 'utf8')) as ParsedWorkflow;
  return Object.values(workflow.jobs ?? {})
    .flatMap((job) => job.steps ?? [])
    .filter((step) => (step.uses ?? '').startsWith(UPLOAD_ARTIFACT_ACTION))
    .map((step) => step.with?.['name'])
    .filter((name): name is string => typeof name === 'string');
}

function renameUpload(directory: string, file: string, from: string, to: string): void {
  const workflow = path.join(directory, file);
  writeFileSync(workflow, readFileSync(workflow, 'utf8').replace(`name: ${from}`, `name: ${to}`));
}

/**
 * The artifact a gate publishes is spelled in its workflow and again in the
 * watched table, and nothing else makes the two agree. A rename would drift
 * loudly — every run of that gate would be reported as having left no verdict —
 * but loudly is not the same as caught, so it is caught here.
 */
describe('the artifact a watched gate is expected to publish', () => {
  it('is a name that gate’s own workflow gives an upload', () => {
    for (const gate of VERDICT_GATES) {
      expect({
        file: gate.file,
        uploads: uploadedArtifactNames(WORKFLOWS_DIRECTORY, gate.file),
      }).toEqual({ file: gate.file, uploads: expect.arrayContaining([gate.verdict]) });
    }
  });

  it('is read from the workflow, so a renamed upload no longer answers for it', async () => {
    await withWorkflowsCopy((directory) => {
      for (const gate of VERDICT_GATES) {
        renameUpload(directory, gate.file, gate.verdict, RENAMED_ARTIFACT);
        const uploads = uploadedArtifactNames(directory, gate.file);

        expect({
          file: gate.file,
          carriesTheRename: uploads.includes(RENAMED_ARTIFACT),
          stillCarriesTheWatchedName: uploads.includes(gate.verdict),
        }).toEqual({
          file: gate.file,
          carriesTheRename: true,
          stillCarriesTheWatchedName: false,
        });
      }
    });
  });
});
