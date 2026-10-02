/**
 * A workflow step that reaches the env wrapper under a mode that loads no env
 * file has to be handed a stack slot by the environment it runs under.
 *
 * `scripts/with-env.ts` claims a run before it spawns anything, and the claim
 * names a slot that `scripts/lib/stack/stack-slot.ts` deliberately refuses to
 * default. Every mode but one escapes that unnoticed, because the wrapper loads
 * the generated scripts file and that file carries the slot the generation
 * claimed. The mode that writes no stack files loads none, so nothing but a
 * workflow, job or step env block can put the slot in scope.
 *
 * What a step reaches is resolved rather than matched against command text: a
 * `run:` body is followed through the package manager into another package's
 * manifest, through the task runner into every package declaring the task and
 * the tasks that task depends on, and from one script body into the next, until
 * a body names the wrapper. Matching text is what left both live instances of
 * this defect unseen — one spelled with a filter, one reached only through the
 * task graph.
 *
 * Nothing else is followed. The walk reads only what this repository's own
 * manifests and task configs spell out, and a hop written any other way is
 * answered rather than resolved: under-reported where the body names no route
 * the walk knows, over-reported where it names one whose narrowing goes unread.
 * So a step is covered here only when every hop from its command to the wrapper
 * is one of the followed routes. Among the hops that are not — a script named
 * through a shell variable or run by a tool outside the repository, which
 * resolves to no body and is passed over in silence; a `--filter` on a
 * task-runner invocation, skipped so the task expands to every package
 * declaring it, which can report a defect a step does not have; a step naming
 * an action rather than a command, whose own `run:` bodies under
 * `.github/actions/` are never read. Covering such a hop means teaching the
 * walk to read it, the way the package manager's own `--filter` is read.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { discoverWorkspaces } from './lib/cli/workspaces.js';
import { manifestScripts, rootScripts, tokensOf } from './lib/root-manifest.js';
import {
  DEFAULT_ENV_MODE,
  ENV_MODES,
  ENV_MODE_VARIABLE,
  writesStackFiles,
} from './lib/stack/stack-mode.js';
import { STACK_SLOT_VARIABLE } from './lib/stack/stack-slot.js';
import { CONFIG_FILE, packageConfigFiles, tasksIn, type TurboTask } from './turbo-configs.js';
import { parseEnvModeSelection } from './with-env.js';
import type { EnvMode } from '@hushbox/shared';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const WORKFLOWS_DIR = path.join('.github', 'workflows');

/** The module whose run claim reads the slot, as a manifest or workflow token names it. */
const ENV_WRAPPER = 'scripts/with-env.ts';

/** The repository's own manifest, which is what a step with no package directory runs in. */
const ROOT_DIR = '';

/** The word the task runner accepts between its name and the task, and ignores. */
const RUNNER_VERB = 'run';

/** How the task runner spells a task belonging to the repository's own manifest. */
const ROOT_TASK_PACKAGE = '//';

/** The wrappers a manifest puts in front of the task runner, each carrying the task after it. */
const TASK_RUNNERS: readonly string[] = ['turbo', 'scripts/turbo-run.ts', 'scripts/turbo-pool.ts'];

/**
 * The steps known to run the wrapper under a mode that loads no env file. The
 * floor case names them so a resolver that stops reaching one fails instead of
 * leaving the gate below asserting over an empty set, and each of them is only
 * reachable by one of the two readings a text match cannot make: the build job's
 * command reaches the wrapper through the task runner, and the migrate step
 * declares its mode in its own env block rather than the job's.
 */
const KNOWN_SLOT_REQUIRING_STEPS: readonly string[] = [
  '.github/workflows/ci.yml build "Build"',
  '.github/workflows/ci.yml deploy "Run database migrations (production)"',
];

const EnvBlock = z.record(z.string(), z.unknown()).optional();

