/**
 * The repository-guard invariant, read once over one table, and the shape of
 * that table's rows.
 *
 * Whether each guarded file admits only the repository it belongs to — which a
 * guard can answer, because it tests a shape someone thought of. Whether the
 * table covers the directory at all — which only a reconciliation can answer,
 * because a workflow nobody listed is invisible to every assertion written
 * about the list. And whether a row naming a credential step also names the
 * job holding it, which the row's type answers.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readRepositories } from '../../configure-git-clone.js';
import {
  GUARDED_WORKFLOWS,
  type GuardedWorkflow,
  PUBLIC_REPOSITORY_VARIABLE,
  STAGING_REPOSITORY_VARIABLE,
  UNTABLED_TRIGGERED_WORKFLOWS,
  WORKFLOWS_DIRECTORY,
  admittedRepositories,
  conjuncts,
  triggerEvents,
  triggeredWorkflowFiles,
} from './guarded-workflows.js';

const source = (file: string): string => readFileSync(path.join(WORKFLOWS_DIRECTORY, file), 'utf8');

const jobsOf = (file: string): Record<string, { if?: string } | undefined> =>
  (parse(source(file)) as { jobs: Record<string, { if?: string }> }).jobs;

const byName = (left: string, right: string): number => left.localeCompare(right);

describe('the reconciliation against the workflows directory', () => {
  it('accounts for every workflow file a repository can start on its own', () => {
    const accounted = [
      ...GUARDED_WORKFLOWS.map((workflow) => workflow.file),
      ...UNTABLED_TRIGGERED_WORKFLOWS.map((workflow) => workflow.file),
    ].toSorted(byName);

    expect(triggeredWorkflowFiles(WORKFLOWS_DIRECTORY)).toEqual(accounted);
  });

  it('leaves out a file only another workflow can call, so the reconciliation is not the directory', () => {
    const called = ['build-android.yml', 'build-ios.yml'];

    expect(triggeredWorkflowFiles(WORKFLOWS_DIRECTORY)).not.toEqual(expect.arrayContaining(called));
    for (const file of called) {
      expect({ file, events: triggerEvents((parse(source(file)) as { on: unknown }).on) }).toEqual({
        file,
        events: ['workflow_call'],
      });
    }
  });
});

/**
 * Read against a directory of its own rather than the repository's, so the two
 * shapes the real tree happens not to carry — the other spelling of the
 * extension, and a file that is not a workflow at all — are measured rather
 * than assumed.
 */
describe('triggeredWorkflowFiles', () => {
  let directory = '';

  beforeAll(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'workflow-listing-'));
    writeFileSync(
      path.join(directory, 'scheduled.yaml'),
      'on:\n  schedule:\n    - cron: 0 0 * * *\n'
    );
    writeFileSync(path.join(directory, 'called.yml'), 'on:\n  workflow_call:\n');
    writeFileSync(path.join(directory, 'notes.md'), 'not a workflow\n');
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it('reads both spellings of the extension, so one is not a blind spot', () => {
    expect(triggeredWorkflowFiles(directory)).toEqual(['scheduled.yaml']);
  });
});

describe('triggerEvents', () => {
  it('reads the mapping form the filtered triggers are written in', () => {
    expect(triggerEvents({ push: { branches: ['main'] }, workflow_dispatch: null })).toEqual([
      'push',
      'workflow_dispatch',
    ]);
  });

  it('reads the list form', () => {
    expect(triggerEvents(['push', 'workflow_dispatch'])).toEqual(['push', 'workflow_dispatch']);
  });

  it('reads the single-event form', () => {
    expect(triggerEvents('push')).toEqual(['push']);
  });

  it('refuses a file declaring no triggers rather than reading it as declaring none', () => {
    const absent: unknown = undefined;

    expect(() => triggerEvents(absent)).toThrow('shape this cannot read');
  });

  it('refuses a shape that is neither name, list nor mapping', () => {
    expect(() => triggerEvents(7)).toThrow('shape this cannot read');
  });
});

describe('conjuncts', () => {
  it('splits a guard on its top-level conjunctions', () => {
    expect(conjuncts("a == 'x' && b == 'y'")).toEqual(["a == 'x'", "b == 'y'"]);
  });

  it('keeps a parenthesised disjunction whole', () => {
    expect(conjuncts("a == 'x' && (b || c)")).toEqual(["a == 'x'", '(b || c)']);
  });

  it('proves nothing about a guard whose top level is a disjunction', () => {
    expect(conjuncts("a == 'x' || b == 'y'")).toEqual([]);
  });
});

