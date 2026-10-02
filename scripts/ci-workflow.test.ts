/**
 * Structural assertions over the continuous-integration workflow.
 *
 * Two properties live in the YAML and nowhere else, so they are pinned here
 * rather than left to review: which repository a job is allowed to run in, and
 * which trust phase may reach a credential. Both survive a rewrite only if a
 * test reads the file the way GitHub does.
 *
 * This file is the one triggered workflow the guarded-workflow table cannot
 * carry — its jobs are gated per job, some of them inheriting the guard through
 * `needs` rather than writing it — so the repository question is asked here, of
 * this file alone, and of every other triggered file over there.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, stringify } from 'yaml';
import { describe, expect, it } from 'vitest';

import { loadManifest } from '@hushbox/ops/generate-labels';
import {
  Destination,
  MOBILE_PLATFORMS,
  Mode,
  getDestinations,
  isSecret,
  resolveRaw,
} from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import { CLAIM_FLAG } from './release/compute-next-version.js';
import { SHIPPED_OUTPUT } from './release/deploy-shipped.js';
import { readRepositories } from './configure-git-clone.js';
import { deploySecretKeys, escrowEnvironments, workflowSections } from './generate-env.js';
import { SURFACES } from './lib/deployed-surfaces.js';
import { ENV_MODE_VARIABLE } from './lib/stack/stack-mode.js';
import { composeProjectName } from './lib/cli/worktree.js';
import { emulatorContainerName } from './lib/mobile/emulator-container.js';
import { CMDLINE_TOOLS_BUILD, MAESTRO_VERSION } from './lib/mobile/pinned-archives.js';
import { BASE_VARIABLE, HEAD_VARIABLE } from './verify-commit-dates.js';
import { BORROWED_JOBS } from './lib/publication/borrowed-jobs.js';
import { APP_ID_VARIABLE, PRIVATE_KEY_VARIABLE } from './lib/publication/sync-bot-credential.js';
import {
  PUBLIC_REPOSITORY_VARIABLE,
  STAGING_REPOSITORY_VARIABLE,
  conjuncts,
  repositoryTerm,
  triggerEvents,
  variableExpression as variablesReference,
} from './lib/publication/guarded-workflows.js';

import type { VariableConfig } from '@hushbox/shared';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WORKFLOWS = path.join(REPO_ROOT, '.github', 'workflows');

const PUBLIC_VARIABLE = variablesReference(PUBLIC_REPOSITORY_VARIABLE);
const STAGING_VARIABLE = variablesReference(STAGING_REPOSITORY_VARIABLE);
const FORK_PHASE = "github.event_name == 'pull_request'";
const TRUSTED_PHASE = "github.event_name != 'pull_request'";
const CASSETTE_SECRET = 'CASSETTE_R2_';
const CASSETTE_ENTRY = 'scripts/cassette-store.ts';
const EMULATOR_DUMP_STEP = 'Dump emulator logs';
const MOBILE_BUILD_STEP = 'Build mobile OTA bundles (parallel)';
const MOBILE_VERIFY_STEP = 'Verify mobile OTA bundles';
const MOBILE_UPLOAD_STEP = 'Upload mobile build artifacts';
const VERSION_SUCCEEDED = "needs.version.result == 'success'";
/** The condition term that runs a job only where the named need succeeded. */
const succeeded = (need: string): string => `needs.${need}.result == 'success'`;
/**
 * The one status function a borrowable check or a publishing job carries: it
 * runs the job past a skipped or failed need, and never past a cancelled run.
 */
const RUNS_PAST_SKIPS = '!cancelled()';
/** The event a human starts by hand, which deploys without the borrowable checks. */
const DISPATCH = 'workflow_dispatch';
/** The push to the public repository's `main`, the one run that can borrow staging's proof. */
const DEPLOYING_PUSH = [
  "github.event_name == 'push'",
  "github.ref == 'refs/heads/main'",
  repositoryTerm(PUBLIC_REPOSITORY_VARIABLE),
];
/** The events that deploy: a push to the public repository's `main`, or a dispatch on it. */
const DEPLOYING_EVENT = [
  "github.ref == 'refs/heads/main'",
  repositoryTerm(PUBLIC_REPOSITORY_VARIABLE),
  `(github.event_name == 'push' || github.event_name == '${DISPATCH}')`,
];
/** Every other event, as the negation of {@link DEPLOYING_EVENT}. */
const OFF_THE_DEPLOYING_EVENT = `!(${DEPLOYING_EVENT.join(' && ')})`;
/** The clause that keeps a borrowable check out of a dispatched run. */
const NOT_DISPATCHED = `github.event_name != '${DISPATCH}'`;
/** What the version script writes, and what both version jobs output. */
const VERSION_OUTPUTS = ['version', 'version_name', 'version_code', 'claimed'];
const NAME_FILTER = /--filter "name=([^"]+)"/;
/** The command that writes the production environment file, in one spelling. */
const PRODUCTION_GENERATION = `generate:env --mode=${Mode.Production}`;

/**
 * A reference to the `secrets` context, in the spellings GitHub accepts for one:
 * the dotted property, the index form, and the context handed on as a value. A
 * reference is an expression and the context is readable nowhere else, so the
 * surrounding `${{ }}` is what separates one from prose — a step named "Scan for
 * secrets" names no credential at any punctuation. The interior stops short of
 * the closing `}}` so the delimiters bound the match, and the lookbehind keeps
 * the context itself apart from anything ending in the word, such as the output
 * of a step with `scan-secrets` for an id. See the SPELLINGS statement.
 */
const CREDENTIAL_REFERENCE = /\$\{\{(?:[^}]|\}(?!\}))*?(?<![\w.-])secrets\b/;

interface WorkflowStep {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly 'working-directory'?: string;
  readonly env?: Record<string, unknown>;
  readonly with?: Record<string, unknown>;
}

/** A grant per scope, or a shorthand (`read-all`, `write-all`) granting that level on every scope. */
type Permissions = Record<string, string> | string;

interface WorkflowJob {
  readonly if?: string;
  readonly 'runs-on'?: string;
  /** Present where a job replaces the workflow-level grant with its own. */
  readonly permissions?: Permissions;
  readonly concurrency?: unknown;
  readonly outputs?: Record<string, string>;
  readonly needs?: string | string[];
  readonly steps?: WorkflowStep[];
  readonly env?: Record<string, unknown>;
  /** Present instead of `steps` on a reusable-workflow call. */
  readonly uses?: string;
  /** The inputs a reusable-workflow call passes. */
  readonly with?: Record<string, unknown>;
  readonly secrets?: unknown;
  /** The job's own container: a `credentials` block and an `env` block. */
  readonly container?: unknown;
  /** Service containers, each with the same two credential-accepting keys. */
  readonly services?: unknown;
}

interface Workflow {
  readonly on?: unknown;
  readonly env?: Record<string, unknown>;
  readonly permissions?: Permissions;
  readonly concurrency?: { readonly group?: string; readonly 'cancel-in-progress'?: boolean };
  readonly jobs: Record<string, WorkflowJob>;
}

function load(file: string): Workflow {
  return parse(readFileSync(path.join(WORKFLOWS, file), 'utf8')) as Workflow;
}

const ci = load('ci.yml');

const EVENT_EQUALS = /^github\.event_name == '([a-z_]+)'$/;

/**
 * A reusable-workflow call this reader can follow, which is one naming a file in
 * this directory. The other form — `owner/repo/.github/workflows/x.yml@ref` —
 * names a file no checkout here holds, so it is refused rather than resolved.
 */
const CALLED_WORKFLOW = /^\.\/\.github\/workflows\/([^/]+\.ya?ml)$/;

/**
 * The events one conjunct pins the run to: a single equality, or a
 * parenthesised disjunction made of nothing else. Undefined where the conjunct
 * pins no event set.
 */
function pinnedEvents(clause: string): string[] | undefined {
  const group = /^\((.*)\)$/.exec(clause)?.[1] ?? clause;
  const events = group.split('||').map((term) => EVENT_EQUALS.exec(term.trim())?.[1]);
  return events.every((event): event is string => event !== undefined) ? events : undefined;
}

/**
 * Whether one conjunct keeps an event out: the inequality naming it, or a pin
 * to a set of other events.
 */
function keepsEventOut(clause: string, event: string): boolean {
  if (clause === `github.event_name != '${event}'`) return true;
  return pinnedEvents(clause)?.includes(event) === false;
}

/** Whether a guard keeps a fork's `pull_request` run out. */
const excludesForks = (guard: string | undefined): boolean =>
  guard !== undefined && conjuncts(guard).some((clause) => keepsEventOut(clause, 'pull_request'));

/**
 * A job's steps, refusing a job this reader cannot walk.
 *
 * The enumeration's KINDS, not only its scope — and its kinds run in two
 * dimensions, because a kind set is the shape of the search as much as a list
 * of what was searched. A taxonomy of PLACES misses a place nobody listed; a
 * taxonomy of SPELLINGS misses a value written another way. Both absences look
 * identical in a clean result, so only this statement separates them.
 *
 * PLACES. What this walks is the `steps` list of every job in the file, and —
 * for a job written as a reusable-workflow call — the steps of the workflow it
 * calls; the credential-accepting keys that are not steps — a workflow's and a
 * job's `env`, and `container` and `services` — are read by
 * {@link ambientScopesOfJob} instead, which crosses the same call edge, so a
 * called workflow's own three are read as the caller job's. What was never a
 * candidate, and why each is or is not a hole —
 *
 *   - the steps inside a composite action a step `uses:` are not walked. Not a
 *     hole: action metadata has no `secrets` context at all, so a secret
 *     reference cannot be written there;
 *   - a matrix job's steps are judged once rather than per matrix cell. Not a
 *     hole: every cell runs the same step text;
 *   - workflows other than `ci.yml` are outside the boundary assertions
 *     entirely, because `ci.yml` is the only file carrying a `pull_request`
 *     trigger — `guarded-workflows.test.ts` pins that for every carried
 *     workflow, and no other file declares one.
 *
 * SPELLINGS. The shape of the search, which bounds it further than its reach
 * does. Two of this file's assertions — the step one and the ambient-scope one —
 * match the `secrets` context through {@link CREDENTIAL_REFERENCE}, inside the
 * `${{ }}` an expression is written in, in each spelling that expression accepts:
 * the dotted property, the index form `secrets['NAME']` that a matrix-driven
 * selection is normally written in, and the context handed on whole to a
 * function. Requiring the delimiters states what a reference looks like rather
 * than narrowing what counts as one — the context is readable nowhere else — so
 * prose naming the word satisfies none of it at any punctuation. The three
 * cassette-store assertions match none of those either: they search that store's
 * own credential prefix and its entry path instead, so they see one store and are
 * blind to every other credential by construction.
 *
 * Bounding the match to an expression closes prose, not the class. A credential
 * that reaches a step without naming the `secrets` context is not merely absent
 * from the result — it is unrepresentable in it, and two shapes are known to be
 * that way —
 *
 * - the ambient token under its other name, `github.token`, which is the same
 *   value `secrets.GITHUB_TOKEN` reaches. Not a hole: the token a fork's
 *   `pull_request` run receives is read-only by design;
 * - a job granting `permissions: id-token: write`, which mints a cloud identity
 *   credential inside the job with no reference of any shape at all. Not a hole:
 *   no workflow in this directory grants it.
 *
 * Neither that list nor the PLACES one is closed, and neither is
 * offered as one — an enumeration cannot enumerate what it did not think of, and
 * that is the whole reason both are written down. What is claimed is only the
 * shape: this finds one context, spelled inside an expression. The next class to
 * escape it will be the next way to hold a credential without spelling that
 * context, and it will read exactly like a clean result until someone names it
 * here.
 */
function stepsOfJob(name: string, job: WorkflowJob): WorkflowStep[] {
  if (job.steps !== undefined) return job.steps;
  if (job.uses !== undefined) {
    const called = CALLED_WORKFLOW.exec(job.uses)?.[1];
    if (called === undefined) {
      throw new Error(`job '${name}' calls '${job.uses}', which this reader cannot read`);
    }
    return stepsOf(load(called));
  }
  throw new Error(`job '${name}' declares no steps, so this reader cannot judge what it reaches`);
}

function stepsOf(workflow: Workflow): WorkflowStep[] {
  return Object.entries(workflow.jobs).flatMap(([name, job]) => stepsOfJob(name, job));
}

/**
 * A job's dependencies, in the one shape a reader can walk: GitHub accepts
 * `needs` as a bare string or a sequence, and every reader below must agree on
 * which it got.
 */
const dependenciesOf = (workflow: Workflow, name: string): readonly string[] => {
  const needs = workflow.jobs[name]?.needs;
  return typeof needs === 'string' ? [needs] : (needs ?? []);
};

/**
 * A status-check function in a job's condition. Any of them replaces the
 * implicit `success()` that skips a job whose need was skipped, so a job
 * carrying one is judged on its own guard alone rather than on its needs'.
 * Read as re-admitting even where GitHub's own reading of `success()` is
 * stricter, which only ever makes a job look more reachable than it is.
 */
const STATUS_FUNCTION = /(?:^|[^\w.])(?:always|cancelled|success|failure)\(\)/;

const readmitsSkippedNeeds = (guard: string | undefined): boolean =>
  STATUS_FUNCTION.test(guard ?? '');

/**
 * The needs a job's condition runs it only past the success of. A status
 * function frees a job from its needs' skips, but a success term binds it to
 * that need again: the job starts only where the need ran.
 */
const needsRequiredToSucceed = (workflow: Workflow, name: string): string[] => {
  const clauses = conjuncts(workflow.jobs[name]?.if ?? '');
  return dependenciesOf(workflow, name).filter((need) => clauses.includes(succeeded(need)));
};

/**
 * Whether a fork's `pull_request` run can start this job. A skipped dependency
 * skips its dependents, so a guard one job up is as binding as a guard here —
 * which is how a job that carries no event guard of its own still gets
 * phase-gated. A job carrying a status function answers to its own guard and
 * to the needs it requires to succeed.
 */
function startsOnFork(workflow: Workflow, name: string): boolean {
  const job = workflow.jobs[name];
  if (job === undefined || excludesForks(job.if)) return false;
  const needs = readmitsSkippedNeeds(job.if)
    ? needsRequiredToSucceed(workflow, name)
    : dependenciesOf(workflow, name);
  return needs.every((dependency) => startsOnFork(workflow, dependency));
}

/**
 * Whether a job can only ever start in a repository a variable names. Inherited
 * through `needs` for the same reason the phase guard is: the `e2e` job carries
 * no repository guard of its own, because one there would drop
 * registry-declared browser projects while the matrix still named them. A job
 * carrying a status function inherits only through the needs it requires to
 * succeed.
 */
function repositoryGated(workflow: Workflow, name: string): boolean {
  const job = workflow.jobs[name];
  if (job === undefined) return false;
  if ((job.if ?? '').includes('github.repository')) return true;
  const needs = readmitsSkippedNeeds(job.if)
    ? needsRequiredToSucceed(workflow, name)
    : dependenciesOf(workflow, name);
  return needs.length > 0 && needs.every((dependency) => repositoryGated(workflow, dependency));
}

/** Every job a fork's `pull_request` run can start, with its name. */
const forkReachableJobEntries = (workflow: Workflow): [string, WorkflowJob][] =>
  Object.entries(workflow.jobs).filter(([name]) => startsOnFork(workflow, name));

/**
 * Every place one job holds a credential that no step guard can cover: its own
 * `env`, plus the two container keys — `container` and `services` — which take
 * a `credentials` block and an `env` block apiece, and — for a job written as a
 * reusable-workflow call — the same three keys on every job of the workflow it
 * calls, under that workflow's own `env`. Those keys are neither a step nor the
 * job's own environment, so the step walk is structurally blind to them and
 * reads a job built entirely out of them as contributing nothing at all.
 *
 * The call is followed for the reason {@link stepsOfJob} follows it, and the
 * unreadable call is refused for the same reason too: a caller job read as
 * holding nothing passes every boundary assertion below while being the job
 * shape they most need to judge.
 */
function ambientScopesOfJob(name: string, job: WorkflowJob): unknown[] {
  const own = [job.env, job.container, job.services];
  if (job.uses === undefined) return own;
  const called = CALLED_WORKFLOW.exec(job.uses)?.[1];
  if (called === undefined) {
    throw new Error(`job '${name}' calls '${job.uses}', which this reader cannot read`);
  }
  return [...own, ...ambientScopesOf(load(called))];
}

