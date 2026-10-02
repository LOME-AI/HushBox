/**
 * What is true of the workflows that hold the sync bot credential, beyond the
 * repository guard every guarded workflow shares.
 *
 * Whether each file admits only its own repository is asserted once, over the
 * one guarded-workflow table, in that table's suite — a second list of the same
 * shape does not fail when the two disagree. Where a job condition asserted here
 * contains the guard, the expected text is built from that table's module rather
 * than restated.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { APP_ID_VARIABLE, PRIVATE_KEY_VARIABLE } from './lib/publication/sync-bot-credential.js';
import { MAIN } from './lib/publication/git.js';
import {
  CREDENTIAL_WORKFLOWS,
  PUBLIC_REPOSITORY_VARIABLE,
  repositoryTerm,
} from './lib/publication/guarded-workflows.js';
import { DISPATCH_OUTPUT } from './publication/publish-staging-tip.js';

const WORKFLOWS = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '.github',
  'workflows'
);

interface Step {
  readonly id?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
}

interface Job {
  readonly 'runs-on'?: string;
  readonly if?: string;
  readonly needs?: string[];
  readonly permissions?: Record<string, unknown>;
  readonly outputs?: Record<string, unknown>;
  readonly steps?: Step[];
}

interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions?: Record<string, unknown>;
  readonly concurrency?: { readonly 'cancel-in-progress'?: boolean };
  readonly jobs: Record<string, Job>;
}

const source = (file: string): string => readFileSync(path.join(WORKFLOWS, file), 'utf8');
const load = (file: string): Workflow => parse(source(file)) as Workflow;

/**
 * Every job but the credential job that names either sync bot credential
 * anywhere in its body — an env key, a secret reference, a script argument.
 */
const credentialNamedOutside = (
  file: string,
  workflow: Workflow,
  credentialJob: string
): string[] =>
  Object.entries(workflow.jobs)
    .filter(([name]) => name !== credentialJob)
    .filter(([, job]) => {
      const text = JSON.stringify(job);
      return text.includes(APP_ID_VARIABLE) || text.includes(PRIVATE_KEY_VARIABLE);
    })
    .map(([name]) => `${file}:${name}`);

/**
 * The `persist-credentials` input of each checkout in one job, absent where the
 * action's default applies. The default leaves the workflow token in git's
 * config as an `Authorization` header, which takes precedence over the App
 * token a git URL names, so the request would go out as the workflow token.
 */
const checkoutCredentialPersistence = (workflow: Workflow, job: string): unknown[] =>
  (workflow.jobs[job]?.steps ?? [])
    .filter((step) => (step.uses ?? '').startsWith('actions/checkout@'))
    .map((step) => step.with?.['persist-credentials']);

const DISPATCH_TRIGGER = 'workflow_dispatch';
const DISPATCH_COMMAND = /^gh workflow run (\S+)/;

/** The workflow file each `gh workflow run` step of one job starts. */
const dispatchedWorkflows = (workflow: Workflow, job: string): string[] =>
  (workflow.jobs[job]?.steps ?? [])
    .map((step) => DISPATCH_COMMAND.exec(step.run ?? '')?.[1])
    .filter((file): file is string => file !== undefined);

/** The workflows one job dispatches whose triggers do not include a dispatch. */
const undispatchable = (
  workflow: Workflow,
  job: string,
  read: (file: string) => Workflow
): string[] =>
  dispatchedWorkflows(workflow, job).filter(
    (file) => !Object.hasOwn(read(file).on, DISPATCH_TRIGGER)
  );

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
function stepOutputsReaching(
  workflow: Workflow,
  producer: string,
  stepId: string,
  consumer: string
): string[] {
  const exposed = workflow.jobs[producer]?.outputs ?? {};
  return outputsRead(workflow.jobs[consumer]?.if ?? '', `needs.${producer}`).flatMap((name) => {
    const value = exposed[name];
    return outputsRead(typeof value === 'string' ? value : '', `steps.${stepId}`);
  });
}