/** As much of a workflow as this question needs: every env block, and every step's command. */
const WorkflowShape = z.object({
  env: EnvBlock,
  jobs: z
    .record(
      z.string(),
      z.object({
        env: EnvBlock,
        steps: z
          .array(
            z.object({
              name: z.string().optional(),
              run: z.string().optional(),
              'working-directory': z.string().optional(),
              env: EnvBlock,
            })
          )
          .optional(),
      })
    )
    .optional(),
});

type EnvValues = Readonly<Record<string, unknown>>;

interface WorkflowStep {
  /** The workflow file the step is written in, relative to the repository root. */
  readonly file: string;
  readonly job: string;
  readonly name: string;
  readonly run: string;
  /** The workspace package the command resolves its script names in. */
  readonly dir: string;
  /** Everything the step runs under: the workflow's block, the job's, then its own. */
  readonly env: EnvValues;
}

interface WorkspacePackage {
  /** The package directory, relative to the repository root. */
  readonly dir: string;
  /** The name the manifest declares. */
  readonly name: string;
  /** The name without its scope, which is the short form a filter may spell. */
  readonly short: string;
}

/** A script body being followed, and the package whose manifest its own names resolve in. */
interface Reach {
  readonly body: string;
  readonly dir: string;
}

const PACKAGES: readonly WorkspacePackage[] = discoverWorkspaces(REPO_ROOT).map((workspace) => ({
  dir: workspace.path,
  name: workspace.fullName,
  short: workspace.name,
}));

const scriptsByDir = new Map<string, Readonly<Record<string, string>>>();

/** The scripts one package declares, read once per package. */
function scriptsOf(dir: string): Readonly<Record<string, string>> {
  const cached = scriptsByDir.get(dir);
  if (cached !== undefined) return cached;
  const scripts = dir === ROOT_DIR ? rootScripts() : manifestScripts(`${dir}/package.json`);
  scriptsByDir.set(dir, scripts);
  return scripts;
}

/**
 * The words of a command, with quotes and subshell parentheses removed rather
 * than honoured. The removal is what reaches a task named inside a quoted
 * argument, and its cost is that an echoed command reads as a run one — an
 * over-approximation, which is the safe direction here: it can only add
 * reaches, never hide one.
 */