function ambientScopesOf(workflow: Workflow): unknown[] {
  return [
    workflow.env,
    ...Object.entries(workflow.jobs).flatMap(([name, job]) => ambientScopesOfJob(name, job)),
  ];
}

/** Every such place a fork's `pull_request` run can reach. */
const untrustedAmbientScopes = (workflow: Workflow): unknown[] => [
  workflow.env,
  ...forkReachableJobEntries(workflow).flatMap(([name, job]) => ambientScopesOfJob(name, job)),
];

/**
 * Every step a fork's `pull_request` run can actually reach. Refuses any
 * reachable job it cannot walk — see {@link stepsOfJob} for which shapes those
 * are and why an empty list would be the wrong answer.
 */
const forkReachableSteps = (workflow: Workflow): WorkflowStep[] =>
  forkReachableJobEntries(workflow).flatMap(([name, job]) =>
    stepsOfJob(name, job).filter((step) => !excludesForks(step.if))
  );

/**
 * A job whose steps live in another file, and the two shapes that leave the
 * reader with nothing to walk.
 *
 * Following the call is what keeps the answer true: a caller job read as
 * contributing nothing passes every boundary assertion below while being the
 * job shape they most need to judge, and a reachability analysis that returns
 * the reassuring answer because it could not parse a shape is worse than one
 * that stops.
 */
describe('the step reader on a job whose steps live in another file', () => {
  const callJob: Workflow = {
    jobs: {
      publish: { uses: './.github/workflows/build-android.yml', secrets: 'inherit' },
    },
  };

  it('reads the called workflow as the steps the caller contributes', () => {
    const called = stepsOf(load('build-android.yml'));

    expect(called.length).toBeGreaterThan(0);
    expect(stepsOf(callJob)).toEqual(called);
  });

  it('reaches the called workflow through the fork-reachable reading too', () => {
    expect(forkReachableSteps(callJob)).toEqual(stepsOf(load('build-android.yml')));
  });

  it('reads the escrow caller job as the escrow workflow it calls', () => {
    const reached = stepsOfJob('escrow', ci.jobs['escrow'] ?? {}).filter((step) =>
      (step.run ?? '').includes('scripts/escrow-secrets.ts')
    );

    // The reader flattens every job of the called file, and that file carries
    // one escrow job per environment, so what the caller contributes is the
    // whole set rather than the single job this call selects at run time.
    expect(reached).toHaveLength(escrowEnvironments().length);
  });

  it('refuses a call to a workflow outside this directory rather than reading it as reaching nothing', () => {
    const remote: Workflow = {
      jobs: { publish: { uses: 'owner/other/.github/workflows/build.yml@v1' } },
    };

    expect(() => stepsOf(remote)).toThrow('cannot read');
  });

  it('refuses a job declaring neither steps nor a call', () => {
    const orphan: Workflow = { jobs: { publish: {} } };

    expect(() => stepsOf(orphan)).toThrow('declares no steps');
  });

  it('still walks a job that carries steps, so the reading is not always indirect', () => {
    const stepped: Workflow = { jobs: { lint: { steps: [{ run: 'pnpm lint' }] } } };

    expect(forkReachableSteps(stepped)).toHaveLength(1);
  });
});

/**
 * The two container keys are neither a step nor the job's own `env`, so a
 * credential written into one reaches a fork run while every step assertion
 * reads clean. The `CONTAINERISED` job is the shape a lens built to demonstrate that:
 * four credential references across both keys beside one harmless step.
 */
describe('the boundary reading of a job that holds credentials outside its steps', () => {
  const CONTAINERISED: Workflow = {
    jobs: {
      integration: {
        container: {
          image: 'ghcr.io/example/runner:1',
          credentials: { username: 'ci', password: '${{ secrets.REGISTRY_PASSWORD }}' },
          env: { TOKEN: '${{ secrets.CONTAINER_TOKEN }}' },
        },
        services: {
          db: {
            image: 'ghcr.io/example/postgres:18',
            credentials: { username: 'ci', password: '${{ secrets.SERVICE_REGISTRY_PASSWORD }}' },
            env: { POSTGRES_PASSWORD: '${{ secrets.SERVICE_PASSWORD }}' },
          },
        },
        steps: [{ run: 'pnpm test' }],
      },
    },
  };

  const secretsNamedIn = (scopes: unknown[]): string[] => {
    const named = [...JSON.stringify(scopes).matchAll(/secrets\.[A-Z_]+/g)].map(([match]) => match);

    return [...new Set(named)].toSorted((left, right) => left.localeCompare(right));
  };

  it('names every credential both container keys carry', () => {
    expect(secretsNamedIn(untrustedAmbientScopes(CONTAINERISED))).toEqual([
      'secrets.CONTAINER_TOKEN',
      'secrets.REGISTRY_PASSWORD',
      'secrets.SERVICE_PASSWORD',
      'secrets.SERVICE_REGISTRY_PASSWORD',
    ]);
  });

  it('reads the same job without those keys as clean, so the container-key reading is not vacuous', () => {
    const plain: Workflow = { jobs: { integration: { steps: [{ run: 'pnpm test' }] } } };

    expect(secretsNamedIn(untrustedAmbientScopes(plain))).toEqual([]);
  });

  it('leaves the step walk reading clean, which is why the step assertions cannot cover this', () => {
    expect(secretsNamedIn(forkReachableSteps(CONTAINERISED))).toEqual([]);
  });
});

/**
 * The ambient reading crosses the call edge the step reading crosses, for the
 * reason that one does: a credential written into a called workflow's own `env`,
 * `container` or `services` is in scope for the caller job, and a reader that
 * stops at the caller file answers that it is not. `backup.yml` stands in for
 * the shape because its single job binds credentials in its job `env` and in no
 * step — the exact class the step walk is structurally blind to.
 */
describe('the ambient reading of a job whose steps live in another file', () => {
  const AMBIENT_CALL = './.github/workflows/backup.yml';

  const holdsACredential = (workflow: Workflow): boolean =>
    CREDENTIAL_REFERENCE.test(JSON.stringify(untrustedAmbientScopes(workflow)));

  it('reads the scopes of the workflow a fork-reachable job calls', () => {
    const caller: Workflow = { jobs: { dispatch: { uses: AMBIENT_CALL } } };

    expect(holdsACredential(caller)).toBe(true);
  });

  it('leaves a call no fork can start out of the untrusted reading', () => {
    const guarded: Workflow = { jobs: { dispatch: { if: TRUSTED_PHASE, uses: AMBIENT_CALL } } };

    expect(holdsACredential(guarded)).toBe(false);
  });

  it('refuses a call to a workflow outside this directory rather than reading it as holding nothing', () => {
    const remote: Workflow = {
      jobs: { dispatch: { uses: 'owner/other/.github/workflows/build.yml@v1' } },
    };

    expect(() => untrustedAmbientScopes(remote)).toThrow('cannot read');
  });
});

/**
 * The spellings the credential match can and cannot see, pinned so the SPELLINGS
 * statement is measured rather than asserted. Each case is one fork-reachable
 * step holding one value; the dotted case is the control, and the index and
 * whole-context spellings are the ones a match on the dotted property alone
 * reads as clean.
 */
describe('the spellings the credential match reaches', () => {
  const holding = (value: string): Workflow => ({
    jobs: { gate: { steps: [{ name: 'Run the gate', env: { TOKEN: value } }] } },
  });

  const readsAsCredential = (workflow: Workflow): boolean =>
    forkReachableSteps(workflow).some((step) => CREDENTIAL_REFERENCE.test(JSON.stringify(step)));

  const namesACredential = (value: string): boolean => readsAsCredential(holding(value));

  const stepNamed = (name: string): Workflow => ({ jobs: { gitleaks: { steps: [{ name }] } } });

  it('reads the dotted property, which is the control for the other spellings', () => {
    expect(namesACredential(`\${{ secrets.${CASSETTE_SECRET}KEY }}`)).toBe(true);
  });

  it('reads the index form a matrix-driven selection is written in', () => {
    expect(namesACredential(`\${{ secrets['${CASSETTE_SECRET}KEY'] }}`)).toBe(true);
  });

  it('reads the whole context handed to a function', () => {
    expect(namesACredential('${{ toJSON(secrets) }}')).toBe(true);
  });

  it('reads the whole context passed on its own', () => {
    expect(namesACredential('${{ secrets }}')).toBe(true);
  });

  it('reads the bare word in prose as prose, so the widening admits no step', () => {
    const scanning: Workflow = {
      jobs: { gitleaks: { steps: [{ name: 'Scan the checked-out tree for secrets' }] } },
    };

    expect(
      forkReachableSteps(scanning).filter((step) => CREDENTIAL_REFERENCE.test(JSON.stringify(step)))
    ).toEqual([]);
  });

  it('reads the word followed by a comma as prose', () => {
    expect(readsAsCredential(stepNamed('Scan for secrets, then report what it found'))).toBe(false);
  });

  it('reads the word inside parentheses as prose', () => {
    expect(readsAsCredential(stepNamed('Scan the tree (secrets) before the build'))).toBe(false);
  });

  it('reads the word ending a sentence as prose', () => {
    expect(readsAsCredential(stepNamed('Scan the checked-out tree for secrets.'))).toBe(false);
  });

  it('reads a step output whose id carries the word as an output, not a credential', () => {
    const reporting: Workflow = {
      jobs: { gitleaks: { steps: [{ run: 'echo ${{ steps.scan-secrets.outputs.count }}' }] } },
    };

    expect(readsAsCredential(reporting)).toBe(false);
  });
});

describe('excludesForks', () => {
  it('reads the explicit exclusion', () => {
    expect(excludesForks(TRUSTED_PHASE)).toBe(true);
  });

  it('reads an event pinned to something else', () => {
    expect(excludesForks("github.event_name == 'push' && a == 'b'")).toBe(true);
  });

  it('does not read a repository guard as a phase guard', () => {
    expect(excludesForks(repositoryTerm(PUBLIC_REPOSITORY_VARIABLE))).toBe(false);
  });

  it('does not read the fork phase itself as excluding forks', () => {
    expect(excludesForks(FORK_PHASE)).toBe(false);
  });

  it('reads a parenthesised set of other events as excluding forks', () => {
    expect(excludesForks(DEPLOYING_EVENT.join(' && '))).toBe(true);
  });

  it('does not read a parenthesised set naming the fork phase as excluding forks', () => {
    expect(excludesForks(`(${FORK_PHASE} || github.event_name == '${DISPATCH}')`)).toBe(false);
  });

  it('does not read a parenthesised group holding anything but event pins as a set of events', () => {
    expect(excludesForks(`(github.event_name == 'push' || ${STAGING_VARIABLE} == 'x')`)).toBe(
      false
    );
  });
});

/**
 * The inherited readings of a job's phase and repository stop at a status
 * function, because a job carrying one starts past a skipped need. Each shape
 * is read on a synthetic two-job workflow whose follower carries only that
 * function, beside the same follower without it as the control.
 */
describe('the status functions a job condition can carry', () => {
  const STATUS_FUNCTIONS = ['always()', '!cancelled()', 'success()', 'failure()'];

  const following = (leader: WorkflowJob, condition?: string): Workflow => ({
    jobs: {
      leader,
      follower: { needs: ['leader'], ...(condition === undefined ? {} : { if: condition }) },
    },
  });

  it.each(STATUS_FUNCTIONS)(
    'reads a job carrying %s as reachable past a leader no fork starts',
    (condition) => {
      expect(startsOnFork(following({ if: TRUSTED_PHASE }, condition), 'follower')).toBe(true);
    }
  );

  it('reads a job carrying none as inheriting its leader\u2019s phase', () => {
    expect(startsOnFork(following({ if: TRUSTED_PHASE }), 'follower')).toBe(false);
  });

  it.each(STATUS_FUNCTIONS)(
    'reads a job carrying %s as ungated when only its leader names a repository',
    (condition) => {
      const leader: WorkflowJob = { if: repositoryTerm(PUBLIC_REPOSITORY_VARIABLE) };

      expect(repositoryGated(following(leader, condition), 'follower')).toBe(false);
    }
  );

  it('reads a job carrying none as inheriting its leader\u2019s repository', () => {
    const leader: WorkflowJob = { if: repositoryTerm(PUBLIC_REPOSITORY_VARIABLE) };

    expect(repositoryGated(following(leader), 'follower')).toBe(true);
  });

  it('reads a function-shaped word inside a longer name as no status function', () => {
    const leader: WorkflowJob = { if: TRUSTED_PHASE };

    expect(startsOnFork(following(leader, 'steps.x.always()'), 'follower')).toBe(false);
  });

  it('reads a job run past skips only on its leader’s success as inheriting its leader’s phase', () => {
    const condition = `${RUNS_PAST_SKIPS} && ${succeeded('leader')}`;

    expect(startsOnFork(following({ if: TRUSTED_PHASE }, condition), 'follower')).toBe(false);
  });

  it('reads a job run past skips only on its leader’s success as inheriting its leader’s repository', () => {
    const leader: WorkflowJob = { if: repositoryTerm(PUBLIC_REPOSITORY_VARIABLE) };
    const condition = `${RUNS_PAST_SKIPS} && ${succeeded('leader')}`;

    expect(repositoryGated(following(leader, condition), 'follower')).toBe(true);
  });

  it('reads a job run past skips on its leader’s success as starting where its leader starts', () => {
    const condition = `${RUNS_PAST_SKIPS} && ${succeeded('leader')}`;

    expect(startsOnFork(following({ if: FORK_PHASE }, condition), 'follower')).toBe(true);
  });
});

describe('the CI workflow', () => {
  it('runs in both trust phases and on the branch pushes that follow them', () => {
    expect(Object.keys(ci.on as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['pull_request', 'merge_group', 'push'])
    );
  });

  it('starts by hand too, taking no input, which is the run that deploys without the borrowable checks', () => {
    expect(ci.on).toHaveProperty(DISPATCH, null);
  });

  it('gates every job on the repository it is allowed to run in', () => {
    const ungated = Object.keys(ci.jobs).filter((name) => !repositoryGated(ci, name));

    expect(ungated).toEqual([]);
  });

  it('reads a job with no gate anywhere above it as ungated', () => {
    const ungated: Workflow = { jobs: { alone: {} } };

    expect(repositoryGated(ungated, 'alone')).toBe(false);
  });

  it('names the repositories through variables, never through a literal slug', async () => {
    const { publicRepo, stagingRepo } = await readRepositories();

    for (const [name, job] of Object.entries(ci.jobs)) {
      if (job.if?.includes('github.repository') === true) {
        expect({ job: name, variable: job.if.includes('vars.HB_') }).toEqual({
          job: name,
          variable: true,
        });
      }
      expect(job.if ?? '').not.toContain(publicRepo);
      expect(job.if ?? '').not.toContain(stagingRepo);
    }
  });

  it('confines the deploy to the public repository', () => {
    expect(conjuncts(ci.jobs['deploy']?.if ?? '')).toContain(
      repositoryTerm(PUBLIC_REPOSITORY_VARIABLE)
    );
  });

  it('confines the mobile emulator image push to the public repository', () => {
    expect(conjuncts(ci.jobs['push-mobile-emulator-image']?.if ?? '')).toContain(
      repositoryTerm(PUBLIC_REPOSITORY_VARIABLE)
    );
  });

  it('lets the gate jobs run in both repositories', () => {
    for (const name of ['lint', 'typecheck', 'duplication', 'unused', 'test', 'privacy-sweep']) {
      expect(ci.jobs[name]?.if).toContain(STAGING_VARIABLE);
      expect(ci.jobs[name]?.if).toContain(PUBLIC_VARIABLE);
    }
  });

  it('runs the untrusted phase on GitHub-hosted runners', () => {
    for (const name of ['lint', 'typecheck', 'duplication', 'unused', 'gitleaks', 'test']) {
      expect(ci.jobs[name]?.['runs-on']).toContain(`${FORK_PHASE} && 'ubuntu-latest'`);
    }
  });

  it('keeps the paid-runner suites out of the untrusted phase entirely', () => {
    for (const name of ['build', 'e2e-build', 'e2e', 'mobile-test']) {
      expect({ job: name, trusted: !startsOnFork(ci, name) }).toEqual({ job: name, trusted: true });
    }
  });

  it('starts the gate jobs on a fork pull request, so the paid-runner exclusion is not vacuous', () => {
    for (const name of ['lint', 'typecheck', 'gitleaks', 'test', 'privacy-sweep']) {
      expect({ job: name, runs: startsOnFork(ci, name) }).toEqual({ job: name, runs: true });
    }
  });

  it('names no secret on any step a fork pull request can reach', () => {
    const leaking = forkReachableSteps(ci)
      .filter((step) => CREDENTIAL_REFERENCE.test(JSON.stringify(step)))
      .map((step) => step.name ?? step.uses ?? '(unnamed)');

    expect(leaking).toEqual([]);
  });

  it('never puts a secret in scope no step guard reaches on the untrusted path', () => {
    expect(JSON.stringify(untrustedAmbientScopes(ci))).not.toMatch(CREDENTIAL_REFERENCE);
  });
});