describe('the sync workflows', () => {
  it('asks the workflow token for no write of its own', () => {
    for (const { file } of CREDENTIAL_WORKFLOWS) {
      expect({ file, permissions: load(file).permissions }).toEqual({
        file,
        permissions: { contents: 'read' },
      });
    }
  });

  it('keeps the bot credential inside the credential job on every step that names it', () => {
    for (const { file, credentialJob, credentialStep } of CREDENTIAL_WORKFLOWS) {
      const job = load(file).jobs[credentialJob];
      // Read against the names the credential module exports rather than a
      // prefix: a misspelled variable is exactly what a prefix admits. Each
      // step's own identity rides in the tuple because placement is half the
      // property — the dependency install runs third-party lifecycle scripts,
      // so the credential moving onto that step has to fail here.
      const naming = (job?.steps ?? [])
        .filter((step) => Object.keys(step.env ?? {}).length > 0)
        .map((step) => ({
          step: step.run ?? step.uses ?? '',
          keys: Object.keys(step.env ?? {}),
        }));

      expect({ job: `${file}:${credentialJob}`, guarded: (job?.if ?? '') !== '' }).toEqual({
        job: `${file}:${credentialJob}`,
        guarded: true,
      });
      expect({ job: `${file}:${credentialJob}`, naming }).toEqual({
        job: `${file}:${credentialJob}`,
        naming: [{ step: credentialStep, keys: [APP_ID_VARIABLE, PRIVATE_KEY_VARIABLE] }],
      });
    }
  });

  it('checks out the trunk in the credential job rather than the ref the run was dispatched from', () => {
    for (const { file, credentialJob } of CREDENTIAL_WORKFLOWS) {
      const references = (load(file).jobs[credentialJob]?.steps ?? [])
        .filter((step) => (step.uses ?? '').startsWith('actions/checkout@'))
        .map((step) => step.with?.['ref']);

      expect({ job: `${file}:${credentialJob}`, references }).toEqual({
        job: `${file}:${credentialJob}`,
        references: [MAIN],
      });
    }
  });

  it('leaves the workflow token out of git in the credential job, so its git requests carry the App token alone', () => {
    for (const { file, credentialJob } of CREDENTIAL_WORKFLOWS) {
      expect({
        job: `${file}:${credentialJob}`,
        persisted: checkoutCredentialPersistence(load(file), credentialJob),
      }).toEqual({ job: `${file}:${credentialJob}`, persisted: [false] });
    }
  });

  it('runs the credential job on a GitHub-hosted runner', () => {
    // The App's private key is company-ending if it leaks, so it stays off the
    // third-party runner fleet: a breach there reaches only the restricted `ci` secrets.
    for (const { file, credentialJob } of CREDENTIAL_WORKFLOWS) {
      expect({
        job: `${file}:${credentialJob}`,
        runner: load(file).jobs[credentialJob]?.['runs-on'],
      }).toEqual({ job: `${file}:${credentialJob}`, runner: 'ubuntu-latest' });
    }
  });

  it('names the bot credential in no job but the credential job', () => {
    for (const { file, credentialJob } of CREDENTIAL_WORKFLOWS) {
      expect(credentialNamedOutside(file, load(file), credentialJob)).toEqual([]);
    }
  });

  it.each([APP_ID_VARIABLE, PRIVATE_KEY_VARIABLE])('reports a second job that binds %s', (name) => {
    const [row] = CREDENTIAL_WORKFLOWS;
    if (row === undefined) throw new Error('the table holds no credential workflow');
    const copy = load(row.file);
    const control: Workflow = {
      ...copy,
      jobs: {
        ...copy.jobs,
        second: { steps: [{ run: 'true', env: { [name]: `secrets.${name}` } }] },
      },
    };

    expect(credentialNamedOutside(row.file, control, row.credentialJob)).toEqual([
      `${row.file}:second`,
    ]);
  });

  it('never lets a run be cancelled out from under a push it has already started', () => {
    for (const { file } of CREDENTIAL_WORKFLOWS) {
      expect({ file, cancel: load(file).concurrency?.['cancel-in-progress'] }).toEqual({
        file,
        cancel: false,
      });
    }
  });
});

describe('what fires each sync workflow', () => {
  it('runs the outbound mirror on a schedule and on demand', () => {
    expect(
      Object.keys(load('publish-mirror.yml').on).toSorted((left, right) =>
        left.localeCompare(right)
      )
    ).toEqual(['schedule', 'workflow_dispatch']);
  });

  it('runs the inbound sync on a push to the branch the queue merges into', () => {
    const on = load('sync-inbound.yml').on as {
      push: { branches: string[] };
    };

    expect(Object.keys(on).toSorted((left, right) => left.localeCompare(right))).toEqual([
      'push',
      'workflow_dispatch',
    ]);
    expect(on.push.branches).toEqual([MAIN]);
  });

  it('runs the auditor on a schedule of its own, more often than the mirror it watches', () => {
    const auditor = load('sync-auditor.yml').on as { schedule: { cron: string }[] };
    const mirror = load('publish-mirror.yml').on as { schedule: { cron: string }[] };

    expect(auditor.schedule).toHaveLength(1);
    expect(auditor.schedule[0]?.cron).not.toBe(mirror.schedule[0]?.cron);
  });
});

