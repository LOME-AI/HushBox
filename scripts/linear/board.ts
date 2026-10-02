import { writeFile as fsWriteFile } from 'node:fs/promises';

import { LinearClient } from '@linear/sdk';
import { LINEAR_TEAM_ID } from '@hushbox/shared/linear';

import { isMainModule } from '../lib/cli/is-main.js';
import { readCommandLine } from '../lib/cli/command-line.js';
import { runMain } from '../lib/cli/run-main.js';
import { fetchBoard, requireEnv, withBackoff } from './client.js';
import { countUngroomed, groomedHash, validateBackup } from './validate.js';
import type { CommandSpec, FlagRecord, FlagSpec, Invocation } from '../lib/cli/command-line.js';

import type {
  BoardSource,
  IssueCreateInput,
  IssueUpdateInput,
  ProjectCreateInput,
  WritePayload,
  WriteSource,
} from './client.js';
import type { Backup } from './schema.js';

/**
 * Injected effects for the CLI. Kept as dependencies so tests exercise dispatch
 * and validation with an in-memory board and no live Linear network or disk.
 */
export interface MainDeps {
  fetchBoard: () => Promise<Backup>;
  writeFile: (path: string, data: string) => Promise<void>;
  writeClient: WriteSource;
  log: (message: string) => void;
}

/**
 * Linear priority is an integer, NOT a severity scale: 0 = none, 1 = urgent,
 * 2 = high, 3 = medium, 4 = low. The CLI takes the name and maps it here.
 */
const PRIORITY_BY_NAME: Record<string, number> = {
  none: 0,
  urgent: 1,
  high: 2,
  medium: 3,
  low: 4,
};

/** The fields an issue create and an issue update both accept. */
const ISSUE_FIELD_FLAGS = [
  { flag: '--description', kind: 'value', placeholder: '<text>', summary: "The issue's body." },
  {
    flag: '--estimate',
    kind: 'value',
    placeholder: '<points>',
    summary: 'A non-negative integer.',
  },
  {
    flag: '--priority',
    kind: 'value',
    placeholder: '<name>',
    summary: 'none, urgent, high, medium or low.',
  },
  {
    flag: '--project',
    kind: 'value',
    placeholder: '<id>',
    summary: 'The project to file it under.',
  },
  {
    flag: '--state',
    kind: 'value',
    placeholder: '<id>',
    summary: 'The workflow state to move to.',
  },
] as const satisfies readonly FlagSpec[];

const DRY_RUN_FLAG = {
  flag: '--dry-run',
  kind: 'boolean',
  summary: 'Print what would be written and write nothing.',
} as const satisfies FlagSpec;

