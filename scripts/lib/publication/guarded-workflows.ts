/**
 * The one table of workflow files both repositories carry and either can start
 * on its own, and the reader that decides which repository each job admits.
 *
 * A workflow triggered by a schedule, a branch push or a manual dispatch runs in
 * whichever repository holds the file, so the repository guard is the only thing
 * that keeps the wrong copy from acting. The table names the one repository each
 * file belongs to and every job the file declares, so a job added without a
 * guard is caught rather than left to fire in the wrong place.
 *
 * One table rather than one per workstream. A second list of the same shape does
 * not fail when the two disagree: a workflow added to one looks accounted for
 * while nothing measures it against the other. {@link triggeredWorkflowFiles}
 * closes the direction neither list can — a file added to the directory and
 * written into no list at all — by reconciling both against the directory
 * itself.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

export const WORKFLOWS_DIRECTORY = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '.github',
  'workflows'
);

/**
 * The repository variables, bound once. Both halves of the spelling are derived
 * from these rather than bound again: two files each holding their own pair had
 * the same two identifiers carrying different values, one with the `vars.`
 * prefix and one without.
 */
export const PUBLIC_REPOSITORY_VARIABLE = 'HB_PUBLIC_REPO';
export const STAGING_REPOSITORY_VARIABLE = 'HB_STAGING_REPO';

/** The variable as a workflow expression reads it. */
export const variableExpression = (variable: string): string => `vars.${variable}`;

/** The whole guard term a workflow writes to confine itself to one repository. */
export const repositoryTerm = (variable: string): string =>
  `github.repository == ${variableExpression(variable)}`;

interface WorkflowRow {
  readonly file: string;
  /** The repository variable naming the one repository this file belongs to. */
  readonly variable: string;
  /** Every job the file declares, so an unguarded addition cannot hide. */
  readonly jobs: readonly string[];
}

/**
 * A file that holds the sync bot credential names both the step allowed to hold
 * it and the job that step sits in, so a credential-free job beside it is read as
 * one rather than as a second place the credential may be.
 */
export interface CredentialWorkflow extends WorkflowRow {
  readonly credentialJob: string;
  readonly credentialStep: string;
}

interface CredentialFreeWorkflow extends WorkflowRow {
  readonly credentialJob?: never;
  readonly credentialStep?: never;
}

export type GuardedWorkflow = CredentialWorkflow | CredentialFreeWorkflow;

export const GUARDED_WORKFLOWS: readonly GuardedWorkflow[] = [
  {
    file: 'backup.yml',
    variable: PUBLIC_REPOSITORY_VARIABLE,
    jobs: ['backup'],
  },
  { file: 'mutation.yml', variable: PUBLIC_REPOSITORY_VARIABLE, jobs: ['mutation'] },
  { file: 'gate-auditor.yml', variable: PUBLIC_REPOSITORY_VARIABLE, jobs: ['audit'] },
  {
    file: 'groom-linear.yml',
    variable: STAGING_REPOSITORY_VARIABLE,
    jobs: ['preflight', 'groom', 'watermark'],
  },
  { file: 'sync-ops-labels.yml', variable: PUBLIC_REPOSITORY_VARIABLE, jobs: ['sync'] },
  {
    file: 'release.yml',
    variable: PUBLIC_REPOSITORY_VARIABLE,
    jobs: ['validate', 'prepare-version', 'ios', 'android-play', 'android-github'],
  },
  { file: 'run-ops-script.yml', variable: PUBLIC_REPOSITORY_VARIABLE, jobs: ['run'] },
  {
    file: 'escrow-secrets.yml',
    variable: PUBLIC_REPOSITORY_VARIABLE,
    jobs: ['escrow', 'escrow-backup'],
  },
  {
    file: 'publish-mirror.yml',
    variable: STAGING_REPOSITORY_VARIABLE,
    jobs: ['mirror'],
    credentialJob: 'mirror',
    credentialStep: 'pnpm tsx scripts/publication/publish-mirror.ts',
  },
  {
    file: 'sync-inbound.yml',
    variable: PUBLIC_REPOSITORY_VARIABLE,
    jobs: ['sync'],
    credentialJob: 'sync',
    credentialStep: 'pnpm tsx scripts/publication/sync-inbound.ts',
  },
  {
    file: 'sync-auditor.yml',
    variable: STAGING_REPOSITORY_VARIABLE,
    jobs: ['audit'],
    credentialJob: 'audit',
    credentialStep: 'pnpm tsx scripts/publication/sync-auditor.ts',
  },
  {
    file: 'deploy-now.yml',
    variable: PUBLIC_REPOSITORY_VARIABLE,
    jobs: ['publish', 'dispatch'],
    credentialJob: 'publish',
    credentialStep: 'pnpm tsx scripts/publication/publish-staging-tip.ts',
  },
];