const JOB_RESULT = /^needs\.[\w-]+\.result == /;
const JOB_OUTPUT = /^needs\.([\w-]+)\.outputs\./;

/**
 * Whether a step of the build job can carry one of the deploy's conjuncts: not
 * the status function or a need's result, which judge the deploy's own needs,
 * and not an output of a job that waits on the build, which has not run while
 * the build does.
 */
function readableByTheBuild(workflow: Workflow, clause: string): boolean {
  if (clause === RUNS_PAST_SKIPS || JOB_RESULT.test(clause)) return false;
  const job = JOB_OUTPUT.exec(clause)?.[1];
  return job === undefined || !transitiveNeeds(workflow, job).includes('build');
}

/**
 * The three mobile steps of the build job, which carry two different guards on
 * purpose.
 *
 * The upload produces an artifact whose only consumer is the deploy job, so it
 * is guarded by the clauses that job applies to itself, less those the build
 * cannot read, rather than by the version job's result: anywhere the deploy
 * job does not run, the artifact has
 * no reader and is retained for nothing. The build and verify steps are cheap
 * and stay keyed to the version job, so they run wherever a version is
 * computed. The relation between the two guards is stated in prose above the
 * upload step and enforced only by the assertions below, and levelling them
 * costs one side or the other: the retention on the upload, or the early
 * detection on the two cheap steps.
 */
describe('the mobile bundle steps of the build job', () => {
  const mobileStep = (name: string): WorkflowStep => {
    const build = ci.jobs['build'];
    if (build === undefined) throw new Error('the workflow declares no build job');
    const step = stepsOfJob('build', build).find((candidate) => candidate.name === name);
    if (step === undefined) throw new Error(`the build job has no step named '${name}'`);
    return step;
  };

  it('guards the artifact upload with the clauses its only consumer applies to itself', () => {
    expect(conjuncts(mobileStep(MOBILE_UPLOAD_STEP).if ?? '')).toEqual(
      conjuncts(ci.jobs['deploy']?.if ?? '').filter((clause) => readableByTheBuild(ci, clause))
    );
  });

  it('reads an output of a job downstream of the build as a clause the build cannot carry', () => {
    const planted: Workflow = {
      jobs: { ...ci.jobs, downstream: { needs: ['build'], steps: [] } },
    };

    expect(readableByTheBuild(planted, "needs.downstream.outputs.done != 'true'")).toBe(false);
  });

  it('reads an output of a job upstream of the build as a clause the build can carry', () => {
    expect(readableByTheBuild(ci, CLAIMED)).toBe(true);
  });

  it('keys the cheap build and verify steps to the version job', () => {
    expect([mobileStep(MOBILE_BUILD_STEP).if, mobileStep(MOBILE_VERIFY_STEP).if]).toEqual([
      VERSION_SUCCEEDED,
      VERSION_SUCCEEDED,
    ]);
  });
});

/**
 * Every platform list a `for platform in …` loop walks, in the order its script
 * writes them.
 */
function loopedPlatformSets(text: string): string[][] {
  return [...text.matchAll(/for platform in ([^;]+); do/g)].map((loop) =>
    (loop[1] ?? '').trim().split(/\s+/)
  );
}

/**
 * Every platform list spelled as literal `dist-<platform>` build outputs,
 * whether a command takes them as arguments or a step lists them as paths. A
 * directory written through the loop variable carries no platform name, so it
 * is not one of these.
 */
function outputPlatformSets(text: string): string[][] {
  const platforms = [...text.matchAll(/\bdist-([a-z][a-z-]*)\b/g)].map((output) => output[1] ?? '');
  return platforms.length > 0 ? [platforms] : [];
}

/** Every string a step carries a value in: its script, its inputs, its environment. */
function valuesOf(step: WorkflowStep): string[] {
  return [step.run, ...Object.values(step.with ?? {}), ...Object.values(step.env ?? {})].filter(
    (value): value is string => typeof value === 'string'
  );
}

/** Every platform list the workflow spells out in one shape, wherever it sits. */
function spelledPlatformSets(read: (text: string) => string[][]): string[][] {
  return stepsOf(ci).flatMap((step) => valuesOf(step).flatMap((text) => read(text)));
}

/**
 * The mobile platform set the workflow spells out, held to the one the product
 * defines.
 *
 * {@link MOBILE_PLATFORMS} is the source of truth — the API derives its OTA
 * download route's platform schema from it — and a workflow has no import, so
 * CI spells that set out again at every site that handles the bundles one
 * platform at a time. A set the API serves and a set CI ships that disagree is
 * a platform whose bundle is never built while every job stays green, and a
 * release is where that surfaces; reading both sides here is what refuses the
 * state at the commit instead.
 *
 * The spellings are gathered by shape rather than by site, so one written in a
 * shape already read is judged with the rest and one written in a new shape is
 * invisible here. That is what the emptiness check in each assertion is for: a
 * shape that stops matching reddens rather than passing over nothing.
 */
describe('the mobile platform set the workflow spells out', () => {
  it('walks the product set in every loop over platforms', () => {
    const loops = spelledPlatformSets(loopedPlatformSets);

    expect(loops).not.toEqual([]);
    for (const platforms of loops) expect(platforms).toEqual(MOBILE_PLATFORMS);
  });

  it('names the product set in every list of per-platform build outputs', () => {
    const outputs = spelledPlatformSets(outputPlatformSets);

    expect(outputs).not.toEqual([]);
    for (const platforms of outputs) expect(platforms).toEqual(MOBILE_PLATFORMS);
  });
});

/**
 * The emulator log dump's container selection, bound to the name the launch
 * mints.
 *
 * The name is derived per checkout slot, so the prefix moves whenever the
 * compose project's spelling does; the `-emulator-shard-` infix is the part the
 * derivation keeps. Matching on that rather than on a prefix is what lets a
 * rename leave the diagnostic still selecting something — and this assertion is
 * the only thing between a renamed container and a dump that collects nothing
 * while exiting zero.
 */
describe('the emulator log dump', () => {
  /** How docker reads a `name` filter: a regular expression, matched anywhere in the name. */
  const filterOfDumpStep = (): RegExp => {
    const step = stepsOf(ci).find((candidate) => candidate.name === EMULATOR_DUMP_STEP);
    if (step?.run === undefined) {
      throw new Error(`no step named '${EMULATOR_DUMP_STEP}' runs anything in this workflow`);
    }
    const filter = NAME_FILTER.exec(step.run)?.[1];
    if (filter === undefined) {
      throw new Error(`the '${EMULATOR_DUMP_STEP}' step selects containers by no name filter`);
    }
    return new RegExp(filter);
  };

  it('selects a container the emulator launch can actually name', () => {
    expect(emulatorContainerName(4, 0)).toMatch(filterOfDumpStep());
  });

  it('selects the emulator of any slot and any shard, so one checkout is not pinned', () => {
    expect(emulatorContainerName(17, 3)).toMatch(filterOfDumpStep());
  });

  it('leaves the rest of that slot\u2019s stack alone, so the selection is not everything', () => {
    expect(`${composeProjectName(4)}-postgres-1`).not.toMatch(filterOfDumpStep());
  });
});

describe('the cassette store boundary', () => {
  it('keeps the store credential off every fork-reachable step', () => {
    const reachable = forkReachableSteps(ci).filter((step) =>
      JSON.stringify(step).includes(CASSETTE_SECRET)
    );

    expect(reachable).toEqual([]);
  });

  it('keeps the store itself off every fork-reachable step', () => {
    const reachable = forkReachableSteps(ci).filter((step) =>
      (step.run ?? '').includes(CASSETTE_ENTRY)
    );

    expect(reachable).toEqual([]);
  });

  it('still reaches the store somewhere, so the fork-reachability exclusions are not vacuous', () => {
    const touching = stepsOf(ci).filter(
      (step) =>
        JSON.stringify(step).includes(CASSETTE_SECRET) || (step.run ?? '').includes(CASSETTE_ENTRY)
    );

    expect(touching.length).toBeGreaterThan(0);
  });
});

describe('the merge-queue alignment gate', () => {
  it('exists as the job the required-check list names', () => {
    expect(ci.jobs['sync-alignment']).toBeDefined();
  });

  it('reports on every event, so a required check is never left unanswered', () => {
    expect(startsOnFork(ci, 'sync-alignment')).toBe(true);
  });

  it('only does its work inside the public repository merge queue', () => {
    const poll = (ci.jobs['sync-alignment']?.steps ?? []).find((step) =>
      (step.run ?? '').includes('scripts/publication/sync-alignment.ts')
    );

    expect(conjuncts(poll?.if ?? '')).toEqual([
      "github.event_name == 'merge_group'",
      repositoryTerm(PUBLIC_REPOSITORY_VARIABLE),
    ]);
  });
});

describe('the privacy sweep', () => {
  it('runs the repository script rather than a scan written into the workflow', () => {
    const sweep = (ci.jobs['privacy-sweep']?.steps ?? []).find((step) =>
      (step.run ?? '').includes('privacy:sweep')
    );

    expect(sweep).toBeDefined();
  });

  it('runs in the untrusted phase too, which is where a bypassed hook arrives', () => {
    expect(startsOnFork(ci, 'privacy-sweep')).toBe(true);
  });

  it('gates the deployment, so a red sweep cannot ship', () => {
    expect(dependenciesOf(ci, 'deploy')).toContain('privacy-sweep');
  });

  it('gates the mobile emulator image publication, whose layers carry the same disclosure', () => {
    expect(dependenciesOf(ci, 'push-mobile-emulator-image')).toContain('privacy-sweep');
  });
});

/**
 * The offline copy is written before the deploy that publishes the set, and the
 * lines that make that true live in the YAML alone: the dependency, the
 * deploy's success term on it, and the two jobs sharing one run condition
 * otherwise. The deploy runs past a skipped need, so dropping that term runs it
 * past a failed escrow while the dependency still reads intact — a deploy
 * publishing a secret set with no copy behind it. The term is held with every
 * other publishing condition in "the green borrow".
 */
describe('the escrow gate on the deploy', () => {
  it('gates the deployment, so no deploy publishes an unescrowed set', () => {
    expect(dependenciesOf(ci, 'deploy')).toContain('escrow');
  });

  it("runs under the deploy's own run condition less the deploy's wait on it, so neither can start where the other cannot", () => {
    const deployConditions = conjuncts(ci.jobs['deploy']?.if ?? '');

    expect(deployConditions).toContain(succeeded('escrow'));
    expect(conjuncts(ci.jobs['escrow']?.if ?? '')).toEqual(
      deployConditions.filter((clause) => clause !== succeeded('escrow'))
    );
  });
});

const alphabetical = (names: readonly string[]): string[] =>
  names.toSorted((left, right) => left.localeCompare(right));

/** The clause a borrowable check job appends to its condition. */
const BORROW_CLAUSE = "needs.borrow.outputs.borrowed != 'true'";
const BORROW_ENTRY = 'scripts/publication/green-borrow.ts';
const VERDICT_ENTRY = 'scripts/release/deploy-verdict.ts';
/** The jobs that publish, each gated by the verdict rather than by the checks. */
const PUBLISHING_JOBS = ['deploy', 'escrow', 'escrow-backup', 'push-mobile-emulator-image'];
/** What each publishing job needs: the verdict, and the jobs no borrow can prove. */
const UNBORROWED_NEEDS = ['verdict', 'privacy-sweep', 'build', 'version', 'gitleaks'];
/** The job that asks whether a release tag already sits on this commit or a descendant. */
const SHIPPED_JOB = 'shipped';
const SHIPPED_ENTRY = 'scripts/release/deploy-shipped.ts';
/** The publishing jobs a commit that already shipped stops, which wait on {@link SHIPPED_JOB}. */
const STOPPED_WHEN_SHIPPED = ['deploy', 'escrow'];
const NOT_SHIPPED = `needs.${SHIPPED_JOB}.outputs.shipped != 'true'`;
/** Jobs that can start on the deploying push and gate nothing it publishes, each for its reason. */
const OUTSIDE_THE_RELEASE = ['sync-alignment'];
const CLAIMED = "needs.version.outputs.claimed == 'true'";
/**
 * What each publishing job's condition carries besides its status function and
 * its needs' success terms: the deploying event, or the deploying push for the
 * image push, which a dispatch's unchecked run must not reach; on the two jobs
 * that publish a claimed number, the claim and the answer that this commit has
 * not shipped yet. The shipped check itself is held to the same reading.
 */
const PUBLISHING_CONDITIONS: Readonly<Record<string, readonly string[]>> = {
  deploy: [...DEPLOYING_EVENT, CLAIMED, NOT_SHIPPED],
  escrow: [...DEPLOYING_EVENT, CLAIMED, NOT_SHIPPED],
  'escrow-backup': DEPLOYING_EVENT,
  'push-mobile-emulator-image': DEPLOYING_PUSH,
  [SHIPPED_JOB]: DEPLOYING_EVENT,
};

/**
 * Borrowed jobs — those carrying the borrow clause and those inheriting it —
 * that a failed borrow would skip, or that would run on in a cancelled run:
 * each must carry {@link RUNS_PAST_SKIPS} and no other status function. A
 * skipped required check counts as passing, so a check a failed borrow skipped
 * would let a merge-queue run merge untested. GitHub's implicit `success()`
 * reads every ancestor, so an inheriting job is skipped by a failed borrow
 * however its own needs ran.
 */
const checksAFailedBorrowSkips = (workflow: Workflow): string[] =>
  borrowingJobs(workflow).filter((name) => {
    const statusFunctions = conjuncts(workflow.jobs[name]?.if ?? '').filter((clause) =>
      STATUS_FUNCTION.test(clause)
    );
    return statusFunctions.length !== 1 || statusFunctions[0] !== RUNS_PAST_SKIPS;
  });

/**
 * How a publishing job's condition departs from the one it must carry.
 * GitHub's implicit `success()` reads every ancestor rather than the direct
 * needs, so on a borrowed run the skipped checks behind the verdict would skip
 * the job; it carries {@link RUNS_PAST_SKIPS} instead, and so needs a success
 * term per direct need, derived here from its own `needs`, to stop it past a
 * failed one. Anything else it carries is reported, a status function above
 * all.
 */
function publishingConditionFaults(
  workflow: Workflow,
  name: string
): { readonly missing: string[]; readonly unexpected: string[] } {
  const required = [
    RUNS_PAST_SKIPS,
    ...dependenciesOf(workflow, name).map((need) => succeeded(need)),
    ...(PUBLISHING_CONDITIONS[name] ?? []),
  ];
  const carried = conjuncts(workflow.jobs[name]?.if ?? '');
  return {
    missing: alphabetical(required.filter((clause) => !carried.includes(clause))),
    unexpected: alphabetical(carried.filter((clause) => !required.includes(clause))),
  };
}

/** The workflow with one job's condition or needs replaced, every other job as shipped. */
const withJob = (name: string, change: Partial<WorkflowJob>): Workflow => ({
  ...ci,
  jobs: { ...ci.jobs, [name]: { ...ci.jobs[name], ...change } },
});

const secretsNamedBy = (value: unknown): string[] =>
  alphabetical([
    ...new Set(
      [...JSON.stringify(value).matchAll(/secrets\.([A-Z0-9_]+)/g)].map((match) => match[1] ?? '')
    ),
  ]);

/**
 * The jobs a borrow skips: those whose condition carries the borrow clause,
 * and those whose every need is one of them, which a skip reaches through
 * `needs` alone.
 */