/** One spec per command word; the dispatch below refuses anything else. */
const SUBCOMMANDS = {
  backup: {
    command: 'pnpm linear:backup',
    summary: 'Fetches the whole board and writes it as JSON.',
    flags: [
      {
        flag: '--allow-shrink',
        kind: 'boolean',
        summary: 'Accept a backup holding fewer issues than the last one.',
      },
      { flag: '--out', kind: 'value', placeholder: '<path>', summary: 'Where to write the JSON.' },
      {
        flag: '--prev-count',
        kind: 'value',
        placeholder: '<n>',
        summary: 'How many issues the previous backup held.',
      },
    ],
    positionals: { kind: 'none' },
  },
  'count-ungroomed': {
    command: 'pnpm linear:board count-ungroomed',
    summary: 'Prints how many issues are still ungroomed.',
    flags: [],
    positionals: { kind: 'none' },
  },
  hash: {
    command: 'pnpm linear:board hash',
    summary: 'Prints the groomed hash of a title and description.',
    flags: [
      { flag: '--description', kind: 'value', placeholder: '<text>', summary: "The issue's body." },
      { flag: '--title', kind: 'value', placeholder: '<text>', summary: "The issue's title." },
    ],
    positionals: { kind: 'none' },
  },
  'update-issue': {
    command: 'pnpm linear:board update-issue',
    summary: 'Applies the named fields to one issue.',
    flags: [
      {
        flag: '--add-label',
        kind: 'list',
        placeholder: '<id>',
        summary: 'A label to add; repeatable.',
      },
      DRY_RUN_FLAG,
      { flag: '--id', kind: 'value', placeholder: '<id>', summary: 'The issue to update.' },
      {
        flag: '--remove-label',
        kind: 'list',
        placeholder: '<id>',
        summary: 'A label to remove; repeatable.',
      },
      { flag: '--title', kind: 'value', placeholder: '<text>', summary: "The issue's title." },
      ...ISSUE_FIELD_FLAGS,
    ],
    positionals: { kind: 'none' },
  },
  'create-issue': {
    command: 'pnpm linear:board create-issue',
    summary: 'Creates one issue on the team board.',
    flags: [
      DRY_RUN_FLAG,
      { flag: '--label', kind: 'list', placeholder: '<id>', summary: 'A label; repeatable.' },
      { flag: '--title', kind: 'value', placeholder: '<text>', summary: "The issue's title." },
      ...ISSUE_FIELD_FLAGS,
    ],
    positionals: { kind: 'none' },
  },
  'create-comment': {
    command: 'pnpm linear:board create-comment',
    summary: 'Comments on one issue.',
    flags: [
      { flag: '--body', kind: 'value', placeholder: '<text>', summary: 'The comment body.' },
      DRY_RUN_FLAG,
      { flag: '--issue', kind: 'value', placeholder: '<id>', summary: 'The issue to comment on.' },
    ],
    positionals: { kind: 'none' },
  },
  'create-project': {
    command: 'pnpm linear:board create-project',
    summary: 'Creates one project on the team board.',
    flags: [
      {
        flag: '--description',
        kind: 'value',
        placeholder: '<text>',
        summary: "The project's body.",
      },
      DRY_RUN_FLAG,
      { flag: '--name', kind: 'value', placeholder: '<text>', summary: "The project's name." },
    ],
    positionals: { kind: 'none' },
  },
} as const satisfies Record<string, CommandSpec>;

/**
 * Each command word's own grammar, keyed by the word that reaches it, so a
 * check driving this entry can type the word rather than guess it.
 */
export const SUBCOMMAND_LINES: Readonly<Record<string, CommandSpec>> = SUBCOMMANDS;

export const COMMAND_LINE = {
  command: 'pnpm linear:board',
  summary: `Reads and writes the team board. Commands: ${Object.keys(SUBCOMMANDS).join(', ')}.`,
  flags: [],
  positionals: {
    kind: 'many',
    placeholder: '<command>',
    summary: `One of: ${Object.keys(SUBCOMMANDS).join(', ')}. Each takes its own --help.`,
  },
} as const satisfies CommandSpec;

/**
 * The arguments of one command word, or `null` when the line asked for that
 * word's usage — which this wrote out.
 */
function argumentsOf(
  command: keyof typeof SUBCOMMANDS,
  rest: string[]
): Invocation<CommandSpec> | null {
  return readCommandLine(SUBCOMMANDS[command] as CommandSpec, rest);
}

/** Read a flag's value, throwing a clear error when it is absent. */
function requireValue(flags: FlagRecord, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value === '') {
    throw new Error(`Missing required flag: ${name}`);
  }
  return value;
}

/** Read an optional flag's value; undefined when the flag is absent. */
function optionalValue(flags: FlagRecord, name: string): string | undefined {
  const value = flags[name];
  return typeof value === 'string' ? value : undefined;
}

function isValueList(value: unknown): value is readonly string[] {
  return Array.isArray(value);
}

/** Gather every value of a repeatable flag, in order. */
function collectValues(flags: FlagRecord, name: string): string[] {
  const values = flags[name];
  return isValueList(values) ? [...values] : [];
}

/** Map a priority name to its Linear integer, rejecting unknown names. */
function parsePriority(raw: string): number {
  const priority = PRIORITY_BY_NAME[raw.toLowerCase()];
  if (priority === undefined) {
    throw new Error(`Invalid --priority: ${raw} (expected none|urgent|high|medium|low)`);
  }
  return priority;
}

/** Parse a non-negative integer estimate, rejecting anything else. */
function parseEstimate(raw: string): number {
  const estimate = Number(raw);
  if (!Number.isInteger(estimate) || estimate < 0) {
    throw new TypeError(`Invalid --estimate: ${raw}`);
  }
  return estimate;
}

