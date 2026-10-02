/**
 * Structural assertions over how CI wires the cassette store.
 *
 * The credential boundary is the point: a fork's `pull_request` run is
 * untrusted and must never reach the shared bucket or its secrets. That is a
 * property of the workflow file, not of any module, so it is pinned here
 * rather than left to review — including for later edits that reshape the
 * workflow's branching.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { CASSETTE_DIRECTORY } from '@hushbox/shared/cassettes';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CI_WORKFLOW = path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml');

const SECRET_MARKER = 'CASSETTE_R2_';
const STORE_ENTRY = 'scripts/cassette-store.ts';
const FORK_EXCLUSION = "github.event_name != 'pull_request'";

interface WorkflowStep {
  readonly name?: string;
  readonly if?: string;
  readonly run?: string;
  readonly uses?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
}

interface WorkflowJob {
  readonly if?: string;
  readonly steps?: WorkflowStep[];
  readonly env?: Record<string, unknown>;
}

interface Workflow {
  readonly env?: Record<string, unknown>;
  readonly jobs: Record<string, WorkflowJob>;
}

const source = readFileSync(CI_WORKFLOW, 'utf8');
const workflow = parse(source) as Workflow;
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps ?? []);

function mentionsStore(step: WorkflowStep): boolean {
  return JSON.stringify(step).includes(SECRET_MARKER) || (step.run ?? '').includes(STORE_ENTRY);
}

/**
 * True only when the guard cannot admit a `pull_request` event: the fork
 * exclusion must be one of the `&&`-joined top-level clauses, and an `||`
 * anywhere could reintroduce the event through the other branch.
 */
function excludesForkPullRequests(guard?: string): boolean {
  if (guard === undefined || guard.includes('||')) return false;
  return guard.split('&&').some((clause) => clause.trim() === FORK_EXCLUSION);
}

describe('CI cassette wiring', () => {
  it('restores the store before the suite and stores new recordings after it', () => {
    const commands = steps.map((step) => step.run ?? '').filter((run) => run.includes(STORE_ENTRY));

    expect(commands.some((run) => run.includes('download'))).toBe(true);
    expect(commands.some((run) => run.includes('upload'))).toBe(true);
  });

  it('uploads recordings even when the suite failed', () => {
    const upload = steps.find((step) => (step.run ?? '').includes(`${STORE_ENTRY} upload`));

    expect(upload?.if).toContain('always()');
  });

  it('no longer caches cassettes per branch through the Actions cache', () => {
    const cachedPaths = steps
      .filter((step) => (step.uses ?? '').includes('cache'))
      .map((step) => JSON.stringify(step.with?.['path'] ?? ''));

    expect(cachedPaths.some((cached) => cached.includes(CASSETTE_DIRECTORY))).toBe(false);
  });

  it('keeps every step that touches the store off the fork pull-request path', () => {
    const touching = steps.filter((step) => mentionsStore(step));

    expect(touching.length).toBeGreaterThan(0);
    for (const step of touching) {
      expect({ step: step.name, guarded: excludesForkPullRequests(step.if) }).toEqual({
        step: step.name,
        guarded: true,
      });
    }
  });

  it('never exposes the store credentials at workflow or job scope', () => {
    const ambient = [workflow.env, ...Object.values(workflow.jobs).map((job) => job.env)];

    expect(JSON.stringify(ambient)).not.toContain(SECRET_MARKER);
  });
});

describe('excludesForkPullRequests', () => {
  it('accepts the bare fork exclusion', () => {
    expect(excludesForkPullRequests(FORK_EXCLUSION)).toBe(true);
  });

  it('accepts the exclusion combined with further conditions', () => {
    expect(excludesForkPullRequests(`always() && ${FORK_EXCLUSION}`)).toBe(true);
  });

  it('rejects an absent guard', () => {
    expect(excludesForkPullRequests()).toBe(false);
  });

  it('rejects a guard that could be satisfied through an alternative branch', () => {
    expect(excludesForkPullRequests(`${FORK_EXCLUSION} || always()`)).toBe(false);
  });

  it('rejects a guard about some other condition', () => {
    expect(excludesForkPullRequests('always()')).toBe(false);
  });
});