function borrowingJobs(workflow: Workflow): string[] {
  const carrying = Object.keys(workflow.jobs).filter((name) =>
    conjuncts(workflow.jobs[name]?.if ?? '').includes(BORROW_CLAUSE)
  );
  const inheriting = Object.keys(workflow.jobs).filter((name) => {
    const needs = dependenciesOf(workflow, name);
    return (
      !carrying.includes(name) &&
      needs.length > 0 &&
      needs.every((dependency) => carrying.includes(dependency))
    );
  });
  return alphabetical([...carrying, ...inheriting]);
}

/** Jobs whose condition reads the borrow's output without needing the borrow job. */
const readingBorrowUnawaited = (workflow: Workflow): string[] =>
  Object.keys(workflow.jobs).filter(
    (name) =>
      conjuncts(workflow.jobs[name]?.if ?? '').includes(BORROW_CLAUSE) &&
      !dependenciesOf(workflow, name).includes('borrow')
  );

/** Every job one job waits on, however many hops away. */
function transitiveNeeds(workflow: Workflow, name: string): string[] {
  const reached = new Set<string>();
  const pending = [...dependenciesOf(workflow, name)];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (reached.has(next)) continue;
    reached.add(next);
    pending.push(...dependenciesOf(workflow, next));
  }
  return [...reached];
}

/** The two events that deploy, each starting its own set of jobs. */
const DEPLOYING_EVENT_NAMES = ['push', DISPATCH];

/**
 * Whether one event can start a job: nothing in its own condition keeps the
 * event out, and its needs can start too — under a status function, only the
 * needs its condition requires to succeed.
 */
function startsOnEvent(workflow: Workflow, name: string, event: string): boolean {
  const job = workflow.jobs[name];
  if (job === undefined) return false;
  if (conjuncts(job.if ?? '').some((clause) => keepsEventOut(clause, event))) return false;
  const needs = readmitsSkippedNeeds(job.if)
    ? needsRequiredToSucceed(workflow, name)
    : dependenciesOf(workflow, name);
  return needs.every((dependency) => startsOnEvent(workflow, dependency, event));
}

/**
 * Every job a deploying event can start that neither publishes nor gates what
 * publishes, read over the transitive needs of the deploy and of the verdict.
 */
function outsideTheRelease(workflow: Workflow, event: string): string[] {
  const gating = new Set([
    ...PUBLISHING_JOBS,
    ...transitiveNeeds(workflow, 'deploy'),
    ...transitiveNeeds(workflow, 'verdict'),
  ]);
  return alphabetical(
    Object.keys(workflow.jobs).filter(
      (name) => startsOnEvent(workflow, name, event) && !gating.has(name)
    )
  );
}

const stepRunning = (name: string, entry: string): WorkflowStep | undefined =>
  (ci.jobs[name]?.steps ?? []).find((step) => (step.run ?? '').includes(entry));

/** The output keys `text` reads from `owner`, a `steps.<id>` or a `needs.<job>`. */
const outputsRead = (text: string, owner: string): string[] => {
  const escaped = owner.replaceAll('.', String.raw`\.`);
  return [...text.matchAll(new RegExp(String.raw`\b${escaped}\.outputs\.([\w-]+)`, 'g'))].map(
    (match) => match[1] ?? ''
  );
};

/**
 * The keys of one step's outputs that reach a consumer job: each
 * `needs.<producer>.outputs.<name>` the consumer's condition reads, followed
 * through the producer's `outputs` to the step output that name carries.
 */
const stepOutputsReaching = (
  workflow: Workflow,
  producer: string,
  stepId: string,
  consumer: string
): string[] =>
  outputsRead(workflow.jobs[consumer]?.if ?? '', `needs.${producer}`).flatMap((name) =>
    outputsRead(workflow.jobs[producer]?.outputs?.[name] ?? '', `steps.${stepId}`)
  );

/**
 * A push to public `main` whose exact commit staging's trusted run proved skips
 * the checks that proof covers, and one judged verdict stands between every
 * check and everything that publishes. The skip and the gate live in the YAML
 * alone, so they are pinned here; the judgement itself is unit-tested beside
 * the two scripts.
 */
describe('the green borrow', () => {
  it('runs on every event its repository gate admits, as the alignment gate does', () => {
    expect(ci.jobs['borrow']?.if).toBe(ci.jobs['sync-alignment']?.if);
  });

  it('starts on a fork pull request, so no check that needs it inherits a skip', () => {
    expect(startsOnFork(ci, 'borrow')).toBe(true);
  });

  it('does its work on the deploying push alone', () => {
    const guards = (ci.jobs['borrow']?.steps ?? []).map((step) =>
      alphabetical(conjuncts(step.if ?? ''))
    );

    expect(guards.length).toBeGreaterThan(0);
    expect(guards).toEqual(guards.map(() => alphabetical(DEPLOYING_PUSH)));
  });

  it("names only the sync app's two credentials", () => {
    expect(secretsNamedBy(ci.jobs['borrow'])).toEqual(
      alphabetical([APP_ID_VARIABLE, PRIVATE_KEY_VARIABLE])
    );
  });

  it('runs the borrow script', () => {
    expect(stepRunning('borrow', BORROW_ENTRY)).toBeDefined();
  });

  it("outputs the borrow script's answer", () => {
    const step = stepRunning('borrow', BORROW_ENTRY);

    expect(step?.id).toBeDefined();
    expect(ci.jobs['borrow']?.outputs?.['borrowed']).toBe(
      `\${{ steps.${step?.id ?? ''}.outputs.borrowed }}`
    );
  });

  it('skips exactly the jobs the shared borrowed-job list names', () => {
    expect(borrowingJobs(ci)).toEqual(alphabetical(BORROWED_JOBS));
  });

  it('reports a job planted with the borrow clause, so the reading is not vacuous', () => {
    const planted: Workflow = {
      ...ci,
      jobs: {
        ...ci.jobs,
        planted: { needs: ['borrow'], if: `${TRUSTED_PHASE} && ${BORROW_CLAUSE}` },
      },
    };

    expect(borrowingJobs(planted)).toContain('planted');
  });

  it('runs every borrowed job past a failed borrow, under no other status function', () => {
    expect(checksAFailedBorrowSkips(ci)).toEqual([]);
  });

  it('reports a job inheriting the borrow with no status function, so the inherited reading is not vacuous', () => {
    const planted: Workflow = { ...ci, jobs: { ...ci.jobs, planted: { needs: ['lint'] } } };

    expect(checksAFailedBorrowSkips(planted)).toEqual(['planted']);
  });

  it('reports a check carrying the clause with no status function, so that reading is not vacuous', () => {
    const planted: Workflow = {
      ...ci,
      jobs: {
        ...ci.jobs,
        planted: { needs: ['borrow'], if: `${TRUSTED_PHASE} && ${BORROW_CLAUSE}` },
      },
    };

    expect(checksAFailedBorrowSkips(planted)).toEqual(['planted']);
  });

  it('reports a check carrying the clause under a status function that outlives a cancel', () => {
    const planted: Workflow = {
      ...ci,
      jobs: {
        ...ci.jobs,
        planted: { needs: ['borrow'], if: `always() && ${TRUSTED_PHASE} && ${BORROW_CLAUSE}` },
      },
    };

    expect(checksAFailedBorrowSkips(planted)).toEqual(['planted']);
  });

  it('makes every job carrying the clause wait for the borrow it reads', () => {
    expect(readingBorrowUnawaited(ci)).toEqual([]);
  });

  it('reports a job reading the borrow without waiting for it, so that reading is not vacuous', () => {
    const planted: Workflow = {
      ...ci,
      jobs: { ...ci.jobs, planted: { if: `${TRUSTED_PHASE} && ${BORROW_CLAUSE}`, steps: [] } },
    };

    expect(readingBorrowUnawaited(planted)).toEqual(['planted']);
  });

  it('never skips the checks that depend on the event or on public\u2019s tags', () => {
    const skipping = [
      'gitleaks',
      'privacy-sweep',
      'version',
      'version-claim',
      'build',
      'sync-alignment',
    ].filter(
      (name) =>
        borrowingJobs(ci).includes(name) || (ci.jobs[name]?.if ?? '').includes('needs.borrow')
    );

    expect(skipping).toEqual([]);
  });

  it('judges the borrow and every borrowable check in the verdict', () => {
    expect(alphabetical(dependenciesOf(ci, 'verdict'))).toEqual(
      alphabetical(['borrow', ...BORROWED_JOBS])
    );
  });

  it("judges past skipped needs, under the deploy's own event conditions", () => {
    const eventConditions = conjuncts(ci.jobs['deploy']?.if ?? '').filter(
      (clause) => !clause.includes('needs.') && clause !== RUNS_PAST_SKIPS
    );

    expect(eventConditions.length).toBeGreaterThan(0);
    expect(conjuncts(ci.jobs['verdict']?.if ?? '')).toEqual(['!cancelled()', ...eventConditions]);
  });

  it('runs the verdict script on the whole needs context, handed over through env', () => {
    const step = stepRunning('verdict', VERDICT_ENTRY);

    expect(step?.env?.['NEEDS']).toBe('${{ toJSON(needs) }}');
    expect(step?.run).not.toContain('${{');
  });

  it.each(PUBLISHING_JOBS)(
    'gates %s on the verdict and the unborrowable checks, never on a borrowed job',
    (name) => {
      const expected = [
        ...UNBORROWED_NEEDS,
        ...(STOPPED_WHEN_SHIPPED.includes(name) ? [SHIPPED_JOB] : []),
        ...(name === 'deploy' ? ['escrow'] : []),
      ];

      expect(alphabetical(dependenciesOf(ci, name))).toEqual(alphabetical(expected));
    }
  );

  it.each(PUBLISHING_JOBS)(
    'runs %s past skips alone, on the success of every direct need and its own event conditions',
    (name) => {
      expect(publishingConditionFaults(ci, name)).toEqual({ missing: [], unexpected: [] });
    }
  );

  it('reports a need added to a publishing job without its success term', () => {
    const planted = withJob('deploy', { needs: [...dependenciesOf(ci, 'deploy'), 'planted'] });

    expect(publishingConditionFaults(planted, 'deploy').missing).toEqual([succeeded('planted')]);
  });

  it('reports a publishing job run under a status function other than the one that stops at a cancel', () => {
    const shipped = ci.jobs['deploy']?.if ?? '';
    const planted = withJob('deploy', { if: shipped.replace(RUNS_PAST_SKIPS, 'always()') });

    expect(publishingConditionFaults(planted, 'deploy')).toEqual({
      missing: [RUNS_PAST_SKIPS],
      unexpected: ['always()'],
    });
  });

  it('reports a publishing job whose claim condition was dropped', () => {
    const planted = withJob('deploy', {
      if: conjuncts(ci.jobs['deploy']?.if ?? '')
        .filter((clause) => clause !== CLAIMED)
        .join(' && '),
    });

    expect(publishingConditionFaults(planted, 'deploy')).toEqual({
      missing: [CLAIMED],
      unexpected: [],
    });
  });

  it.each(DEPLOYING_EVENT_NAMES)(
    'leaves no job the deploying %s starts outside the release but the exempt ones',
    (event) => {
      expect(outsideTheRelease(ci, event)).toEqual(alphabetical(OUTSIDE_THE_RELEASE));
    }
  );

  it.each(DEPLOYING_EVENT_NAMES)(
    'reports a job planted outside the release of the deploying %s, so the closure is not vacuous',
    (event) => {
      const planted: Workflow = {
        ...ci,
        jobs: {
          ...ci.jobs,
          planted: { if: repositoryTerm(PUBLIC_REPOSITORY_VARIABLE), steps: [] },
        },
      };

      expect(outsideTheRelease(planted, event)).toContain('planted');
    }
  );

  it('leaves a job pinned to another event out of what the deploying push starts', () => {
    const planted: Workflow = {
      ...ci,
      jobs: { ...ci.jobs, planted: { if: "github.event_name == 'merge_group'", steps: [] } },
    };

    expect(outsideTheRelease(planted, 'push')).not.toContain('planted');
  });

  it('leaves a job kept out of a dispatch out of what the dispatch starts', () => {
    const planted: Workflow = {
      ...ci,
      jobs: { ...ci.jobs, planted: { if: NOT_DISPATCHED, steps: [] } },
    };

    expect(outsideTheRelease(planted, DISPATCH)).not.toContain('planted');
  });

  it('starts none of the borrowable checks on a dispatch', () => {
    expect(BORROWED_JOBS.filter((name) => startsOnEvent(ci, name, DISPATCH))).toEqual([]);
  });

  it('keeps a dispatch out of every check that reads the borrow by a clause of its own', () => {
    const unkept = Object.keys(ci.jobs).filter((name) => {
      const clauses = conjuncts(ci.jobs[name]?.if ?? '');
      return clauses.includes(BORROW_CLAUSE) && !clauses.includes(NOT_DISPATCHED);
    });

    expect(unkept).toEqual([]);
  });

  it('still starts every borrowable check on the deploying push', () => {
    expect(BORROWED_JOBS.filter((name) => !startsOnEvent(ci, name, 'push'))).toEqual([]);
  });

  it('reads a job run past skips only on a kept-out need\u2019s success as kept out too', () => {
    const planted: Workflow = {
      jobs: {
        leader: { if: NOT_DISPATCHED, steps: [] },
        follower: { needs: ['leader'], if: `${RUNS_PAST_SKIPS} && ${succeeded('leader')}` },
      },
    };

    expect(startsOnEvent(planted, 'follower', DISPATCH)).toBe(false);
  });
});

/**
 * A release tag on the commit or a descendant means a dispatched run already
 * shipped this code, so the push run of the same commit stops before escrow
 * and deploy rather than shipping it again under a second number. The check
 * runs late, behind every gate the publishing jobs wait on, because the tag it
 * looks for is pushed at the end of the other run's deploy.
 */
describe('the shipped check', () => {
  const shipped = ci.jobs[SHIPPED_JOB];

  it('waits on exactly what the publishing jobs wait on', () => {
    expect(alphabetical(dependenciesOf(ci, SHIPPED_JOB))).toEqual(alphabetical(UNBORROWED_NEEDS));
  });

  it('runs past skips alone, on the success of every direct need and on the deploying event', () => {
    expect(publishingConditionFaults(ci, SHIPPED_JOB)).toEqual({ missing: [], unexpected: [] });
  });

  it('runs the shipped script with nothing spliced into its command', () => {
    const step = stepRunning(SHIPPED_JOB, SHIPPED_ENTRY);

    expect(step?.run).toBe(`pnpm tsx ${SHIPPED_ENTRY}`);
  });

  it("outputs the shipped script's answer", () => {
    const step = stepRunning(SHIPPED_JOB, SHIPPED_ENTRY);

    expect(step?.id).toBeDefined();
    expect(shipped?.outputs).toEqual({
      shipped: `\${{ steps.${step?.id ?? ''}.outputs.shipped }}`,
    });
  });

  it('checks out the whole history, which the descendant walk needs', () => {
    const checkout = (shipped?.steps ?? []).find((step) =>
      (step.uses ?? '').startsWith('actions/checkout@')
    );

    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });

  it.each(STOPPED_WHEN_SHIPPED)(
    "carries the shipped script's answer to %s under the key the script writes",
    (name) => {
      const step = stepRunning(SHIPPED_JOB, SHIPPED_ENTRY);

      expect(stepOutputsReaching(ci, SHIPPED_JOB, step?.id ?? '', name)).toEqual([SHIPPED_OUTPUT]);
    }
  );

  it.each(STOPPED_WHEN_SHIPPED)(
    'reports a shipped step output %s no longer reaches under that key',
    (name) => {
      const step = stepRunning(SHIPPED_JOB, SHIPPED_ENTRY);
      const renamed = Object.fromEntries(
        Object.entries(shipped?.outputs ?? {}).map(([output, value]) => [
          output,
          value.replace(`.outputs.${SHIPPED_OUTPUT}`, '.outputs.renamed'),
        ])
      );
      const control = withJob(SHIPPED_JOB, { outputs: renamed });

      expect(stepOutputsReaching(control, SHIPPED_JOB, step?.id ?? '', name)).toEqual(['renamed']);
    }
  );

  it.each(STOPPED_WHEN_SHIPPED)('stops %s where this commit already shipped', (name) => {
    expect(conjuncts(ci.jobs[name]?.if ?? '')).toEqual(
      expect.arrayContaining([succeeded(SHIPPED_JOB), NOT_SHIPPED])
    );
  });
});