/** Run a write through the rate-limit policy and reject a `success: false` payload. */
async function submit(action: string, call: () => Promise<WritePayload>): Promise<void> {
  const payload = await withBackoff(call);
  if (!payload.success) {
    throw new Error(`Linear write failed: ${action}`);
  }
}

async function runBackup(flags: FlagRecord, deps: MainDeps): Promise<void> {
  const out = requireValue(flags, '--out');
  const raw = optionalValue(flags, '--prev-count');
  let previousCount: number | undefined;
  if (raw !== undefined) {
    previousCount = Number(raw);
    if (!Number.isFinite(previousCount)) {
      throw new TypeError(`Invalid --prev-count: ${raw}`);
    }
  }
  const allowShrink = flags['--allow-shrink'] === true;

  const board = await deps.fetchBoard();
  const serialized = JSON.stringify(board, null, 2);
  // Write before validating: the artifact must survive to disk even when
  // validation later rejects it, so a human can inspect what was fetched.
  await deps.writeFile(out, serialized);

  const validated = validateBackup(JSON.parse(serialized), {
    prevCount: previousCount,
    allowShrink,
  });
  deps.log(`Backed up ${String(validated.issues.length)} issues to ${out}`);
}

/**
 * Apply the fields shared by issue create and update — description, estimate,
 * priority, project, state — setting only those the caller supplied. Shared so
 * the two builders don't drift.
 */
function applyCommonIssueFields(
  flags: FlagRecord,
  input: {
    description?: string;
    estimate?: number;
    priority?: number;
    projectId?: string;
    stateId?: string;
  }
): void {
  const description = optionalValue(flags, '--description');
  if (description !== undefined) input.description = description;
  const estimate = optionalValue(flags, '--estimate');
  if (estimate !== undefined) input.estimate = parseEstimate(estimate);
  const priority = optionalValue(flags, '--priority');
  if (priority !== undefined) input.priority = parsePriority(priority);
  const project = optionalValue(flags, '--project');
  if (project !== undefined) input.projectId = project;
  const state = optionalValue(flags, '--state');
  if (state !== undefined) input.stateId = state;
}

/** Build an additive issue update from flags — only fields the caller supplied. */
function buildUpdateInput(flags: FlagRecord): IssueUpdateInput {
  const input: IssueUpdateInput = {};
  const title = optionalValue(flags, '--title');
  if (title !== undefined) input.title = title;
  applyCommonIssueFields(flags, input);
  const added = collectValues(flags, '--add-label');
  if (added.length > 0) input.addedLabelIds = added;
  const removed = collectValues(flags, '--remove-label');
  if (removed.length > 0) input.removedLabelIds = removed;
  return input;
}

/** Build a create-issue input; the HUS team id is supplied automatically. */
function buildCreateInput(flags: FlagRecord): IssueCreateInput {
  const input: IssueCreateInput = {
    teamId: LINEAR_TEAM_ID,
    title: requireValue(flags, '--title'),
  };
  applyCommonIssueFields(flags, input);
  const labels = collectValues(flags, '--label');
  if (labels.length > 0) input.labelIds = labels;
  return input;
}

/** Build a create-project input; the HUS team id is supplied automatically. */
function buildProjectInput(flags: FlagRecord): ProjectCreateInput {
  const input: ProjectCreateInput = {
    name: requireValue(flags, '--name'),
    teamIds: [LINEAR_TEAM_ID],
  };
  const description = optionalValue(flags, '--description');
  if (description !== undefined) input.description = description;
  return input;
}

async function runUpdateIssue(flags: FlagRecord, deps: MainDeps, dryRun: boolean): Promise<void> {
  const id = requireValue(flags, '--id');
  const input = buildUpdateInput(flags);
  if (dryRun) {
    deps.log(`[dry-run] updateIssue ${id} ${JSON.stringify(input)}`);
    return;
  }
  await submit(`updateIssue ${id}`, () => deps.writeClient.updateIssue(id, input));
  deps.log(`Updated ${id}`);
}

async function runCreateIssue(flags: FlagRecord, deps: MainDeps, dryRun: boolean): Promise<void> {
  const input = buildCreateInput(flags);
  if (dryRun) {
    deps.log(`[dry-run] createIssue ${JSON.stringify(input)}`);
    return;
  }
  await submit('createIssue', () => deps.writeClient.createIssue(input));
  deps.log(`Created issue "${input.title}"`);
}