describe('admittedRepositories', () => {
  const VARIABLES = { HB_PUBLIC_REPO: 'owner/public', HB_STAGING_REPO: 'owner/staging' };
  const BOTH = ['owner/public', 'owner/staging'];

  it('admits the repository the variable names', () => {
    expect(
      admittedRepositories(
        `github.repository == vars.${PUBLIC_REPOSITORY_VARIABLE}`,
        VARIABLES,
        BOTH
      )
    ).toEqual(['owner/public']);
  });

  it('refuses the repository the variable does not name', () => {
    expect(
      admittedRepositories(
        `github.repository == vars.${STAGING_REPOSITORY_VARIABLE}`,
        VARIABLES,
        BOTH
      )
    ).toEqual(['owner/staging']);
  });

  it('reads a guard with no repository term as admitting both, so the repository-admission checks are not vacuous', () => {
    expect(admittedRepositories(undefined, VARIABLES, BOTH)).toEqual(BOTH);
    expect(admittedRepositories("needs.preflight.outputs.skip != 'true'", VARIABLES, BOTH)).toEqual(
      BOTH
    );
  });
});

describe('the workflows that run in whichever repository carries them', () => {
  it('admits every job only in the repository its workflow belongs to', async () => {
    const { publicRepo, stagingRepo } = await readRepositories();
    const variables = { HB_PUBLIC_REPO: publicRepo, HB_STAGING_REPO: stagingRepo };
    const both = [publicRepo, stagingRepo];

    for (const { file, variable, jobs } of GUARDED_WORKFLOWS) {
      const owner = variable === PUBLIC_REPOSITORY_VARIABLE ? publicRepo : stagingRepo;
      for (const name of jobs) {
        expect({
          job: `${file}:${name}`,
          admits: admittedRepositories(jobsOf(file)[name]?.if, variables, both),
        }).toEqual({ job: `${file}:${name}`, admits: [owner] });
      }
    }
  });

  it('acts in neither repository while the repository variables are unset', async () => {
    const { publicRepo, stagingRepo } = await readRepositories();
    const both = [publicRepo, stagingRepo];

    for (const { file, jobs } of GUARDED_WORKFLOWS) {
      for (const name of jobs) {
        expect({
          job: `${file}:${name}`,
          admits: admittedRepositories(jobsOf(file)[name]?.if, {}, both),
        }).toEqual({ job: `${file}:${name}`, admits: [] });
      }
    }
  });

  it('declares every job each file actually carries', () => {
    for (const { file, jobs } of GUARDED_WORKFLOWS) {
      expect({ file, jobs: Object.keys(jobsOf(file)).toSorted(byName) }).toEqual({
        file,
        jobs: [...jobs].toSorted(byName),
      });
    }
  });

  it('never restates a repository slug as a literal', async () => {
    const { publicRepo, stagingRepo } = await readRepositories();

    for (const { file } of GUARDED_WORKFLOWS) {
      const text = source(file);

      expect({ file, public: text.includes(publicRepo) }).toEqual({ file, public: false });
      expect({ file, staging: text.includes(stagingRepo) }).toEqual({ file, staging: false });
    }
  });

  it('is never reachable from a fork pull request', () => {
    for (const { file } of GUARDED_WORKFLOWS) {
      const events = triggerEvents((parse(source(file)) as { on: unknown }).on);

      expect({
        file,
        forkEvents: events.filter((event) => event.startsWith('pull_request')),
      }).toEqual({ file, forkEvents: [] });
    }
  });

  /**
   * Read over both lists rather than over the table, because a file the table
   * cannot carry is exempt from the per-row fork-trigger assertion, and would
   * otherwise carry no fork-trigger assertion at all. This is where the claim
   * that one file alone is fork-reachable stops depending on nobody having used
   * the exemption.
   */
  it('leaves the fork trigger to the one file whose own suite pins its phase guards', () => {
    const forkTriggered = [...GUARDED_WORKFLOWS, ...UNTABLED_TRIGGERED_WORKFLOWS]
      .filter(({ file }) =>
        triggerEvents((parse(source(file)) as { on: unknown }).on).some((event) =>
          event.startsWith('pull_request')
        )
      )
      .map(({ file }) => file);

    expect(forkTriggered).toEqual(['ci.yml']);
  });
});

/**
 * Pins the row type: `credentialJob` is required beside `credentialStep`, so a
 * row naming a credential step without its job is a compile error at the row.
 * The enforcement is the compiler's rather than this runner's — an unused
 * `@ts-expect-error` is an error of its own, so the build fails the moment such
 * a row stops being refused.
 */
describe('a row that holds the sync bot credential', () => {
  it('refuses a credential step written without the job that holds it', () => {
    const unnamed = {
      file: 'credential.yml',
      variable: PUBLIC_REPOSITORY_VARIABLE,
      jobs: ['first', 'second'],
      credentialStep: 'pnpm tsx scripts/credential.ts',
    };

    // @ts-expect-error a credential row names the one job allowed to hold the credential
    const row: GuardedWorkflow = unnamed;

    expect(row.file).toBe(unnamed.file);
  });
});