/**
 * The image publication carries the full check suite's word, so it runs on
 * the deploying push alone: a dispatched run ships without the checks.
 */
describe('the mobile emulator image push', () => {
  it('runs on the push alone, never on a dispatch', () => {
    expect(conjuncts(ci.jobs['push-mobile-emulator-image']?.if ?? '')).toEqual(
      expect.arrayContaining(DEPLOYING_PUSH)
    );
    expect(startsOnEvent(ci, 'push-mobile-emulator-image', DISPATCH)).toBe(false);
  });
});

/** The script both build-identity steps run: the build stamps, the deploy checks. */
const STAMP_ENTRY = 'scripts/stamp-build-identity.ts';
const SURFACE_PROBE_ENTRY = 'scripts/release/verify-deployed-surfaces.ts';
const SURFACE_PROBE_STEP = 'Verify every deployed surface serves this version';
const API_HEALTH_STEP = 'Verify API health (real host + version/OTA assert)';
/** A deploy command that publishes a surface from its step's working directory. */
const DEPLOY_COMMAND = /\bwrangler (?:pages )?deploy\b/;

/** Whether a step runs a surface deploy, reading its commands and never its shell comments. */
const publishesSurface = (candidate: WorkflowStep): boolean =>
  (candidate.run ?? '')
    .split('\n')
    .some((line) => !line.trimStart().startsWith('#') && DEPLOY_COMMAND.test(line));
const byKey = (left: string, right: string): number => left.localeCompare(right);

/** The keys a generated section binds, read off its rendered entries. */
const generatedKeys = (marker: string): string[] =>
  (workflowSections()[marker]?.content ?? '')
    .split('\n')
    .map((line) => /^\s*([A-Z][A-Z0-9_]*):/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);

/** The dists a step's command names after its fixed prefix, in order of name. */
const namedDists = (run: string, prefix: string): string[] =>
  alphabetical(run.trim().slice(prefix.length).split(/\s+/));

/** The working directory of every deploy step that publishes a surface; the root when it names none. */
const deployedSurfaces = (workflow: Workflow): string[] =>
  (workflow.jobs['deploy']?.steps ?? [])
    .filter((candidate) => publishesSurface(candidate))
    .map((candidate) => candidate['working-directory'] ?? '.');

/**
 * The artifacts the deploy job downloads into a surface's directory: the
 * built dists it publishes as they were built, rather than building them.
 */
const downloadedDists = (workflow: Workflow): string[] => {
  const surfaces = deployedSurfaces(workflow);
  return (workflow.jobs['deploy']?.steps ?? [])
    .filter((candidate) => (candidate.uses ?? '').startsWith('actions/download-artifact@'))
    .map((candidate) => String(candidate.with?.['path']))
    .filter((bundle) => surfaces.some((surface) => bundle.startsWith(`${surface}/`)));
};

/**
 * The surfaces the deploy publishes that nothing probes, and the ones the probe
 * names that the deploy does not publish. The API is proven by the health step
 * rather than by the surface probe; every other surface is one the probe
 * script declares.
 */
function unprobedSurfaces(workflow: Workflow): {
  readonly unprobed: string[];
  readonly unpublished: string[];
} {
  const health = (workflow.jobs['deploy']?.steps ?? []).find(
    (candidate) => candidate.name === API_HEALTH_STEP
  );
  const probed = new Set([
    ...Object.keys(SURFACES),
    ...((health?.run ?? '').includes('$API_URL/health') ? ['apps/api'] : []),
  ]);
  const published = new Set(deployedSurfaces(workflow));
  return {
    unprobed: alphabetical([...published].filter((surface) => !probed.has(surface))),
    unpublished: alphabetical([...probed].filter((surface) => !published.has(surface))),
  };
}

/** The deploy step that refuses a version not newer than the one production runs. */
const ORDER_GUARD_STEP = 'Refuse a deploy not newer than production';

/**
 * Deploys queue in one group, but a group does not promise to release its
 * pending runs in the order they arrived, and the native client applies any
 * server version that differs from its own, lower included. So the order is
 * enforced inside the job: a guard reading the API Worker's live tag stops an
 * out-of-order run before its first publishing step. Each publishing step is
 * named here rather than found, so a step renamed or removed fails the
 * ordering assertion instead of leaving it with less to check.
 */
describe('the deploy order', () => {
  const deploy = ci.jobs['deploy'];
  const deploySteps = deploy?.steps ?? [];
  const position = (name: string): number => deploySteps.findIndex((step) => step.name === name);
  const step = (name: string): WorkflowStep | undefined =>
    deploySteps.find((candidate) => candidate.name === name);
  const VERSION_OUTPUT = `\${{ needs.version.outputs.version }}`;
  const WORKER_DEPLOYS = [
    'Deploy API to Workers',
    'Deploy Admin assets Worker',
    'Deploy Sandbox assets Worker',
  ];
  const PUBLISHING_STEPS = [
    'Guard against re-publishing an existing OTA bundle',
    'Upload mobile OTA bundles to R2',
    'Publish on-device model artifacts to R2',
    'Run pre-deploy ops scripts',
    'Run database migrations (production)',
    'Deploy Web to Pages',
    ...WORKER_DEPLOYS,
    'Run post-deploy ops scripts',
    'Tag release',
  ];

  it('queues every deploy in one group rather than cancelling a pending one', () => {
    expect(deploy?.concurrency).toEqual({
      group: 'production-deploy',
      'cancel-in-progress': false,
      queue: 'max',
    });
  });

  it('deploys only a run that claimed its version', () => {
    expect(conjuncts(deploy?.if ?? '')).toContain("needs.version.outputs.claimed == 'true'");
  });

  it('runs the order guard directly after the version check', () => {
    expect(position('Verify version')).toBeGreaterThanOrEqual(0);
    expect(position(ORDER_GUARD_STEP)).toBe(position('Verify version') + 1);
  });

  it('runs the order guard before every step that publishes', () => {
    const guard = position(ORDER_GUARD_STEP);

    expect(guard).toBeGreaterThanOrEqual(0);
    for (const name of PUBLISHING_STEPS) {
      expect(position(name), name).toBeGreaterThan(guard);
    }
  });

  it('runs the guard script on the version being deployed, holding only the credentials wrangler reads', () => {
    const guard = step(ORDER_GUARD_STEP);

    expect(guard?.run).toBe('pnpm tsx scripts/release/deploy-order-guard.ts');
    expect(guard?.env).toEqual({
      CLOUDFLARE_API_TOKEN: `\${{ secrets.CLOUDFLARE_API_TOKEN }}`,
      CLOUDFLARE_ACCOUNT_ID: `\${{ secrets.CLOUDFLARE_ACCOUNT_ID }}`,
      VERSION: VERSION_OUTPUT,
    });
  });

  it('tags every Worker version it deploys with the release it carries', () => {
    for (const name of WORKER_DEPLOYS) {
      expect(step(name)?.run, name).toContain('wrangler deploy');
      expect(step(name)?.run, name).toContain('--tag "v$VERSION" --message "$GITHUB_SHA"');
      expect(step(name)?.env?.['VERSION'], name).toBe(VERSION_OUTPUT);
    }
  });

  it('tells a reader of a tripped OTA guard to claim a new number rather than reuse this one', () => {
    const otaGuard = step('Guard against re-publishing an existing OTA bundle')?.run ?? '';

    expect(otaGuard).toContain('re-run all jobs');
    expect(otaGuard).not.toContain('bump the version');
  });

  const IDENTITY_CHECK = `pnpm tsx ${STAMP_ENTRY} check `;
  const identityCheck = deploySteps.find((candidate) =>
    (candidate.run ?? '').startsWith(IDENTITY_CHECK)
  );

  it('checks the stamp of every downloaded dist it publishes', () => {
    const bundles = downloadedDists(ci);

    expect(bundles).not.toEqual([]);
    expect(namedDists(identityCheck?.run ?? '', IDENTITY_CHECK)).toEqual(alphabetical(bundles));
    expect(identityCheck?.env).toEqual({ VERSION: VERSION_OUTPUT });
  });

  it('checks the stamps after every dist is downloaded and before every step that publishes', () => {
    const check = deploySteps.indexOf(identityCheck ?? {});
    const downloads = deploySteps.filter((candidate) =>
      downloadedDists(ci).includes(String(candidate.with?.['path']))
    );

    expect(check).toBeGreaterThanOrEqual(0);
    for (const download of downloads) {
      expect(deploySteps.indexOf(download), download.name).toBeLessThan(check);
    }
    for (const name of PUBLISHING_STEPS) {
      expect(position(name), name).toBeGreaterThan(check);
    }
  });

  const probe = step(SURFACE_PROBE_STEP);

  it('probes the deployed surfaces after every surface is published and the API is proven', () => {
    const at = position(SURFACE_PROBE_STEP);
    const surfaceDeploys = deploySteps.filter((candidate) => publishesSurface(candidate));

    expect(at).toBeGreaterThanOrEqual(0);
    expect(surfaceDeploys).not.toEqual([]);
    for (const deployed of surfaceDeploys) {
      expect(deploySteps.indexOf(deployed), deployed.name).toBeLessThan(at);
    }
    expect(position('Run post-deploy ops scripts')).toBeLessThan(at);
    expect(position(API_HEALTH_STEP)).toBeLessThan(at);
  });

  it('probes the deployed surfaces before the release is tagged, under no condition of its own', () => {
    expect(position(SURFACE_PROBE_STEP)).toBeGreaterThanOrEqual(0);
    expect(position(SURFACE_PROBE_STEP)).toBeLessThan(position('Tag release'));
    expect(probe?.if).toBeUndefined();
  });

  it('runs the surface probe script', () => {
    expect(probe?.run).toBe(`pnpm tsx ${SURFACE_PROBE_ENTRY}`);
  });

  it('binds the probe the Access team from its secret, the credentials wrangler reads, the version and the generated surface origins, and nothing else', () => {
    const surfaceKeys = generatedKeys('deploy-surfaces-env');

    expect(Object.keys(probe?.env ?? {}).toSorted(byKey)).toEqual(
      [
        'CF_ACCESS_TEAM_DOMAIN',
        'CLOUDFLARE_ACCOUNT_ID',
        'CLOUDFLARE_API_TOKEN',
        'VERSION',
        ...surfaceKeys,
      ].toSorted(byKey)
    );
    expect(probe?.env?.['CF_ACCESS_TEAM_DOMAIN']).toBe(`\${{ secrets.CF_ACCESS_TEAM_DOMAIN }}`);
    expect(probe?.env?.['VERSION']).toBe(VERSION_OUTPUT);
  });

  it('probes every surface the deploy publishes, as read off its deploy steps', () => {
    expect(unprobedSurfaces(ci)).toEqual({ unprobed: [], unpublished: [] });
  });

  it('reports a planted marketing Worker deploy as a surface nobody probes, so the derivation is not vacuous', () => {
    const planted: Workflow = structuredClone(ci);
    planted.jobs['deploy']?.steps?.push({
      name: 'Deploy Marketing assets Worker',
      'working-directory': 'apps/marketing',
      run: 'pnpm exec wrangler deploy --tag "v$VERSION"',
    });

    expect(unprobedSurfaces(planted).unprobed).toEqual(['apps/marketing']);
  });
});

/**
 * The build stamps every dist the deploy downloads with the version it
 * carries, outside the turbo task so a cache replay cannot carry a stale
 * stamp; the web stamp lands after the last step that writes into that dist
 * and before the bundle guard reads it.
 */
describe('the build identity stamp', () => {
  const buildSteps = ci.jobs['build']?.steps ?? [];
  const STAMP = `pnpm tsx ${STAMP_ENTRY} stamp `;
  const stamp = buildSteps.find((candidate) => (candidate.run ?? '').startsWith(STAMP));
  const at = (name: string): number => buildSteps.findIndex((candidate) => candidate.name === name);

  it('stamps every dist the deploy downloads', () => {
    const bundles = downloadedDists(ci);

    expect(bundles).not.toEqual([]);
    expect(namedDists(stamp?.run ?? '', STAMP)).toEqual(alphabetical(bundles));
  });

  it('stamps the version the build bakes', () => {
    expect(stamp?.env).toEqual({ VERSION: `\${{ needs.version.outputs.version }}` });
  });

  it('stamps each dist before the step that uploads it', () => {
    const position = buildSteps.indexOf(stamp ?? {});

    expect(position).toBeGreaterThanOrEqual(0);
    for (const bundle of downloadedDists(ci)) {
      const upload = buildSteps.findIndex(
        (candidate) =>
          (candidate.uses ?? '').startsWith('actions/upload-artifact@') &&
          candidate.with?.['path'] === bundle
      );
      expect(upload, bundle).toBeGreaterThan(position);
    }
  });

  it('stamps the web dist after its headers are written and before the bundle guard', () => {
    const position = buildSteps.indexOf(stamp ?? {});

    expect(at('Generate _headers (CSP hashes per marketing route)')).toBeGreaterThanOrEqual(0);
    expect(at('Generate _headers (CSP hashes per marketing route)')).toBeLessThan(position);
    expect(at('Verify web bundle')).toBeGreaterThan(position);
  });
});

/** The jobs that wait on the scan: those that publish, and the shipped check that gates two of them. */
const BEHIND_THE_SCAN = new Set([...PUBLISHING_JOBS, SHIPPED_JOB]);

/**
 * Jobs whose condition reads the scan's result, less the success term each
 * job behind it carries: no check or build waits on the scan, and a job
 * behind it reads it only to stop past a failed one.
 */
const readingTheScan = (workflow: Workflow): string[] =>
  Object.entries(workflow.jobs)
    .filter(([name, job]) => {
      const guard = job.if ?? '';
      const read = BEHIND_THE_SCAN.has(name) ? guard.replace(succeeded('gitleaks'), '') : guard;
      return read.includes('needs.gitleaks');
    })
    .map(([name]) => name);

/**
 * The secret scan gates what publishes and nothing else: a check or build job
 * waiting on it only lengthens the run, while each job that ships something
 * names it directly so a red scan still stops the release.
 */
describe('the secret scan as a gate', () => {
  it('is a direct need of exactly the jobs that publish and the shipped check that gates them', () => {
    const gated = Object.keys(ci.jobs).filter((name) =>
      dependenciesOf(ci, name).includes('gitleaks')
    );

    expect(alphabetical(gated)).toEqual(
      alphabetical(['deploy', 'escrow', 'escrow-backup', 'push-mobile-emulator-image', SHIPPED_JOB])
    );
  });

  it("appears in no job's run condition but as a publishing job's success term", () => {
    expect(readingTheScan(ci)).toEqual([]);
  });

  it('reports a job outside the publishing ones reading the scan, so that reading is not vacuous', () => {
    const shipped = ci.jobs['build']?.if ?? '';
    const planted = withJob('build', { if: `${shipped} && ${succeeded('gitleaks')}` });

    expect(readingTheScan(planted)).toEqual(['build']);
  });
});

/**
 * Which scanner runs is split by event. The vendor's Action authenticates with
 * a licence held as a repository secret, so no fork may reach it; its
 * behaviour on a dispatch is undocumented, and the question a dispatch asks is
 * whether the tree it ships holds a secret, which the repository's own tree
 * scan answers. Every other event keeps the Action.
 */
describe('the secret scan on each event', () => {
  const TREE_SCAN_EVENTS = `${FORK_PHASE} || github.event_name == '${DISPATCH}'`;
  const scanSteps = ci.jobs['gitleaks']?.steps ?? [];

  it('installs the repository toolchain and scans the tree on a pull request and on a dispatch', () => {
    const tree = scanSteps.filter(
      (step) => step.uses === './.github/actions/setup-ci' || step.run === 'pnpm gitleaks:scan'
    );

    expect(tree.map((step) => step.if)).toEqual([TREE_SCAN_EVENTS, TREE_SCAN_EVENTS]);
  });

  it("runs the vendor's Action on every other event", () => {
    const vendor = scanSteps.filter((step) =>
      (step.uses ?? '').startsWith('gitleaks/gitleaks-action@')
    );

    expect(vendor.map((step) => conjuncts(step.if ?? ''))).toEqual([
      [TRUSTED_PHASE, NOT_DISPATCHED],
    ]);
  });
});

