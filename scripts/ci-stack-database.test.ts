/**
 * The database a continuous-integration job migrates into has to exist first.
 *
 * A Postgres cluster is born with the one database the compose file hands it,
 * and every stack but the default resolves another; on a developer's machine
 * the stack bring-up creates the missing one, and on a runner that bring-up
 * returns at its `CI` guard. So a job naming a stack of its own has to create
 * that stack's database in a step of its own, before the first step to open it.
 *
 * The workflow reader here is small and local rather than shared with the
 * stack-chain check beside it: the two ask different questions of the same
 * files, and neither answer is derivable from the other.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { tokensOf } from './lib/root-manifest.js';
import {
  DEFAULT_ENV_MODE,
  DEFAULT_STACK_MODE,
  ENV_MODES,
  ENV_MODE_VARIABLE,
  stackModeFor,
} from './lib/stack/stack-mode.js';
import type { StackMode } from './lib/stack/port-plan.js';
import type { EnvMode } from '@hushbox/shared';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = path.join('.github', 'workflows');

/** The module a job runs to make the database its own stack names exist. */
const GATE_ENTRY = 'scripts/stack-database-ready.ts';

/** The root script a job runs first against that database. */
const MIGRATION_SCRIPT = 'db:migrate';

/** As much of a workflow as this question needs: each job's env block and steps. */
const WorkflowShape = z.object({
  jobs: z
    .record(
      z.string(),
      z.object({
        env: z.record(z.string(), z.unknown()).optional(),
        steps: z.array(z.object({ run: z.string().optional() })).optional(),
      })
    )
    .optional(),
});

type WorkflowJob = NonNullable<z.infer<typeof WorkflowShape>['jobs']>[string];

interface WorkflowJobEntry {
  /** The workflow file the job is written in, relative to the repository root. */
  readonly file: string;
  readonly name: string;
  readonly job: WorkflowJob;
}

function workflowJobs(): WorkflowJobEntry[] {
  const directory = path.join(REPO_ROOT, WORKFLOWS_DIR);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .flatMap((name) => {
      const parsed: unknown = parseYaml(readFileSync(path.join(directory, name), 'utf8'));
      const jobs = WorkflowShape.parse(parsed).jobs ?? {};
      const file = `${WORKFLOWS_DIR.split(path.sep).join('/')}/${name}`;
      return Object.entries(jobs).map(([jobName, job]) => ({ file, name: jobName, job }));
    });
}

/**
 * The stack a declared value runs, where the value names a mode at all. The
 * selector carries an env mode, so the stack is derived rather than read.
 */
function stackOfDeclaredMode(value: string): StackMode | undefined {
  return (ENV_MODES as readonly string[]).includes(value)
    ? stackModeFor(value as EnvMode)
    : undefined;
}

/**
 * The stacks a job's env block names. A workflow expression resolves to one of
 * its quoted literals on the runner, so every literal naming a mode counts as
 * named — the job runs under whichever the expression picks.
 */
function stacksDeclaredBy(job: WorkflowJob): StackMode[] {
  const declared = job.env?.[ENV_MODE_VARIABLE];
  if (typeof declared !== 'string') return [];
  const named = stackOfDeclaredMode(declared);
  if (named !== undefined) return [named];
  return [...declared.matchAll(/'([^']*)'/g)].flatMap(([, literal]) => {
    const stack = stackOfDeclaredMode(literal ?? '');
    return stack === undefined ? [] : [stack];
  });
}

/** A job that resolves a database the cluster is not born with. */
function namesAStackOfItsOwn(job: WorkflowJob): boolean {
  return stacksDeclaredBy(job).some((stack) => stack !== DEFAULT_STACK_MODE);
}

function firstStep(job: WorkflowJob, matches: (tokens: readonly string[]) => boolean): number {
  return (job.steps ?? []).findIndex((step) => matches(tokensOf(step.run ?? '')));
}