function wordsOf(body: string): string[] {
  return tokensOf(body.replaceAll(/["'()]/g, ' '));
}

const DependsOn = z.array(z.string()).optional();

/** The tasks a task declares it depends on, taken from the key the config passes through. */
function dependenciesOf(task: TurboTask | undefined): string[] {
  return DependsOn.parse(task?.['dependsOn']) ?? [];
}

/** Every task runner config, the repository's own first. */
function taskConfigs(): Record<string, TurboTask>[] {
  return [CONFIG_FILE, ...packageConfigFiles()].map((file) => tasksIn(file));
}

const TASK_CONFIGS = taskConfigs();

/**
 * A task as the runner names it, with the dependency caret and the package
 * qualifier removed. A qualifier naming a package other than the repository's
 * own is dropped rather than resolved: the task is then looked for in every
 * package, which reaches at least the one it named.
 */
function taskNameOf(reference: string): { readonly root: boolean; readonly name: string } {
  const stripped = reference.replace(/^\^/, '');
  const qualifier = stripped.indexOf('#');
  if (qualifier === -1) return { root: false, name: stripped };
  return {
    root: stripped.slice(0, qualifier) === ROOT_TASK_PACKAGE,
    name: stripped.slice(qualifier + 1),
  };
}

/** The bodies one task runs: the script of that name in every package declaring it. */
function bodiesOfTask(reference: string): Reach[] {
  const { root, name } = taskNameOf(reference);
  const directories = root ? [ROOT_DIR] : PACKAGES.map((workspace) => workspace.dir);
  return directories.flatMap((dir) => {
    const body = scriptsOf(dir)[name];
    return body === undefined ? [] : [{ body, dir }];
  });
}

/** Every task the runner reaches from one: the task itself, and the tasks it depends on. */
function taskClosure(reference: string): string[] {
  const reached = new Set<string>();
  const pending = [reference];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const { name } = taskNameOf(next);
    if (reached.has(name)) continue;
    reached.add(name);
    pending.push(
      ...TASK_CONFIGS.flatMap((tasks) => [
        ...dependenciesOf(tasks[name]),
        ...dependenciesOf(tasks[`${ROOT_TASK_PACKAGE}#${name}`]),
      ])
    );
  }
  return [...reached];
}

/** The word the task runner at `index` runs, skipping its verb and its flags. */
function taskAfter(words: readonly string[], index: number): string | undefined {
  return words.slice(index + 1).find((word) => word !== RUNNER_VERB && !word.startsWith('-'));
}

/** The packages a filter addresses: the scoped name, the short name, or the directory. */
function directoriesMatching(filter: string): string[] {
  return PACKAGES.filter(
    (workspace) =>
      workspace.name === filter ||
      workspace.short === filter ||
      path.basename(workspace.dir) === filter
  ).map((workspace) => workspace.dir);
}

/** A package-manager invocation, read from the word after `pnpm` onward. */
interface ManagerCall {
  readonly filter: string | undefined;
  readonly command: string | undefined;
}

function managerCallAt(words: readonly string[], index: number): ManagerCall {
  let at = index + 1;
  let filter: string | undefined;
  while (at < words.length) {
    const word = words[at] ?? '';
    if (word === '--filter' || word === '-F') {
      filter = words[at + 1];
      at += 2;
      continue;
    }
    if (word.startsWith('--filter=')) {
      filter = word.slice('--filter='.length);
      at += 1;
      continue;
    }
    if (!word.startsWith('-')) break;
    at += 1;
  }
  const named = words[at];
  return { filter, command: named === RUNNER_VERB ? words[at + 1] : named };
}

/**
 * The bodies a package-manager invocation runs. A verb of the manager's own —
 * anything but a declared script name — runs no script and so delegates
 * nowhere; the words after it stay in the body being scanned, which is where
 * the wrapper would be seen.
 */
function bodiesOfManagerCall(words: readonly string[], index: number, dir: string): Reach[] {
  const { filter, command } = managerCallAt(words, index);
  if (command === undefined) return [];
  const directories = filter === undefined ? [dir] : directoriesMatching(filter);
  return directories.flatMap((target) => {
    const body = scriptsOf(target)[command];
    return body === undefined ? [] : [{ body, dir: target }];
  });
}

/** The bodies one body delegates to, through the package manager and the task runner alike. */
function delegationsOf(reach: Reach): Reach[] {
  const words = wordsOf(reach.body);
  return words.flatMap((word, index) => {
    if (word === 'pnpm') return bodiesOfManagerCall(words, index, reach.dir);
    if (!TASK_RUNNERS.some((runner) => word === runner || word.endsWith(runner))) return [];
    const task = taskAfter(words, index);
    return task === undefined ? [] : taskClosure(task).flatMap((reached) => bodiesOfTask(reached));
  });
}

/**
 * Every body a command reaches, its own included, across package manifests and
 * through the task runner — which is the question `scripts/lib/root-manifest.ts`
 * does not answer with its own similarly named walk: that one follows script
 * names within a single manifest's script map, so each body it returns resolves
 * its next name in the same package, while a body reached here carries the
 * package its own names resolve in.
 */
function bodiesReachedAcrossPackages(start: Reach): Reach[] {
  const seen = new Set<string>();
  const pending = [start];
  const reached: Reach[] = [];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    const key = JSON.stringify([next.dir, next.body]);
    if (seen.has(key)) continue;
    seen.add(key);
    reached.push(next);
    pending.push(...delegationsOf(next));
  }
  return reached;
}

/**
 * The modes the wrapper resolves in one body, given the mode the environment
 * already names. The wrapper's own reader answers, so a body that selects a
 * mode for itself is read as running under that one.
 */
function wrapperModesIn(body: string, inherited: EnvMode): EnvMode[] {
  const words = wordsOf(body);
  return words.flatMap((word, index) =>
    word.endsWith(ENV_WRAPPER)
      ? [parseEnvModeSelection(words.slice(index + 1)).envMode ?? inherited]
      : []
  );
}

function isEnvMode(value: string): value is EnvMode {
  return (ENV_MODES as readonly string[]).includes(value);
}

/**
 * The modes a step runs under. A workflow expression resolves to one of its
 * quoted literals on the runner, so every literal naming a mode counts — the
 * step runs under whichever the expression picks.
 */
function declaredModes(env: EnvValues): EnvMode[] {
  const declared = env[ENV_MODE_VARIABLE];
  if (declared === undefined) return [DEFAULT_ENV_MODE];
  if (typeof declared !== 'string') return [];
  if (isEnvMode(declared)) return [declared];
  return [...declared.matchAll(/'([^']*)'/g)].flatMap(([, literal]) =>
    literal !== undefined && isEnvMode(literal) ? [literal] : []
  );
}