/**
 * Which two commits an event introduced is that event's own question, and each
 * answers it with different payload fields. Reconciled against the file's
 * declared triggers, so a trigger added without its pair of fields reds
 * rather than silently taking the range from whichever field happened to hold
 * something.
 */
const RANGE_FIELDS: Record<string, { readonly base: string; readonly head: string }> = {
  pull_request: {
    base: 'github.event.pull_request.base.sha',
    head: 'github.event.pull_request.head.sha',
  },
  merge_group: {
    base: 'github.event.merge_group.base_sha',
    head: 'github.event.merge_group.head_sha',
  },
  push: { base: 'github.event.before', head: 'github.event.after' },
  [DISPATCH]: { base: 'github.sha', head: 'github.sha' },
};

/**
 * The date half of the same bypass. The hook normalizes and the push gate
 * refuses, both skippable; nothing in continuous integration read a commit date
 * until this step.
 */
describe('the commit-date backstop', () => {
  const backstop = (ci.jobs['privacy-sweep']?.steps ?? []).find((step) =>
    (step.run ?? '').includes('verify-commit-dates.ts')
  );

  const rangeExpression = (variable: string): string => {
    const value = backstop?.env?.[variable];
    return typeof value === 'string' ? value : '';
  };

  it('runs the repository script rather than a check written into the workflow', () => {
    expect(backstop).toBeDefined();
  });

  it('takes its range from the event rather than from the checkout', () => {
    expect(Object.keys(backstop?.env ?? {})).toEqual([BASE_VARIABLE, HEAD_VARIABLE]);
  });

  it('judges every event the workflow declares, rather than one arm of the trunk', () => {
    expect(backstop?.if).toBeUndefined();
  });

  it('names the pair of fields every declared event answers the range with', () => {
    expect(alphabetical(triggerEvents(ci.on))).toEqual(alphabetical(Object.keys(RANGE_FIELDS)));
  });

  it('builds its range from whichever event surfaced the commits', () => {
    const base = rangeExpression(BASE_VARIABLE);
    const head = rangeExpression(HEAD_VARIABLE);

    for (const [event, fields] of Object.entries(RANGE_FIELDS)) {
      expect({
        event,
        base: base.includes(fields.base),
        head: head.includes(fields.head),
      }).toEqual({ event, base: true, head: true });
    }
  });

  it('falls back to the dispatched commit at both ends, the empty range a dispatch introduces', () => {
    expect([rangeExpression(BASE_VARIABLE), rangeExpression(HEAD_VARIABLE)]).toEqual([
      expect.stringMatching(/ \|\| github\.sha \}\}$/),
      expect.stringMatching(/ \|\| github\.sha \}\}$/),
    ]);
  });

  it('checks out the history the range needs, without which the walk cannot run', () => {
    const checkout = (ci.jobs['privacy-sweep']?.steps ?? []).find((step) =>
      (step.uses ?? '').startsWith('actions/checkout@')
    );

    expect(checkout?.with?.['fetch-depth']).toBe(0);
  });
});

describe('the tracked repository configuration', () => {
  it('is what a step reads, so only job-level conditions need the variables', async () => {
    const repositories = await readRepositories();

    expect(repositories.publicRepo).not.toBe(repositories.stagingRepo);
  });

  it('is never restated as a literal inside a workflow', async () => {
    const { publicRepo, stagingRepo } = await readRepositories();
    const sources = ['ci.yml', 'release.yml'].map((file) =>
      readFileSync(path.join(WORKFLOWS, file), 'utf8')
    );

    for (const source of sources) {
      expect(source).not.toContain(publicRepo);
      expect(source).not.toContain(stagingRepo);
    }
  });
});

/**
 * Every toolchain pin a fleet action carries is must-agree duplication the
 * duplication checker never sees, because its scan reaches no YAML at all. So
 * the phase-aware action delegates to the two fleet actions rather than
 * carrying a third copy of what they declare, which would drift by phase, and
 * what measures these files instead is this block, which reads the phase-aware
 * action and both fleets' `action.yml` and asserts over their steps.
 */
describe('the phase-aware setup action', () => {
  const ACTIONS = path.join(REPO_ROOT, '.github', 'actions');
  const setupCi = parse(readFileSync(path.join(ACTIONS, 'setup-ci', 'action.yml'), 'utf8')) as {
    runs: { steps: WorkflowStep[] };
  };

  it('names no action but the two fleet actions, so no pin is restated here', () => {
    const foreign = setupCi.runs.steps
      .map((step) => step.uses ?? '')
      .filter((uses) => !uses.startsWith('./.github/actions/'));

    expect(foreign).toEqual([]);
  });

  it('sets up both trust phases, so neither fleet is left without a toolchain', () => {
    const guards = setupCi.runs.steps.map((step) => step.if);

    expect(guards).toEqual([FORK_PHASE, TRUSTED_PHASE]);
  });

  it('delegates to actions that exist', () => {
    for (const step of setupCi.runs.steps) {
      const action = (step.uses ?? '').replace('./.github/actions/', '');
      expect(readFileSync(path.join(ACTIONS, action, 'action.yml'), 'utf8')).toContain('composite');
    }
  });

  /**
   * The pnpm store holds the Node runtime as well as the packages, so a fleet
   * that stops caching it — or stops being able to restore the previous store
   * once a lockfile edit turns its key over — re-downloads that runtime on
   * every job: slower CI behind a green check, which nothing else would
   * report. What this reads is what a working store cache depends on, never
   * how those lines are spelled, so a reworded step, a bumped cache ref or a
   * renamed fallback prefix moves nothing here. It takes the YAML as text
   * rather than opening a file, which is what lets the cases below aim it at a
   * damaged fleet action without a damaged fleet action existing on disk.
   */
  const storeCacheFault = (fleet: string, action: string): string => {
    const input = (step: WorkflowStep, key: string): string => {
      const value = step.with?.[key];
      return typeof value === 'string' ? value : '';
    };
    const { runs } = parse(action) as { runs: { steps: WorkflowStep[] } };

    const locate = runs.steps.find((step) => (step.run ?? '').includes('pnpm store path'));
    if (locate?.id === undefined) {
      return `the ${fleet} action's pnpm store path reaches no later step`;
    }

    const output = `steps.${locate.id}.outputs.`;
    const cache = runs.steps.find((step) => input(step, 'path').includes(output));
    if (cache === undefined) {
      return `the ${fleet} action caches nothing over its pnpm store path`;
    }

    if (!input(cache, 'key').includes("hashFiles('pnpm-lock.yaml')")) {
      return `the ${fleet} action's store cache is not keyed on the lockfile`;
    }

    return input(cache, 'restore-keys').trim() === ''
      ? `the ${fleet} action's store cache has nothing to fall back on`
      : '';
  };

  const fleets = setupCi.runs.steps.map((step) =>
    (step.uses ?? '').replace('./.github/actions/', '')
  );
  const fleetAction = (fleet: string): string =>
    readFileSync(path.join(ACTIONS, fleet, 'action.yml'), 'utf8');

  const withoutKey = (inputs: Record<string, unknown>, drop: string): Record<string, unknown> =>
    Object.fromEntries(Object.entries(inputs).filter(([key]) => key !== drop));

  /** One fleet action's YAML, its steps put through `mutate` on the way out. */
  const reshaped = (mutate: (steps: WorkflowStep[]) => WorkflowStep[]): string => {
    const [fleet] = fleets;
    if (fleet === undefined) throw new Error('the phase-aware action delegates to no fleet');
    const action = parse(fleetAction(fleet)) as { runs: { steps: WorkflowStep[] } };

    return stringify({ ...action, runs: { ...action.runs, steps: mutate(action.runs.steps) } });
  };

  it('caches the pnpm store on every fleet, keyed on the lockfile', () => {
    expect(fleets, 'the phase-aware action delegates to no fleet').not.toEqual([]);

    for (const fleet of fleets) {
      expect(storeCacheFault(fleet, fleetAction(fleet))).toBe('');
    }
  });

  it('reports a fleet that caches nothing over its store path', () => {
    const uncached = reshaped((steps) => steps.filter((step) => step.with?.['path'] === undefined));

    expect(storeCacheFault('example', uncached)).toBe(
      'the example action caches nothing over its pnpm store path'
    );
  });

  it('reports a fleet whose store cache stopped keying on the lockfile', () => {
    const unkeyed = reshaped((steps) =>
      steps.map((step) =>
        step.with?.['key'] === undefined
          ? step
          : { ...step, with: { ...step.with, key: 'pnpm-store' } }
      )
    );

    expect(storeCacheFault('example', unkeyed)).toBe(
      "the example action's store cache is not keyed on the lockfile"
    );
  });

  it('reports a fleet whose store cache declares no fallback', () => {
    const stranded = reshaped((steps) =>
      steps.map((step) =>
        step.with?.['restore-keys'] === undefined
          ? step
          : { ...step, with: withoutKey(step.with, 'restore-keys') }
      )
    );

    expect(storeCacheFault('example', stranded)).toBe(
      "the example action's store cache has nothing to fall back on"
    );
  });

  it('reports a fleet whose fallback was emptied rather than removed', () => {
    const blank = reshaped((steps) =>
      steps.map((step) =>
        step.with?.['restore-keys'] === undefined
          ? step
          : { ...step, with: { ...step.with, 'restore-keys': '' } }
      )
    );

    expect(storeCacheFault('example', blank)).toBe(
      "the example action's store cache has nothing to fall back on"
    );
  });

  it('reads no particular fallback prefix, only that there is one', () => {
    const renamed = reshaped((steps) =>
      steps.map((step) =>
        step.with?.['restore-keys'] === undefined
          ? step
          : { ...step, with: { ...step.with, 'restore-keys': 'some-other-prefix-' } }
      )
    );

    expect(storeCacheFault('example', renamed)).toBe('');
  });

  it('reads neither the step names nor the pinned refs it is spelled beside', () => {
    const reworded = reshaped((steps) =>
      steps.map((step) => ({
        ...step,
        ...(step.name === undefined ? {} : { name: `Renamed ${step.name}` }),
        ...(step.uses === undefined ? {} : { uses: step.uses.replace(/@\S+/, '@bumped') }),
      }))
    );

    expect(storeCacheFault('example', reworded)).toBe('');
  });
});

/**
 * Opening the untrusted trigger to forks created a collision class the group
 * expression predates: two contributors whose fork branches happen to share a
 * name would cancel each other's runs. The pull-request number is unique in the
 * base repository, and is empty on the trusted events, which keep the run id.
 */
describe('the concurrency group', () => {
  it('separates two fork branches that share a name', () => {
    expect(ci.concurrency?.group).toContain('github.event.pull_request.number');
  });

  it('never keys on the bare head-branch name', () => {
    expect(ci.concurrency?.group).not.toContain('head_ref');
  });

  it('keeps a per-run group for the trusted events, which carry no pull request', () => {
    expect(ci.concurrency?.group).toContain('github.run_id');
  });
});

/**
 * Every Worker secret is published from one site, inside the upload that ships
 * the code, so no coupled pair — a keypair, a URL and its token, the version and
 * its bundle checksums — can straddle two Worker versions, and no version or
 * checksum goes live on code that does not serve it. A second site, a separate
 * secret command before the deploy, or a second API deploy step reopens exactly
 * that window, and nothing but these counts would notice.
 */
describe('the Worker secret publish', () => {
  const PUBLISH_LINE = String.raw`printf '%s\n' "$secrets_json" | pnpm exec wrangler deploy --secrets-file /dev/stdin --tag "v$VERSION" --message "$GITHUB_SHA"`;
  const PUBLISH_COMMAND = [
    'secrets_json="$(pnpm -w exec tsx scripts/encode-deploy-secrets.ts)"',
    PUBLISH_LINE,
  ].join('\n');
  const workflowFiles = readdirSync(WORKFLOWS).filter((file) => file.endsWith('.yml'));
  const publishSites = (command: string): string[] =>
    workflowFiles.flatMap((file) =>
      readFileSync(path.join(WORKFLOWS, file), 'utf8')
        .split('\n')
        .map((line, index) => ({ line, index }))
        .filter(({ line }) => line.includes(command))
        .map(({ index }) => `${file}:${String(index + 1)}`)
    );
  const apiDeploySteps = workflowFiles.flatMap((file) =>
    Object.entries(load(file).jobs).flatMap(([job, { steps }]) =>
      (steps ?? [])
        .filter(
          (step) =>
            step['working-directory'] === 'apps/api' && (step.run ?? '').includes('wrangler deploy')
        )
        .map((step) => ({ file, job, step }))
    )
  );
  const deploySteps = ci.jobs['deploy']?.steps ?? [];
  const position = (name: string): number => deploySteps.findIndex((step) => step.name === name);

  it("happens at exactly one site, the encoder's captured output piped into the API deploy", () => {
    const sites = publishSites('--secrets-file');

    expect(sites).toHaveLength(1);
    expect(sites).toEqual(publishSites(PUBLISH_LINE));
  });

  it('never happens through a secret or version command, which would be a second site', () => {
    expect([
      ...publishSites('wrangler secret bulk'),
      ...publishSites('wrangler secret put'),
      ...publishSites('wrangler versions'),
    ]).toEqual([]);
  });

  it('is the only step that deploys the API, so code and secrets ship in one upload', () => {
    expect(
      apiDeploySteps.map(({ file, job, step }) => `${file}:${job}:${String(step.name)}`)
    ).toEqual(['ci.yml:deploy:Deploy API to Workers']);
    expect(apiDeploySteps[0]?.step.run).toContain(PUBLISH_COMMAND);
  });

  /**
   * A pipe starts both of its ends at once, so an encoder piped straight into
   * wrangler lets wrangler deploy with an empty secrets file when the encoder
   * refuses. Capturing the output first, as a standalone assignment under
   * `set -e`, ends the step on a refusal before any wrangler line runs —
   * `local` or `export` in front of it would report their own status instead.
   * Read from the step's own commands, since the runner runs no other text.
   */
  const deployLines = (apiDeploySteps[0]?.step.run ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));
  const CAPTURE = /^(\w+)="\$\(pnpm -w exec tsx scripts\/encode-deploy-secrets\.ts\)"$/;
  const capture = deployLines.findIndex((line) => CAPTURE.test(line));
  const captured = CAPTURE.exec(deployLines[capture] ?? '')?.[1] ?? '';
  const wranglerLines = deployLines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.includes('wrangler'));

  it('runs every command under set -e, so a failed capture ends the step', () => {
    expect(deployLines[0]).toMatch(/^set -[a-z]*e[a-z]*(?: |$)/);
  });

  it("takes the encoder's output into a variable before wrangler starts, so an encoder refusal uploads nothing", () => {
    expect(capture).toBeGreaterThan(0);
    expect(wranglerLines).not.toEqual([]);
    for (const { index } of wranglerLines) expect(index).toBeGreaterThan(capture);
  });

  it('hands wrangler the captured output through the printf builtin alone', () => {
    for (const { line } of wranglerLines) {
      const [feed, ...rest] = line.split(' | ');
      expect(feed).toBe(String.raw`printf '%s\n' "$${captured}"`);
      expect(rest).toEqual([expect.stringMatching(/^pnpm exec wrangler deploy /)]);
    }
  });

  it('binds the token, the version and the generated secret set, and nothing else', () => {
    const byName = (left: string, right: string): number => left.localeCompare(right);

    expect(Object.keys(apiDeploySteps[0]?.step.env ?? {}).toSorted(byName)).toEqual(
      ['CLOUDFLARE_API_TOKEN', 'VERSION', ...deploySecretKeys()].toSorted(byName)
    );
    expect(apiDeploySteps[0]?.step.env?.['VERSION']).toBe(`\${{ needs.version.outputs.version }}`);
  });

  it('publishes after the bundles it advertises are in R2', () => {
    const deploy = position('Deploy API to Workers');
    const earlier = [
      'Guard against re-publishing an existing OTA bundle',
      'Upload mobile OTA bundles to R2',
    ];

    for (const name of earlier) {
      expect(position(name), name).toBeGreaterThanOrEqual(0);
      expect(position(name), name).toBeLessThan(deploy);
    }
  });

  it('verifies the published secrets after the deploy that publishes them', () => {
    expect(position('Deploy API to Workers')).toBeGreaterThanOrEqual(0);
    expect(position('Verify secrets deployed')).toBeGreaterThan(position('Deploy API to Workers'));
  });
});