const runsGate = (tokens: readonly string[]): boolean =>
  tokens.some((token) => token.endsWith(GATE_ENTRY));

const runsMigration = (tokens: readonly string[]): boolean =>
  tokens.some((token, index) => token === MIGRATION_SCRIPT && tokens[index - 1] === 'pnpm');

/**
 * What a job gets wrong about the database it migrates into: it opens one
 * nothing on the runner created, or it creates it too late to matter.
 */
function gateDefectsOf(job: WorkflowJob): string[] {
  if (!namesAStackOfItsOwn(job)) return [];
  const migration = firstStep(job, runsMigration);
  if (migration === -1) return [];
  const gate = firstStep(job, runsGate);
  if (gate === -1) return [`runs \`pnpm ${MIGRATION_SCRIPT}\` without ever running ${GATE_ENTRY}`];
  return gate < migration
    ? []
    : [
        `runs ${GATE_ENTRY} only after \`pnpm ${MIGRATION_SCRIPT}\` has already opened the database`,
      ];
}

describe('the database a workflow job migrates into', () => {
  it('still finds every job that names a stack of its own', () => {
    const named = workflowJobs()
      .filter(({ job }) => namesAStackOfItsOwn(job))
      .map(({ file, name }) => `${file} ${name}`);

    expect(
      named,
      'the derivation no longer reads a stack out of these jobs, so the case below asserts over less than it claims'
    ).toEqual(
      expect.arrayContaining([
        '.github/workflows/ci.yml test',
        '.github/workflows/ci.yml e2e',
        '.github/workflows/ci.yml mobile-test',
      ])
    );
  });

  it('exists before the first step that opens it', () => {
    const defects = workflowJobs().flatMap(({ file, name, job }) =>
      gateDefectsOf(job).map((defect) => `${file} ${name} ${defect}`)
    );

    expect(
      defects,
      `these jobs migrate into a database nothing on a runner creates: ${JSON.stringify(defects)}. The stack bring-up returns at its CI guard, so a job naming a stack of its own runs ${GATE_ENTRY} between bringing the containers up and migrating`
    ).toEqual([]);
  });

  it('reports a job that migrates into a stack database it never created', () => {
    const job: WorkflowJob = {
      env: { [ENV_MODE_VARIABLE]: 'e2e' },
      steps: [{ run: 'pnpm db:up' }, { run: 'pnpm db:migrate' }],
    };

    expect(gateDefectsOf(job)).toEqual([
      `runs \`pnpm ${MIGRATION_SCRIPT}\` without ever running ${GATE_ENTRY}`,
    ]);
  });

  it('reports a job that creates it after the migration has already run', () => {
    const job: WorkflowJob = {
      env: { [ENV_MODE_VARIABLE]: 'e2e' },
      steps: [
        { run: 'pnpm db:migrate' },
        { run: `pnpm exec tsx scripts/with-env.ts tsx ${GATE_ENTRY}` },
      ],
    };

    expect(gateDefectsOf(job)).toEqual([
      `runs ${GATE_ENTRY} only after \`pnpm ${MIGRATION_SCRIPT}\` has already opened the database`,
    ]);
  });

  it('reports nothing once the job creates it first', () => {
    const job: WorkflowJob = {
      env: { [ENV_MODE_VARIABLE]: 'e2e' },
      steps: [
        { run: 'pnpm db:up' },
        { run: `pnpm exec tsx scripts/with-env.ts tsx ${GATE_ENTRY}` },
        { run: 'pnpm db:migrate' },
      ],
    };

    expect(gateDefectsOf(job)).toEqual([]);
  });

  it('leaves a job on the stack the cluster is born with alone', () => {
    const job: WorkflowJob = {
      env: { [ENV_MODE_VARIABLE]: DEFAULT_ENV_MODE },
      steps: [{ run: 'pnpm db:migrate' }],
    };

    expect(gateDefectsOf(job)).toEqual([]);
  });
});