/** The rows whose guarded job mints the sync bot's token. */
export const CREDENTIAL_WORKFLOWS: readonly CredentialWorkflow[] = GUARDED_WORKFLOWS.filter(
  (workflow): workflow is CredentialWorkflow => workflow.credentialStep !== undefined
);

interface UntabledWorkflow {
  readonly file: string;
  /** Why the table cannot carry it, stated beside the entry rather than in prose. */
  readonly reason: string;
}

/**
 * The triggered files the table deliberately does not carry. An entry here is an
 * exception to the invariant, not a file nobody looked at, which is the whole
 * reason the reconciliation reads this list rather than skipping what it cannot
 * place.
 */
export const UNTABLED_TRIGGERED_WORKFLOWS: readonly UntabledWorkflow[] = [
  {
    file: 'ci.yml',
    reason:
      'gated per job, some of it inherited through `needs` rather than written on the job, ' +
      'which a flat job list cannot express; pinned by its own assertion instead',
  },
];

/** A trigger that only another workflow can pull, so no repository starts it alone. */
const CALL_ONLY_TRIGGER = 'workflow_call';

/**
 * The events a workflow declares, in each shape the `on` key accepts: one event,
 * a list of them, or a mapping from event to its filters. A shape this does not
 * know is refused rather than read as declaring nothing — a file whose triggers
 * cannot be read is a file the reconciliation cannot place.
 */
export function triggerEvents(on: unknown): string[] {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (typeof on === 'object' && on !== null) return Object.keys(on);
  throw new TypeError('a workflow declares its triggers in a shape this cannot read');
}

/** Every workflow file a directory holds, in both spellings of the extension. */
export function workflowFiles(directory: string): string[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .toSorted((left, right) => left.localeCompare(right));
}

/** The events one workflow file declares, read from the file itself. */
export function triggerEventsOf(directory: string, file: string): string[] {
  const { on } = parse(readFileSync(path.join(directory, file), 'utf8')) as { on: unknown };
  return triggerEvents(on);
}

/**
 * Every workflow file in the directory that some event other than another
 * workflow's call can start. Read from the directory rather than from a list, so
 * a file added to neither list is what fails.
 */
export function triggeredWorkflowFiles(directory: string): string[] {
  return workflowFiles(directory).filter((name) =>
    triggerEventsOf(directory, name).some((event) => event !== CALL_ONLY_TRIGGER)
  );
}

const NESTING: Readonly<Record<string, number>> = { '(': 1, ')': -1 };

function topLevelSeparators(guard: string): number[] | null {
  const separators: number[] = [];
  let depth = 0;
  for (let index = 0; index < guard.length; index += 1) {
    depth += NESTING[guard.charAt(index)] ?? 0;
    if (depth !== 0) continue;
    if (guard.startsWith('||', index)) return null;
    if (guard.startsWith('&&', index)) separators.push(index);
  }
  return separators;
}

/**
 * A guard's top-level conjunctions. Deliberately syntactic and deliberately
 * conservative: an `||` outside parentheses can admit through its other side, so
 * the whole guard answers nothing rather than being reasoned about. A
 * parenthesised group is opaque, which is what lets a repository-membership
 * clause sit beside a phase clause without blinding either reader.
 */
export function conjuncts(guard: string): string[] {
  const separators = topLevelSeparators(guard);
  if (separators === null) return [];
  let cut = 0;
  const parts = separators.map((separator) => {
    const part = guard.slice(cut, separator);
    cut = separator + 2;
    return part;
  });
  return [...parts, guard.slice(cut)].map((part) => part.trim()).filter((part) => part !== '');
}

const REPOSITORY_TERM = /^github\.repository == vars\.([A-Z_]+)$/;

/**
 * Which of the candidate repositories a guard's repository term still admits.
 * Only that term is evaluated, and that is enough: a conjunction is false
 * wherever any conjunct is, so a term excluding a repository settles the whole
 * guard there. A guard carrying no such term admits every repository — the shape
 * these assertions exist to catch. An unset variable matches no slug, so an
 * unprovisioned repository admits nothing rather than everything.
 */
export function admittedRepositories(
  guard: string | undefined,
  variables: Readonly<Record<string, string>>,
  candidates: readonly string[]
): string[] {
  const named = conjuncts(guard ?? '')
    .map((clause) => REPOSITORY_TERM.exec(clause)?.[1])
    .find((name) => name !== undefined);
  if (named === undefined) return [...candidates];
  return candidates.filter((repository) => variables[named] === repository);
}