async function runCreateComment(flags: FlagRecord, deps: MainDeps, dryRun: boolean): Promise<void> {
  const issueId = requireValue(flags, '--issue');
  const body = requireValue(flags, '--body');
  if (dryRun) {
    deps.log(`[dry-run] createComment ${JSON.stringify({ issueId, body })}`);
    return;
  }
  await submit('createComment', () => deps.writeClient.createComment({ issueId, body }));
  deps.log(`Commented on ${issueId}`);
}

async function runCreateProject(flags: FlagRecord, deps: MainDeps, dryRun: boolean): Promise<void> {
  const input = buildProjectInput(flags);
  if (dryRun) {
    deps.log(`[dry-run] createProject ${JSON.stringify(input)}`);
    return;
  }
  await submit('createProject', () => deps.writeClient.createProject(input));
  deps.log(`Created project "${input.name}"`);
}

/** Run one command word against the arguments its own grammar accepted. */
async function dispatch(
  command: keyof typeof SUBCOMMANDS,
  flags: FlagRecord,
  deps: MainDeps
): Promise<void> {
  const dryRun = flags['--dry-run'] === true;
  switch (command) {
    case 'backup': {
      return runBackup(flags, deps);
    }
    case 'count-ungroomed': {
      const board = await deps.fetchBoard();
      deps.log(String(countUngroomed(board)));
      return;
    }
    case 'hash': {
      deps.log(groomedHash(requireValue(flags, '--title'), requireValue(flags, '--description')));
      return;
    }
    case 'update-issue': {
      return runUpdateIssue(flags, deps, dryRun);
    }
    case 'create-issue': {
      return runCreateIssue(flags, deps, dryRun);
    }
    case 'create-comment': {
      return runCreateComment(flags, deps, dryRun);
    }
    case 'create-project': {
      return runCreateProject(flags, deps, dryRun);
    }
    /* v8 ignore start -- unreachable while the arms above stay exhaustive, which is what the never assertion holds */
    default: {
      // Exhaustive over the declared command words: a word the grammar gains
      // without a case here fails to compile, rather than falling through into
      // whichever action the last arm happens to name.
      const unhandled: never = command;
      throw new Error(`Unknown command: ${String(unhandled)}`);
    }
    /* v8 ignore stop */
  }
}

function isSubcommand(command: string | undefined): command is keyof typeof SUBCOMMANDS {
  return command !== undefined && command in SUBCOMMANDS;
}

/** Dispatch a single CLI invocation. Returns nothing; throws on any failure. */
export async function main(argv: string[], deps: MainDeps): Promise<void> {
  const [command, ...rest] = argv;
  if (!isSubcommand(command)) {
    if (readCommandLine(COMMAND_LINE, argv) === null) return;
    throw new Error(command ? `Unknown command: ${command}` : 'Missing command');
  }
  const parsed = argumentsOf(command, rest);
  if (parsed === null) return;
  return dispatch(command, parsed.flags, deps);
}

/* v8 ignore start -- CLI wiring; dispatch, fetch, and validation tested with mocks */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    // Built on first reach, not before the parse: the credential is a
    // production write key, and asking this tool for its usage is exactly what
    // someone who does not yet know what it does types — demanding the key to
    // answer them locks out the whole audience of the help text.
    let client: LinearClient | undefined;
    const linear = (): LinearClient =>
      (client ??= new LinearClient({ apiKey: requireEnv('LINEAR_API_KEY_WRITE') }));
    const source: BoardSource = {
      issues: (variables) => linear().issues(variables),
      projects: (variables) => linear().projects(variables),
      issueLabels: (variables) => linear().issueLabels(variables),
      workflowStates: (variables) => linear().workflowStates(variables),
    };
    const writeClient: WriteSource = {
      updateIssue: (id, input) => linear().updateIssue(id, input),
      createIssue: (input) => linear().createIssue(input),
      createComment: (input) => linear().createComment(input),
      createProject: (input) => linear().createProject(input),
    };
    await main(process.argv.slice(2), {
      fetchBoard: () => fetchBoard(source),
      writeFile: (path, data) => fsWriteFile(path, data, 'utf8'),
      writeClient,
      log: (message) => {
        console.log(message);
      },
    });
  });
}
/* v8 ignore stop */