/** The package a working directory sits in, which is the nearest one containing it. */
function packageDirOf(workingDirectory: string | undefined): string {
  if (workingDirectory === undefined) return ROOT_DIR;
  const normalized = workingDirectory.replaceAll('\\', '/').replace(/\/$/, '');
  const containing = PACKAGES.map((workspace) => workspace.dir)
    .filter((dir) => normalized === dir || normalized.startsWith(`${dir}/`))
    .toSorted((left, right) => right.length - left.length);
  return containing[0] ?? ROOT_DIR;
}

function workflowSteps(): WorkflowStep[] {
  const directory = path.join(REPO_ROOT, WORKFLOWS_DIR);
  return readdirSync(directory)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .flatMap((name) => {
      const parsed: unknown = parseYaml(readFileSync(path.join(directory, name), 'utf8'));
      const workflow = WorkflowShape.parse(parsed);
      const file = `${WORKFLOWS_DIR.split(path.sep).join('/')}/${name}`;
      return Object.entries(workflow.jobs ?? {}).flatMap(([job, declared]) =>
        (declared.steps ?? []).flatMap((step) =>
          step.run === undefined
            ? []
            : [
                {
                  file,
                  job,
                  name: step.name ?? step.run,
                  run: step.run,
                  dir: packageDirOf(step['working-directory']),
                  env: { ...workflow.env, ...declared.env, ...step.env },
                },
              ]
        )
      );
    });
}

/**
 * The modes a step reaches the wrapper under that load no env file, and so need
 * the slot.
 *
 * The mode read is the one each wrapper invocation resolves, not the one the
 * step declares: a body is free to select a mode of its own, in either
 * direction. A step declaring the mode that loads no file still escapes where
 * every wrapper it reaches selects one that does, and a step declaring a mode
 * that writes files still refuses where a body it reaches selects the one that
 * writes none.
 */
function slotRequiringModes(step: WorkflowStep): EnvMode[] {
  const reached = bodiesReachedAcrossPackages({ body: step.run, dir: step.dir });
  const resolved = declaredModes(step.env).flatMap((declared) =>
    reached.flatMap((reach) => wrapperModesIn(reach.body, declared))
  );
  return [...new Set(resolved.filter((mode) => !writesStackFiles(mode)))];
}

function identify(step: WorkflowStep): string {
  return `${step.file} ${step.job} "${step.name}"`;
}

/** Every step that reaches the wrapper under a mode nothing writes an env file for. */
function slotRequiringSteps(): string[] {
  return workflowSteps().flatMap((step) =>
    slotRequiringModes(step).length > 0 ? [identify(step)] : []
  );
}

/** What a step gets wrong about the slot: it needs one, and nothing puts one in scope. */
function slotDefectsOf(step: WorkflowStep): string[] {
  if (STACK_SLOT_VARIABLE in step.env) return [];
  return slotRequiringModes(step).map(
    (mode) =>
      `reaches ${ENV_WRAPPER} under the ${mode} mode, which loads no env file, with no ${STACK_SLOT_VARIABLE} in scope`
  );
}