/**
 * The OTA checksums are minted when each bundle is zipped, so the deploy can
 * only publish them in the same request as everything else by carrying them
 * from the upload step as outputs. What the post-deploy probe then proves is a
 * different property, and the only one a device depends on: the bundle the
 * download route hands out hashes to the checksum served beside the version.
 * Both sides of that comparison come from the deployment, so an upload that
 * put the wrong bytes under a key fails it — which hashing the runner's own
 * archive against the value recorded from that same archive never could.
 */
describe('the OTA checksum path', () => {
  const deploySteps = ci.jobs['deploy']?.steps ?? [];
  const upload = deploySteps.find((step) => step.name === 'Upload mobile OTA bundles to R2');
  const health = deploySteps.find((step) => (step.name ?? '').startsWith('Verify API health'));
  const apiDeploy = deploySteps.find((step) => step.name === 'Deploy API to Workers');

  /** The platforms a step's `for platform in …` loop walks, in its own order. */
  const loopedPlatforms = (step: WorkflowStep | undefined): string[] =>
    loopedPlatformSets(step?.run ?? '')[0] ?? [];

  it('records each checksum as an output of the upload step under its Worker key', () => {
    expect(upload?.id).toBe('ota');
    expect(upload?.run).toContain(
      'echo "APP_BUNDLE_CHECKSUM_${PLATFORM_KEY}=$CHECKSUM" >> "$GITHUB_OUTPUT"'
    );
  });

  it('binds the API deploy step to those outputs rather than to a GitHub secret', () => {
    for (const platform of ['IOS', 'ANDROID', 'ANDROID_DIRECT']) {
      const key = `APP_BUNDLE_CHECKSUM_${platform}`;
      expect(apiDeploy?.env?.[key]).toBe(`\${{ steps.ota.outputs.${key} }}`);
    }
  });

  it('downloads each bundle over the route a device downloads it over', () => {
    expect(health?.run).toContain('"$API_URL/updates/download/$platform/$VERSION"');
  });

  it('probes every platform the upload step publishes, so none is taken as representative', () => {
    expect(loopedPlatforms(upload)).not.toEqual([]);
    expect(loopedPlatforms(health)).toEqual(loopedPlatforms(upload));
  });

  it('compares the downloaded bytes against the checksum served for that platform', () => {
    expect(health?.run).toContain(
      'body=$(curl -fsS -H "X-HushBox-Platform: $platform" "$API_URL/updates/current")'
    );
    expect(health?.run).toContain('published=$(sha256sum "$bundle" | cut -d\' \' -f1)');
    expect(health?.run).toContain('if [ "$published" != "$checksum" ]; then');
  });

  it('reads the checksum it compares against from the deployment, not from its own job', () => {
    expect(
      Object.values(health?.env ?? {}).filter((value) => String(value).includes('steps.ota'))
    ).toEqual([]);
  });

  it('refuses a served checksum that never arrives rather than matching an empty one', () => {
    expect(health?.run).toContain('[ "$served" = "$VERSION" ] && [ -n "$checksum" ]');
  });
});

/**
 * Every step of the deploy job runs code the repository did not write — the
 * install's lifecycle scripts, wrangler, the model-weight download — so a
 * production secret reaches only the steps whose command reads it. A job-level
 * block would hand the root keys to all of them. The ops-script steps bind what
 * any manifest entry requires: the resolver checks each labelled script's
 * declared secrets against its own environment, and the runners hand that
 * environment to the scripts.
 */
describe('the deploy job secret scope', () => {
  const deploy = ci.jobs['deploy'];
  const deploySteps = deploy?.steps ?? [];
  const OPS_SCRIPT_STEPS = [
    'Resolve ops scripts from PR labels',
    'Run pre-deploy ops scripts',
    'Run post-deploy ops scripts',
  ];

  /**
   * Every production variable a step could be handed out of the Backend and Ops
   * lanes, keyed by its canonical name, valued by the stored secret it reads —
   * none for a literal. The ops-script steps hold a subset of it; no other step
   * may hold any of it beyond what its command reads.
   */
  const runnerSet: ReadonlyMap<string, string | undefined> = new Map(
    Object.entries(envConfig).flatMap(([key, config]): [string, string | undefined][] => {
      const lanes = getDestinations(config as VariableConfig, Mode.Production);
      if (!lanes.includes(Destination.Backend) && !lanes.includes(Destination.Ops)) return [];
      const raw = resolveRaw(config as VariableConfig, Mode.Production);
      return [[key, raw !== undefined && isSecret(raw) ? raw.name : undefined]];
    })
  );
  const required = [
    ...new Set(loadManifest(REPO_ROOT).scripts.flatMap((script) => script.requires_secrets)),
  ];
  const opsSteps = OPS_SCRIPT_STEPS.map((name) => ({
    name,
    env: deploySteps.find((candidate) => candidate.name === name)?.env ?? {},
  }));

  /**
   * The backend keys each other step's command reads, which is all of the
   * ops-script set it may name. Every wrangler call reads the account id; the
   * weights publish signs its probes with the R2 keys; the API deploy binds
   * the secret set it uploads with the code; the migration selects
   * `DATABASE_URL` by `NODE_ENV`; the health probe addresses the production
   * API; the surface probe addresses every surface origin and the Access team
   * its admin redirect must reach.
   */
  const WRANGLER_ACCOUNT = ['CLOUDFLARE_ACCOUNT_ID'];
  const READS: Readonly<Record<string, readonly string[]>> = {
    [ORDER_GUARD_STEP]: WRANGLER_ACCOUNT,
    'Guard against re-publishing an existing OTA bundle': WRANGLER_ACCOUNT,
    'Upload mobile OTA bundles to R2': WRANGLER_ACCOUNT,
    'Publish on-device model artifacts to R2': [
      ...WRANGLER_ACCOUNT,
      'R2_ACCESS_KEY_ID',
      'R2_SECRET_ACCESS_KEY',
    ],
    'Verify secrets deployed': WRANGLER_ACCOUNT,
    'Run database migrations (production)': ['DATABASE_URL', 'NODE_ENV'],
    'Deploy API to Workers': deploySecretKeys(),
    'Deploy Web to Pages': WRANGLER_ACCOUNT,
    'Deploy Admin assets Worker': WRANGLER_ACCOUNT,
    'Deploy Sandbox assets Worker': WRANGLER_ACCOUNT,
    'Verify API health (real host + version/OTA assert)': ['API_URL'],
    [SURFACE_PROBE_STEP]: [
      ...WRANGLER_ACCOUNT,
      'CF_ACCESS_TEAM_DOMAIN',
      ...generatedKeys('deploy-surfaces-env'),
    ],
  };

  it('binds nothing at job level', () => {
    expect(deploy?.env).toBeUndefined();
  });

  it('binds every variable a manifest entry requires on each ops-script step', () => {
    expect(required).not.toEqual([]);
    for (const { name, env } of opsSteps) {
      expect(
        required.filter((key) => env[key] === undefined),
        name
      ).toEqual([]);
    }
  });

  it('binds no Backend or Ops variable a manifest entry does not require on an ops-script step', () => {
    for (const { name, env } of opsSteps) {
      expect(
        Object.keys(env).filter((key) => runnerSet.has(key) && !required.includes(key)),
        name
      ).toEqual([]);
    }
  });

  it('binds no ops-script key on any other step beyond the ones its command reads', () => {
    const excess = deploySteps
      .filter((step) => !OPS_SCRIPT_STEPS.includes(step.name ?? ''))
      .flatMap((step) => {
        const reads = READS[step.name ?? ''] ?? [];
        return Object.keys(step.env ?? {})
          .filter((key) => runnerSet.has(key) && !reads.includes(key))
          .map((key) => `${step.name ?? step.uses ?? '(unnamed)'}: ${key}`);
      });

    expect(excess).toEqual([]);
  });

  /**
   * The secret names an expression reads, in the dotted and the index spelling;
   * GitHub resolves a secret's name without regard to case. The context handed on
   * whole reads every secret, so it stands for all of `every`.
   */
  const secretNames = (value: unknown, every: readonly string[]): string[] => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const names = [...text.matchAll(/secrets(?:\.([\w-]+)|\[\s*'([^']+)'\s*\])/g)].map((match) =>
      (match[1] ?? match[2] ?? '').toUpperCase()
    );
    return /\$\{\{[^}]*(?<![\w.-])secrets\b(?![.[])/.test(text) ? [...names, ...every] : names;
  };
  const opsSecrets = [
    ...new Set([...runnerSet.values()].flatMap((name) => (name === undefined ? [] : [name]))),
  ];

  it('binds no ops-script secret on any other step under a name its command does not read', () => {
    expect(opsSecrets).not.toEqual([]);
    const excess = deploySteps
      .filter((step) => !OPS_SCRIPT_STEPS.includes(step.name ?? ''))
      .flatMap((step) => {
        const allowed = new Set(
          (READS[step.name ?? ''] ?? []).flatMap((key) => runnerSet.get(key) ?? [])
        );
        return Object.entries(step.env ?? {}).flatMap(([key, value]) =>
          secretNames(value, opsSecrets)
            .filter((name) => opsSecrets.includes(name) && !allowed.has(name))
            .map((name) => `${step.name ?? step.uses ?? '(unnamed)'}: ${key} reads ${name}`)
        );
      });

    expect(excess).toEqual([]);
  });

  const health = deploySteps.find((step) => (step.name ?? '').startsWith('Verify API health'));

  it('restricts the health probe to the version plus the API origin', () => {
    expect(
      Object.keys(health?.env ?? {}).toSorted((left, right) => left.localeCompare(right))
    ).toEqual(['API_URL', 'VERSION']);
  });

  it('takes the API origin the health probe reads from the generated verify bindings', () => {
    const rendered = (workflowSections()['deploy-verify-env']?.content ?? '').split('\n');

    expect(rendered).toContain(`API_URL: ${String(health?.env?.['API_URL'])}`);
  });
});

/**
 * The version job feeds the build the client version it bakes, so a build that
 * runs where the job does not is a bundle carrying an empty version string —
 * which the client's own parser refuses at module load. The guard is read as a
 * conjunction rather than as text: a build cannot start anywhere the version
 * job's own conjuncts do not all hold.
 */
describe('the version computation', () => {
  const version = ci.jobs['version'];

  it('runs in the staging repository as well as the public one', () => {
    expect(version?.if).toContain(STAGING_VARIABLE);
    expect(version?.if).toContain(PUBLIC_VARIABLE);
  });

  it('runs in the whole trusted phase, rather than on one branch of it', () => {
    expect(conjuncts(version?.if ?? '')).toContain(TRUSTED_PHASE);
  });

  it('starts wherever the build that consumes its output starts', () => {
    const build = conjuncts(ci.jobs['build']?.if ?? '');

    expect(conjuncts(version?.if ?? '').filter((clause) => !build.includes(clause))).toEqual([]);
  });

  // The version bump reads the labels of the pull requests behind the push, and
  // that lookup throws on any non-OK status rather than falling back — so on the
  // private repository the read is the difference between a version and a failed
  // job. The token's other grant is restated because a job's own permissions
  // replace the workflow's rather than adding to them, and the checkout needs it.
  it('may read the pull requests its bump is computed from', () => {
    expect(version?.permissions).toEqual({ contents: 'read', 'pull-requests': 'read' });
  });

  it('waits for the claim, whose number it hands on', () => {
    expect(dependenciesOf(ci, 'version')).toContain('version-claim');
  });

  it('computes on every event but the deploying one', () => {
    const compute = (version?.steps ?? []).find((step) => step.id === 'compute');

    expect(compute?.if).toBe(OFF_THE_DEPLOYING_EVENT);
  });

  it('claims nothing itself', () => {
    const flagged = (version?.steps ?? []).filter(
      (step) => step.env?.[CLAIM_FLAG] !== undefined || (step.run ?? '').includes(CLAIM_FLAG)
    );

    expect(flagged).toEqual([]);
  });

  it("hands on the claim's outputs where it did not compute its own", () => {
    const handedOn = Object.fromEntries(
      VERSION_OUTPUTS.map((output) => [
        output,
        `\${{ steps.compute.outputs.${output} || needs.version-claim.outputs.${output} }}`,
      ])
    );

    expect(version?.outputs).toMatchObject(handedOn);
  });

  it('keeps the names every consumer reads its outputs under', () => {
    expect(alphabetical(Object.keys(version?.outputs ?? {}))).toEqual(
      alphabetical([
        ...VERSION_OUTPUTS,
        'privacy_policy_effective_date',
        'terms_of_service_effective_date',
      ])
    );
  });
});

/** The steps of a job whose guard leaves out any clause of the deploying event. */
const stepsOffTheDeployingEvent = (job: WorkflowJob | undefined): string[] =>
  (job?.steps ?? [])
    .filter((step) => {
      const clauses = conjuncts(step.if ?? '');
      return !DEPLOYING_EVENT.every((clause) => clauses.includes(clause));
    })
    .map((step) => step.name ?? step.uses ?? step.run ?? '');

/**
 * The claim holds the only write token a merge-queue run could otherwise reach:
 * the version job runs on contributor code in the public merge queue, so the
 * token that pushes a claim lives in a job whose every step is confined to the
 * deploying event. The job itself runs wherever the version job does, so it is
 * a successful need everywhere and the version job needs no status function.
 */
describe('the version claim', () => {
  const claim = ci.jobs['version-claim'];

  it('runs wherever the version job runs, so it is never a skipped need', () => {
    expect(claim?.if).toBeDefined();
    expect(claim?.if).toBe(ci.jobs['version']?.if);
  });

  it('may push a claim and read the pull requests its bump is computed from', () => {
    expect(claim?.permissions).toEqual({ contents: 'write', 'pull-requests': 'read' });
  });

  it('runs every one of its steps on the deploying event alone', () => {
    expect(claim?.steps?.length).toBeGreaterThan(0);
    expect(stepsOffTheDeployingEvent(claim)).toEqual([]);
  });

  it('reports a step left unguarded, so the confinement reading is not vacuous', () => {
    const unguarded: WorkflowStep = { name: 'Unguarded', run: 'true' };
    const planted: WorkflowJob = { ...claim, steps: [...(claim?.steps ?? []), unguarded] };

    expect(stepsOffTheDeployingEvent(planted)).toEqual(['Unguarded']);
  });

  // One group for every deploying run, holding each pending run rather than
  // cancelling the older one, so each claim reads every earlier claim; any other
  // event gets a group of its own and waits for nothing.
  it('queues every deploying run in one group, and gives any other run its own', () => {
    expect(claim?.concurrency).toEqual({
      group: `\${{ ${DEPLOYING_EVENT.join(' && ')} && 'version-claim' || format('version-claim-{0}', github.run_id) }}`,
      'cancel-in-progress': false,
      queue: 'max',
    });
  });

  it('runs the version script flagged to claim', () => {
    const step = (claim?.steps ?? []).find((candidate) =>
      (candidate.run ?? '').includes('scripts/release/compute-next-version.ts')
    );

    expect(step?.env?.[CLAIM_FLAG]).toBe('true');
  });

  it('outputs the version, its name and code, and whether it claimed', () => {
    const claimStep = (claim?.steps ?? []).find((step) => step.env?.[CLAIM_FLAG] !== undefined);
    const expected = Object.fromEntries(
      VERSION_OUTPUTS.map((output) => [
        output,
        `\${{ steps.${claimStep?.id ?? ''}.outputs.${output} }}`,
      ])
    );

    expect(claimStep?.id).toBeDefined();
    expect(claim?.outputs).toEqual(expected);
  });
});

/**
 * A job's effective grant over repository contents: its own block where it
 * declares one, since a job's grant replaces the workflow's, and the
 * workflow's otherwise.
 */
const contentsGrant = (job: WorkflowJob, workflow: Workflow): string | undefined => {
  const grant = job.permissions ?? workflow.permissions;
  return typeof grant === 'string' ? grant.replace(/-all$/, '') : grant?.['contents'];
};

const contentsWriters = (workflow: Workflow): string[] =>
  alphabetical(
    Object.entries(workflow.jobs)
      .filter(([, job]) => contentsGrant(job, workflow) === 'write')
      .map(([name]) => name)
  );

describe('the write token', () => {
  it('is held by exactly the jobs that push a ref: the version claim and the release tag', () => {
    expect(contentsWriters(ci)).toEqual(['deploy', 'version-claim']);
  });

  it('is found on a job granted write-all by its own block', () => {
    const planted: Workflow = {
      ...ci,
      jobs: { ...ci.jobs, lint: { ...ci.jobs['lint'], permissions: 'write-all' } },
    };

    expect(contentsWriters(planted)).toContain('lint');
  });

  it('is found on a job left to a workflow-level write-all', () => {
    const planted: Workflow = { ...ci, permissions: 'write-all' };

    expect(contentsWriters(planted)).toContain('lint');
  });

  it('is not found on a job granted read-all', () => {
    const planted: Workflow = {
      ...ci,
      jobs: { ...ci.jobs, deploy: { ...ci.jobs['deploy'], permissions: 'read-all' } },
    };

    expect(contentsWriters(planted)).not.toContain('deploy');
  });
});

/**
 * Production has no committed environment file, so the build job writes one
 * before anything reads it. The verifier's own step is what fixes the order:
 * it reads that file, and read it before anything wrote it for as long as the
 * two steps have stood beside each other.
 *
 * A job that writes that file also has to state the mode to the steps that read
 * it, in its own env block: a step is a process of its own, so nothing a
 * previous step's command line named survives into the next one. That
 * declaration is asserted here rather than in `scripts/root-chain-stacks.test.ts`
 * beside it, which compares the stack a job declares against the stack it
 * generates: production resolves the same stack an absent declaration answers,
 * so no comparison over stacks can fail for a production declaration taken away.
 */
describe('the production environment file', () => {
  const buildSteps = ci.jobs['build']?.steps ?? [];
  const indexOfRun = (fragment: string): number =>
    buildSteps.findIndex((step) => (step.run ?? '').includes(fragment));

  /** One job of one workflow file, named the way a failure has to name it. */
  interface NamedJob {
    readonly file: string;
    readonly name: string;
    readonly job: WorkflowJob;
  }

  /** Every job, in every workflow, whose steps write the production file. */
  const productionBuildJobs = (): NamedJob[] =>
    readdirSync(WORKFLOWS)
      .filter((file) => file.endsWith('.yml'))
      .flatMap((file) =>
        Object.entries(load(file).jobs).map(([name, job]) => ({ file, name, job }))
      )
      .filter(({ job }) =>
        (job.steps ?? []).some((step) => (step.run ?? '').includes(PRODUCTION_GENERATION))
      );

  const withoutTheMode = (env: Record<string, unknown> | undefined): Record<string, unknown> =>
    Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => key !== ENV_MODE_VARIABLE));

  const jobsLeavingTheModeUnstated = (jobs: readonly NamedJob[]): string[] =>
    jobs
      .filter(({ job }) => job.env?.[ENV_MODE_VARIABLE] !== Mode.Production)
      .map(({ file, name }) => `${file} ${name}`);

  it('is generated by the build job', () => {
    expect(indexOfRun('generate:env --mode=production')).toBeGreaterThanOrEqual(0);
  });

  // Both halves are named in the expectation rather than compared as indices:
  // an ordering assertion over a step that is not there passes for the one
  // reason it exists to catch.
  it('is generated before it is verified', () => {
    const touching = buildSteps
      .map((step) => step.run ?? '')
      .filter((run) => /pnpm (?:generate|verify):env --mode=production/.test(run));

    expect(touching.map((run) => run.split(' ')[1])).toEqual(['generate:env', 'verify:env']);
  });

  it('is declared at job level by every job that writes it', () => {
    expect(jobsLeavingTheModeUnstated(productionBuildJobs())).toEqual([]);
  });

  it('reports each of those jobs when its declaration is taken away', () => {
    const jobs = productionBuildJobs();
    const stripped = jobs.map((named) => ({
      ...named,
      job: { ...named.job, env: withoutTheMode(named.job.env) },
    }));

    expect(jobs.length).toBeGreaterThan(0);
    expect(jobsLeavingTheModeUnstated(stripped)).toEqual(
      jobs.map(({ file, name }) => `${file} ${name}`)
    );
  });

  it('takes the version from the job that computes it', () => {
    const generate = buildSteps[indexOfRun('generate:env --mode=production')];

    expect(generate?.env?.['VITE_APP_VERSION']).toBe('${{ needs.version.outputs.version }}');
  });
});

