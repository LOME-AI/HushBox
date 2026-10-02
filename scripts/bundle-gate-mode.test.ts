/**
 * Every workflow step that runs the bundle gate runs under a mode in which the
 * gate has a shipping bundle to read.
 *
 * The gate reports "does not apply" and exits 0 under every other mode, so a
 * step that stops naming the mode disables it silently — the same green a step
 * that ran every check produces. Nothing else in the tree asks the question: the
 * mode is named on the job rather than on the step, so reading the step alone
 * says nothing, and the gate itself cannot tell a caller that meant to skip from
 * one that forgot.
 *
 * SCOPE: workflow steps. The root script the steps run names no mode on purpose
 * — a caller under another mode is a legitimate skip — so the obligation lands
 * on the checked-in steps that exist to run the checks.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import {
  referencedScriptAt,
  reachesThroughReferences,
  rootScripts,
  tokensOf,
} from './lib/root-manifest.js';
import { ENV_MODES, ENV_MODE_VARIABLE, envModeOrDefault } from './lib/stack/stack-mode.js';
import { shipsBundlesIn } from './verify-bundle.js';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOW_DIR = ['.github', 'workflows'];

/** The gate's module, as a manifest script body names it. */
const GATE_MODULE = 'scripts/verify-bundle.ts';

/** The flag that makes the gate write its generated artifact and return before the checks. */
const UPDATE_FLAG = '--update';

interface WorkflowStep {
  readonly name?: string;
  readonly run?: string;
  readonly env?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly steps?: readonly WorkflowStep[];
  readonly env?: Record<string, unknown>;
}

interface Workflow {
  readonly env?: Record<string, unknown>;
  readonly jobs?: Record<string, WorkflowJob>;
}

/** A workflow file and what it says, named so a failure says which file. */
interface WorkflowFile {
  readonly file: string;
  readonly workflow: Workflow;
}

/** One step that runs the gate, named the way a reader finds it in the file. */
interface GateStep {
  readonly file: string;
  readonly step: string;
  /** The mode in scope where the step runs, or nothing where none is named. */
  readonly mode: string | undefined;
}

function workflowFiles(): WorkflowFile[] {
  const dir = path.join(REPO_ROOT, ...WORKFLOW_DIR);
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .map((name) => ({
      file: name,
      workflow: parse(readFileSync(path.join(dir, name), 'utf8')) as Workflow,
    }));
}

/**
 * The root scripts whose run reaches the gate's shipping-mode checks, derived
 * rather than listed: a body that reaches the module while naming the flag that
 * returns before those checks does not run them.
 */
function shippingGateScripts(): string[] {
  const scripts = rootScripts();
  return Object.entries(scripts)
    .filter(([, body]) =>
      reachesThroughReferences(
        body,
        scripts,
        (reached) => reached.includes(GATE_MODULE) && !reached.includes(UPDATE_FLAG)
      )
    )
    .map(([name]) => name);
}

/** Whether a step's command runs one of the scripts that reach the checks. */
function runsTheGate(run: string, gateScripts: readonly string[]): boolean {
  const scripts = rootScripts();
  const tokens = tokensOf(run);
  return [...tokens.keys()].some((index) => {
    const referenced = referencedScriptAt(tokens, index, scripts);
    return referenced !== undefined && gateScripts.includes(referenced.name);
  });
}

/** The value a step runs under: its own, else its job's, else its workflow's. */
function modeInScope(workflow: Workflow, job: WorkflowJob, step: WorkflowStep): string | undefined {
  for (const scope of [step.env, job.env, workflow.env]) {
    const value = scope?.[ENV_MODE_VARIABLE];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/** Every step in `files` that runs the gate, with the mode it would run under. */
function gateSteps(files: readonly WorkflowFile[]): GateStep[] {
  const gateScripts = shippingGateScripts();
  return files.flatMap(({ file, workflow }) =>
    Object.values(workflow.jobs ?? {}).flatMap((job) =>
      (job.steps ?? [])
        .filter((step) => step.run !== undefined && runsTheGate(step.run, gateScripts))
        .map((step) => ({
          file,
          step: step.name ?? step.run ?? '',
          mode: modeInScope(workflow, job, step),
        }))
    )
  );
}

/**
 * Whether a step running under `named` has a shipping bundle to check. A step
 * naming nothing runs under the default mode, which is a mode like any other; a
 * value naming no mode at all is refused rather than resolved, because the gate
 * would fail on it rather than skip.
 */
function shipsBundles(named: string | undefined): boolean {
  if (named === undefined) return shipsBundlesIn(envModeOrDefault({}));
  const mode = ENV_MODES.find((candidate) => candidate === named);
  return mode !== undefined && shipsBundlesIn(mode);
}

/** The steps that would run the gate under a mode it verifies nothing in. */
function stepsWithoutShippingMode(files: readonly WorkflowFile[]): string[] {
  return gateSteps(files)
    .filter(({ mode }) => !shipsBundles(mode))
    .map(({ file, step }) => `${file}: ${step}`);
}

/** The same files with every mode declaration removed, at every scope. */
function withoutModeDeclarations(files: readonly WorkflowFile[]): WorkflowFile[] {
  const stripped = (scope: Record<string, unknown> | undefined): Record<string, unknown> =>
    Object.fromEntries(Object.entries(scope ?? {}).filter(([key]) => key !== ENV_MODE_VARIABLE));
  return files.map(({ file, workflow }) => ({
    file,
    workflow: {
      env: stripped(workflow.env),
      jobs: Object.fromEntries(
        Object.entries(workflow.jobs ?? {}).map(([name, job]) => [
          name,
          {
            ...job,
            env: stripped(job.env),
            steps: (job.steps ?? []).map((step) => ({ ...step, env: stripped(step.env) })),
          },
        ])
      ),
    },
  }));
}

/**
 * The steps that run the gate today. The walk derives the set; this floor is
 * what fails instead when a discovery bug narrows it to nothing, which would
 * satisfy every assertion below over an empty set.
 */
const KNOWN_GATE_STEPS: readonly string[] = [
  'ci.yml: Verify web bundle',
  'ci.yml: Verify mobile OTA bundles',
  'build-android.yml: Verify web bundle',
  'build-ios.yml: Verify web bundle',
];

const FILES = workflowFiles();

describe('the bundle gate in the workflows', () => {
  it('derives the root scripts that reach its shipping-mode checks', () => {
    const derived = shippingGateScripts();
    expect(derived).toContain('verify:bundle');
    expect(derived).not.toContain('verify:bundle:update');
  });

  it('finds every step that runs it', () => {
    expect(gateSteps(FILES).map(({ file, step }) => `${file}: ${step}`)).toEqual(
      expect.arrayContaining([...KNOWN_GATE_STEPS])
    );
  });

  it('runs every one of them under a mode that has a shipping bundle to read', () => {
    expect(stepsWithoutShippingMode(FILES)).toEqual([]);
  });

  // Without this the assertion above is satisfied by a predicate that answers
  // yes to everything, and the property would read as pinned while nothing held
  // it. The subject is the real files with their mode declarations removed, so
  // what it proves is that this walk reaches those declarations.
  it('refuses the same steps once nothing names the mode', () => {
    expect(stepsWithoutShippingMode(withoutModeDeclarations(FILES))).toEqual(
      expect.arrayContaining([...KNOWN_GATE_STEPS])
    );
  });
});