/**
 * A step written for a case, run from the repository root. The command is read
 * against the real manifests and the real task runner config, because what the
 * resolver is for is this repository's own graph — a case against a manifest of
 * its own would assert over a graph nothing runs.
 */
function stepRunning(run: string, env: EnvValues): WorkflowStep {
  return { file: 'a-workflow.yml', job: 'a-job', name: 'a step', run, dir: ROOT_DIR, env };
}

const PRODUCTION: EnvValues = { [ENV_MODE_VARIABLE]: 'production' };

/** The one defect there is, as a step declaring the mode that loads no file earns it. */
const REFUSAL = `reaches ${ENV_WRAPPER} under the production mode, which loads no env file, with no ${STACK_SLOT_VARIABLE} in scope`;

/**
 * A package script the repository's own manifest does not declare, so the only
 * reading that reaches its body is the filter's. A script both manifests
 * declare would be reached through the root one with the filter unread, which
 * is a case that passes without the reading it is for.
 */
const FILTERED_COMMAND = 'pnpm --filter @hushbox/db db:push';

describe('the stack slot a workflow step reaches the env wrapper with', () => {
  it('reports a command that reaches the wrapper only through the task runner', () => {
    expect(slotDefectsOf(stepRunning('pnpm build', PRODUCTION))).toEqual([REFUSAL]);
  });

  it('reports a task that reaches the wrapper only through the task it depends on', () => {
    expect(slotDefectsOf(stepRunning('turbo growth:index', PRODUCTION))).toEqual([REFUSAL]);
  });

  it('reports a command that reaches the wrapper only through a package filter', () => {
    expect(slotDefectsOf(stepRunning(FILTERED_COMMAND, PRODUCTION))).toEqual([REFUSAL]);
  });

  it('reports nothing once the slot is in scope', () => {
    const env = { ...PRODUCTION, [STACK_SLOT_VARIABLE]: '0' };

    expect(slotDefectsOf(stepRunning('pnpm build', env))).toEqual([]);
  });

  it('leaves a step alone under a mode whose generated file carries the slot', () => {
    const env = { [ENV_MODE_VARIABLE]: 'test' };

    expect(slotDefectsOf(stepRunning(FILTERED_COMMAND, env))).toEqual([]);
  });

  it('leaves a step alone whose command reaches the wrapper nowhere', () => {
    expect(slotDefectsOf(stepRunning('pnpm verify:bundle', PRODUCTION))).toEqual([]);
  });

  it('leaves a step alone whose wrapper selects a mode that writes stack files', () => {
    expect(slotDefectsOf(stepRunning('pnpm catalog:refresh:e2e', PRODUCTION))).toEqual([]);
  });

  it('reports a step whose wrapper selects the mode that writes none', () => {
    const env = { [ENV_MODE_VARIABLE]: 'test' };
    const run = `tsx ${ENV_WRAPPER} --env-mode production tsx scripts/some-work.ts`;

    expect(slotDefectsOf(stepRunning(run, env))).toEqual([REFUSAL]);
  });

  it('still reaches the wrapper from every step known to need a slot', () => {
    expect(
      slotRequiringSteps(),
      'the resolver no longer follows these commands to the env wrapper, so the case below asserts over less than it claims'
    ).toEqual(expect.arrayContaining([...KNOWN_SLOT_REQUIRING_STEPS]));
  });

  it('is named by the job or the step that needs it', () => {
    const defects = workflowSteps().flatMap((step) =>
      slotDefectsOf(step).map((defect) => `${identify(step)} ${defect}`)
    );

    expect(
      defects,
      `these steps refuse at ${STACK_SLOT_VARIABLE}: ${JSON.stringify(defects)}. The wrapper claims a run before it spawns anything and the claim names a slot, which the mode that writes no stack files has no generated file to carry. Give the job or the step \`${STACK_SLOT_VARIABLE}: '0'\` beside its ${ENV_MODE_VARIABLE}`
    ).toEqual([]);
  });
});