describe('the Deploy now button', () => {
  const DEPLOY_NOW = 'deploy-now.yml';
  const ON_PUBLIC_MAIN = `${repositoryTerm(PUBLIC_REPOSITORY_VARIABLE)} && github.ref == 'refs/heads/main'`;
  const jobOf = (name: string): Job | undefined => load(DEPLOY_NOW).jobs[name];
  const publishStepId = (): string => {
    const credentialStep = CREDENTIAL_WORKFLOWS.find(
      ({ file }) => file === DEPLOY_NOW
    )?.credentialStep;
    return jobOf('publish')?.steps?.find((step) => step.run === credentialStep)?.id ?? '';
  };

  it('holds the bot credential in the publish job alone, so every credential assertion reads it', () => {
    expect(
      CREDENTIAL_WORKFLOWS.filter(({ file }) => file === DEPLOY_NOW).map(
        ({ credentialJob }) => credentialJob
      )
    ).toEqual(['publish']);
  });

  it('starts only when someone presses it', () => {
    expect(Object.keys(load(DEPLOY_NOW).on)).toEqual(['workflow_dispatch']);
  });

  it('asks which main to deploy, public unless told otherwise', () => {
    const on = load(DEPLOY_NOW).on as {
      workflow_dispatch: { inputs: Record<string, Record<string, unknown>> };
    };

    expect(on.workflow_dispatch.inputs).toEqual({
      source: expect.objectContaining({
        type: 'choice',
        required: true,
        options: ['public', 'staging'],
        default: 'public',
      }) as unknown,
    });
  });

  it('publishes only from public main, and only when staging is the source', () => {
    expect(jobOf('publish')?.if).toBe(`${ON_PUBLIC_MAIN} && inputs.source == 'staging'`);
  });

  it("hands the publisher's answer on as the job's output", () => {
    const credentialStep = CREDENTIAL_WORKFLOWS.find(
      ({ file }) => file === DEPLOY_NOW
    )?.credentialStep;
    const step = jobOf('publish')?.steps?.find((candidate) => candidate.run === credentialStep);

    expect(step?.id).toBeDefined();
    expect(jobOf('publish')?.outputs).toEqual({
      dispatch: `\${{ steps.${step?.id ?? ''}.outputs.dispatch }}`,
    });
  });

  it("carries the publisher's answer to the dispatch under the key the publisher writes", () => {
    const deployNow = load(DEPLOY_NOW);

    expect(stepOutputsReaching(deployNow, 'publish', publishStepId(), 'dispatch')).toEqual([
      DISPATCH_OUTPUT,
    ]);
  });

  it('reports a publish step output the dispatch no longer reaches under that key', () => {
    const deployNow = load(DEPLOY_NOW);
    const publish = deployNow.jobs['publish'];
    const renamed = Object.fromEntries(
      Object.entries(publish?.outputs ?? {}).map(([name, value]) => [
        name,
        typeof value === 'string'
          ? value.replace(`.outputs.${DISPATCH_OUTPUT}`, '.outputs.renamed')
          : value,
      ])
    );
    const control: Workflow = {
      ...deployNow,
      jobs: { ...deployNow.jobs, publish: { ...publish, outputs: renamed } },
    };

    expect(stepOutputsReaching(control, 'publish', publishStepId(), 'dispatch')).toEqual([
      'renamed',
    ]);
  });

  it('dispatches a workflow whose triggers include a dispatch', () => {
    const deployNow = load(DEPLOY_NOW);

    expect(dispatchedWorkflows(deployNow, 'dispatch')).toHaveLength(1);
    expect(undispatchable(deployNow, 'dispatch', load)).toEqual([]);
  });

  it('reports a dispatched workflow that has lost its dispatch trigger', () => {
    const deployNow = load(DEPLOY_NOW);
    const withoutTrigger = (file: string): Workflow => {
      const workflow = load(file);
      return {
        ...workflow,
        on: Object.fromEntries(
          Object.entries(workflow.on).filter(([event]) => event !== DISPATCH_TRIGGER)
        ),
      };
    };

    expect(undispatchable(deployNow, 'dispatch', withoutTrigger)).toEqual(
      dispatchedWorkflows(deployNow, 'dispatch')
    );
  });

  it('dispatches after the publish', () => {
    expect(jobOf('dispatch')?.needs).toEqual(['publish']);
  });

  it('dispatches when the publish succeeded or was skipped, unless it answered that the push run deploys', () => {
    expect(jobOf('dispatch')?.if).toBe(
      `!cancelled() && ${ON_PUBLIC_MAIN} && ` +
        "(needs.publish.result == 'success' || needs.publish.result == 'skipped') && " +
        "needs.publish.outputs.dispatch != 'false'"
    );
  });

  it('grants the dispatching job the one permission starting a run needs', () => {
    expect(jobOf('dispatch')?.permissions).toEqual({ actions: 'write' });
  });

  it("starts public main's ci.yml with the workflow token", () => {
    expect(jobOf('dispatch')?.steps?.map((step) => ({ run: step.run, env: step.env }))).toEqual([
      {
        run: 'gh workflow run ci.yml --ref main',
        env: {
          GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}',
          GH_REPO: '${{ github.repository }}',
        },
      },
    ]);
  });
});