/** Every step written in any workflow. */
const everyStep = (): WorkflowStep[] =>
  readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .flatMap((file) => Object.values(load(file).jobs).flatMap((job) => job.steps ?? []));

const workflowTexts = (): [string, string][] =>
  readdirSync(WORKFLOWS)
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [file, readFileSync(path.join(WORKFLOWS, file), 'utf8')]);

/**
 * A `hookdeck` command word: the name at the start of a command, not a path or
 * file that carries it, and not the capitalized product name in a message.
 */
const HOOKDECK_COMMAND = /(^|[\s;&|(])((?:pnpm exec )?)hookdeck(?=\s)/gm;

/** The packages one global npm install names, read off each line that runs one. */
const GLOBAL_INSTALL = /\bnpm install -g((?:[ \t]+[^\s-]\S*)+)/g;

/** A package spec naming one exact release, scoped or not. */
const EXACT_SPEC = /^(?:@[^/\s]+\/)?[^@\s]+@\d+\.\d+\.\d+$/;

/**
 * Every package a workflow installs globally without an exact version. A global
 * install is outside the lockfile, so its version is whatever the spec says and
 * nothing else; a spec with no exact release installs whatever was published last.
 */
const unpinnedGlobalInstalls = (texts: readonly [string, string][]): string[] =>
  texts.flatMap(([file, text]) =>
    [...text.matchAll(GLOBAL_INSTALL)].flatMap((match) =>
      (match[1] ?? '')
        .trim()
        .split(/\s+/)
        .filter((spec) => !EXACT_SPEC.test(spec))
        .map((spec) => `${file}: ${spec}`)
    )
  );

describe('the tools the workflows install', () => {
  it('reads a global install with no version as unpinned', () => {
    expect(unpinnedGlobalInstalls([['sample.yml', 'npm install -g hookdeck-cli']])).toEqual([
      'sample.yml: hookdeck-cli',
    ]);
  });

  it('reads only the line the install is written on', () => {
    expect(
      unpinnedGlobalInstalls([['sample.yml', 'npm install -g tool@1.2.3\ntool version']])
    ).toEqual([]);
  });

  it('reads a scoped global install at an exact release as pinned', () => {
    expect(unpinnedGlobalInstalls([['sample.yml', 'npm install -g @scope/tool@1.2.3']])).toEqual(
      []
    );
  });

  it('installs no npm package globally without an exact version', () => {
    expect(unpinnedGlobalInstalls(workflowTexts())).toEqual([]);
  });

  const webhookLaneHookdeckPrefixes = (): string[] =>
    everyStep()
      .filter((step) => step.if === 'matrix.webhookLane')
      .flatMap((step) =>
        [...(step.run ?? '').matchAll(HOOKDECK_COMMAND)].map((match) => match[2] ?? '')
      );

  it('runs Hookdeck in the webhook lane, so the prefix reading is not vacuous', () => {
    expect(webhookLaneHookdeckPrefixes().length).toBeGreaterThan(0);
  });

  it('runs every webhook-lane Hookdeck command through pnpm exec hookdeck', () => {
    expect(webhookLaneHookdeckPrefixes().filter((prefix) => prefix === '')).toEqual([]);
  });
});

const GITHUB_DIRECTORY = path.join(REPO_ROOT, '.github');

/** Every YAML file under `.github/`: the workflows, the composite actions, and the repository config. */
const githubYamlTexts = (): [string, string][] =>
  readdirSync(GITHUB_DIRECTORY, { recursive: true, encoding: 'utf8' })
    .filter((file) => /\.ya?ml$/.test(file))
    .map((file) => [file, readFileSync(path.join(GITHUB_DIRECTORY, file), 'utf8')]);

/** The `uses:` references to one action, read off every line that names it. */
const actionReferences = (texts: readonly [string, string][], action: string): string[] =>
  texts.flatMap(([file, text]) =>
    [...text.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)]
      .map((match) => match[1] ?? '')
      .filter((reference) => reference.split('@')[0] === action)
      .map((reference) => `${file}: ${reference}`)
  );

/**
 * The upstream cache action at the pin the fleet setup action carries, which
 * the setup action's own comment says it uses instead of the archived fork.
 */
const upstreamCachePin = (): string => {
  const setup = readFileSync(
    path.join(GITHUB_DIRECTORY, 'actions', 'setup-blacksmith', 'action.yml'),
    'utf8'
  );
  const pins = actionReferences([['setup', setup]], 'actions/cache');
  expect(pins).toHaveLength(1);
  return (pins[0] ?? '').replace(/^setup: /, '');
};

describe('the cache action', () => {
  it('reads a step naming the archived fork as a reference to it', () => {
    expect(
      actionReferences(
        [['sample.yml', '      - name: Cache\n        uses: useblacksmith/cache@abc # v5\n']],
        'useblacksmith/cache'
      )
    ).toEqual(['sample.yml: useblacksmith/cache@abc']);
  });

  it('is never the archived useblacksmith fork anywhere under .github', () => {
    expect(
      githubYamlTexts()
        .filter(([, text]) => text.includes('useblacksmith/cache'))
        .map(([file]) => file)
    ).toEqual([]);
  });

  it('is the upstream action at the setup action pin in every step that caches whole', () => {
    const pin = upstreamCachePin();
    const texts = githubYamlTexts();

    expect(
      [
        ...actionReferences(texts, 'actions/cache'),
        ...actionReferences(texts, 'useblacksmith/cache'),
      ].filter((reference) => !reference.endsWith(`: ${pin}`))
    ).toEqual([]);
  });
});

/** The keys of every cache step in the CI workflow that saves `cachePath`. */
const cacheKeysFor = (cachePath: string): unknown[] =>
  stepsOf(ci)
    .filter((step) => step.uses?.startsWith('actions/cache@') && step.with?.['path'] === cachePath)
    .map((step) => step.with?.['key']);

describe('the pinned mobile toolchain caches', () => {
  it('keys the Maestro install by the pinned Maestro version', () => {
    expect(cacheKeysFor('~/.maestro')).toEqual([`maestro-cli-${MAESTRO_VERSION}`]);
  });

  it('keys the Android SDK by the pinned command-line tools build', () => {
    expect(cacheKeysFor('~/Android/Sdk')).toEqual([
      expect.stringMatching(new RegExp(`-cmdtools-${CMDLINE_TOOLS_BUILD}$`)),
    ]);
  });
});

const release = load('release.yml');
const RESOLVING_JOB = 'prepare-version';
const TAGGED_COMMIT_OUTPUT = 'commit';
const NATIVE_BUILD = /^\.\/\.github\/workflows\/build-(?:android|ios)\.yml$/;
const CI_GATE_STEP = 'Require a green CI run for the tagged commit';

/** The release jobs that call a native store build. */
const nativeBuildJobs = (): [string, WorkflowJob][] =>
  Object.entries(release.jobs).filter(([, job]) => NATIVE_BUILD.test(job.uses ?? ''));

/** The `workflow_call` inputs a reusable workflow declares. */
const callInputs = (workflow: Workflow): Record<string, Record<string, unknown>> =>
  (workflow.on as { workflow_call?: { inputs?: Record<string, Record<string, unknown>> } })
    .workflow_call?.inputs ?? {};

const resolvingSteps = (): WorkflowStep[] => release.jobs[RESOLVING_JOB]?.steps ?? [];

const ciGate = (): WorkflowStep | undefined =>
  resolvingSteps().find((step) => step.name === CI_GATE_STEP);

describe('the native release', () => {
  it('calls at least one native build, so the readings below are not vacuous', () => {
    expect(nativeBuildJobs().length).toBeGreaterThan(0);
  });

  it('resolves the commit the newest release tag points at', () => {
    const tagStep = resolvingSteps().find((step) => step.id === 'tag');

    expect(tagStep?.run).toContain('COMMIT=$(git rev-list -n 1 "$TAG")');
    expect(tagStep?.run).toContain(`${TAGGED_COMMIT_OUTPUT}=$COMMIT`);
    expect(release.jobs[RESOLVING_JOB]?.outputs?.[TAGGED_COMMIT_OUTPUT]).toBe(
      `\${{ steps.tag.outputs.${TAGGED_COMMIT_OUTPUT} }}`
    );
  });

  it('hands every native build the tagged commit as the ref to build', () => {
    expect(
      nativeBuildJobs()
        .filter(
          ([, job]) =>
            job.with?.['ref'] !== `\${{ needs.${RESOLVING_JOB}.outputs.${TAGGED_COMMIT_OUTPUT} }}`
        )
        .map(([name]) => name)
    ).toEqual([]);
  });

  it.each(['build-android.yml', 'build-ios.yml'])('%s requires the ref it builds', (file) => {
    expect(callInputs(load(file))['ref']).toMatchObject({ required: true, type: 'string' });
  });

  it.each(['build-android.yml', 'build-ios.yml'])('%s checks out only that ref', (file) => {
    const checkouts = stepsOf(load(file)).filter((step) =>
      step.uses?.startsWith('actions/checkout@')
    );

    expect(checkouts.length).toBeGreaterThan(0);
    expect(checkouts.map((step) => step.with?.['ref'])).toEqual(
      checkouts.map(() => '${{ inputs.ref }}')
    );
  });

  it('starts no native build before the commit is resolved and its CI is checked', () => {
    expect(
      nativeBuildJobs()
        .filter(([name]) => !transitiveNeeds(release, name).includes(RESOLVING_JOB))
        .map(([name]) => name)
    ).toEqual([]);
  });

  it('refuses the release unless the CI gate runs unconditionally', () => {
    const gate = ciGate();

    expect(gate).toBeDefined();
    expect(gate?.if).toBeUndefined();
    expect(gate).not.toHaveProperty('continue-on-error');
  });

  it('runs the gate script, so its exit status is the step result', () => {
    expect(ciGate()?.run).toBe('pnpm tsx scripts/release/release-ci-gate.ts');
  });

  it('hands the gate the resolved tag and commit and the workflow token', () => {
    expect(ciGate()?.env).toEqual({
      GITHUB_TOKEN: '${{ github.token }}',
      RELEASE_TAG: '${{ steps.tag.outputs.tag }}',
      RELEASE_COMMIT: `\${{ steps.tag.outputs.${TAGGED_COMMIT_OUTPUT} }}`,
    });
  });

  /** Where in the resolving job the tagged commit is checked out, or -1. */
  const taggedCheckoutIndex = (): number =>
    resolvingSteps().findIndex(
      (step) =>
        step.uses?.startsWith('actions/checkout@') === true &&
        step.with?.['ref'] === `\${{ steps.tag.outputs.${TAGGED_COMMIT_OUTPUT} }}`
    );

  it('checks out the tagged commit with its full history and tags', () => {
    expect(resolvingSteps()[taggedCheckoutIndex()]?.with?.['fetch-depth']).toBe(0);
  });

  it('checks out nothing else after the tagged commit', () => {
    expect(
      resolvingSteps()
        .slice(taggedCheckoutIndex() + 1)
        .filter((step) => step.uses?.startsWith('actions/checkout@'))
    ).toEqual([]);
  });

  it.each([
    ['installs the toolchain', (step: WorkflowStep) => step.uses === './.github/actions/setup'],
    ['gates on CI', (step: WorkflowStep) => step.name === CI_GATE_STEP],
    [
      'extracts the version',
      (step: WorkflowStep) => step.run?.includes('scripts/extract-version.ts') === true,
    ],
    [
      'derives the legal effective dates',
      (step: WorkflowStep) => step.run?.includes('scripts/legal-effective-dates.ts') === true,
    ],
  ])('%s from the tagged commit', (_label, isStep) => {
    const checkout = taggedCheckoutIndex();
    const index = resolvingSteps().findIndex((step) => isStep(step));

    expect(checkout).toBeGreaterThan(resolvingSteps().findIndex((step) => step.id === 'tag'));
    expect(index).toBeGreaterThan(checkout);
  });

  it('grants the token the read of Actions runs the gate makes', () => {
    expect(release.jobs[RESOLVING_JOB]?.permissions).toMatchObject({ actions: 'read' });
  });
});
