import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { manifestScripts, referencedScriptAt, rootScripts, tokensOf } from './lib/root-manifest.js';
import { getWorkspacePaths } from './lib/cli/workspaces.js';
import { parseCliArgs } from './ensure-stack-cli.js';
import { parseArgs, stackModeFor } from './generate-env.js';
import { parseEnvModeSelection } from './with-env.js';
import { GROUP_SEPARATOR } from './run-checks.js';
import { STAGE_SEPARATOR } from './with-run-claim.js';
import { ENV_MODES, ENV_MODE_VARIABLE, stackModeFrom } from './lib/stack/stack-mode.js';
import type { StackMode } from './lib/stack/port-plan.js';
import type { EnvMode } from '@hushbox/shared';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

interface StackWrapper {
  /** The module a manifest token names when it invokes the wrapper. */
  readonly entry: string;
  /**
   * The stack this wrapper takes from the arguments written after it, read by
   * the wrapper's own reader. `undefined` where the reader takes none, which is
   * the case where the wrapper falls back to the stack the environment it
   * inherited names.
   */
  readonly selectionFrom: (tokens: readonly string[]) => StackMode | undefined;
  /**
   * Whether the stack it resolves survives into the commands it runs. The
   * criterion is what the wrapper runs after resolving, not what it loads: the
   * env wrapper loads the stack's generated files and then spawns the command
   * under them, so its choice is inherited; the stack CLI loads them too but is
   * a leaf that runs no later stage, so what it loads dies with its process;
   * the chain wrapper deliberately loads none, leaving its stages the
   * environment they were handed. A command after either of the last two starts
   * from the default again — which is why a stage of a mode-scoped chain has to
   * name the mode for itself.
   */
  readonly carriesInto: boolean;
}

/** The stack a selected mode runs, where the arguments selected one. */
function stackOf(envMode: EnvMode | undefined): StackMode | undefined {
  return envMode === undefined ? undefined : stackModeFor(envMode);
}

/**
 * The wrappers that take their stack from the arguments written after them: the
 * env wrapper loads that stack's generated files, the stack CLI prepares its
 * containers and volumes, and the chain wrapper claims its slot. Each carries
 * the reader it actually uses, because the three do not agree: the env and
 * chain wrappers share {@link parseEnvModeSelection}, which takes a selection
 * only where it leads and leaves everything from the command word on to the
 * command, while the stack CLI's {@link parseCliArgs} finds the flag anywhere
 * in its arguments. All three answer with no selection where their arguments
 * name none, which is what leaves the stack the environment already names as
 * the answer.
 */
const STACK_WRAPPERS: readonly StackWrapper[] = [
  {
    entry: 'scripts/with-env.ts',
    selectionFrom: (tokens) => stackOf(parseEnvModeSelection(tokens).envMode),
    carriesInto: true,
  },
  {
    entry: 'scripts/ensure-stack-cli.ts',
    selectionFrom: (tokens) => {
      const named = parseCliArgs(tokens).envMode;
      return named === undefined ? undefined : stackModeFor(named);
    },
    carriesInto: false,
  },
  {
    entry: 'scripts/with-run-claim.ts',
    selectionFrom: (tokens) => stackOf(parseEnvModeSelection(tokens).envMode),
    carriesInto: false,
  },
];

/** The tree that holds the env loader, and so every script that can call it. */
const SCRIPTS_DIR = 'scripts';

/** A call to the env loader, as opposed to an import of it or a link to it. */
const ENV_LOAD_CALL = /(?<![\w.])loadEnvironment\s*\(/;

function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFilesUnder(child);
    return entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')
      ? [child]
      : [];
  });
}

/**
 * The scripts that load a stack's env files for themselves instead of being
 * wrapped. They name no stack, so each one addresses whatever stack the
 * environment it inherited already names — the default, wherever nothing named
 * one. Derived from the sources so a script written this way later is seen
 * without anyone having listed it.
 */
function selfLoadingScripts(): string[] {
  return sourceFilesUnder(path.join(REPO_ROOT, SCRIPTS_DIR))
    .filter((file) => ENV_LOAD_CALL.test(readFileSync(file, 'utf8')))
    .map((file) => path.relative(REPO_ROOT, file).split(path.sep).join('/'))
    .filter((file) => !STACK_WRAPPERS.some((wrapper) => wrapper.entry === file));
}

const SELF_LOADING_SCRIPTS = selfLoadingScripts();

/**
 * Every way a root script runs one command after another in a process of its
 * own. Three spellings stand in the manifest — the chain wrapper's separator,
 * the shell conjunction, and the check runner's group marker — and a stage of
 * any of them resolves its own stack, so all three split.
 */
const STAGE_SEPARATORS = [STAGE_SEPARATOR, '&&', GROUP_SEPARATOR] as const;

/**
 * The same three, listed again rather than read from {@link STAGE_SEPARATORS},
 * because a case driven by that set would lose its subject along with the
 * separator dropped from it. Dropping one leaves the case "reads the stages
 * `%s` sequences as separate" asserting that a chain sequenced by it splits,
 * which is what fails.
 */
const KNOWN_STAGE_SEPARATORS: readonly string[] = [STAGE_SEPARATOR, '&&', GROUP_SEPARATOR];

/**
 * The stack a command addresses when nothing names one — not its own
 * arguments, and not the environment it was handed.
 */
const DEFAULT_STACK: StackMode = stackModeFrom({});

/**
 * Root scripts known to run every stage on the end-to-end stack. The
 * derivation finds them on its own; this list is the non-vacuity floor, so a
 * discovery bug that narrows the derived set to nothing cannot pass silently.
 */
const KNOWN_E2E_CHAINS: readonly string[] = ['e2e', 'e2e:prepare', 'e2e:quick', 'e2e:fast'];

/** Root scripts known to run every stage on the development stack. */
const KNOWN_DEVELOPMENT_CHAINS: readonly string[] = ['dev', 'db:up'];

/**
 * Root scripts known to run every stage on the test stack. The suite is what
 * that stack exists for, so a chain of it reading the development stack's data
 * plane is the defect this list keeps derivable.
 */
const KNOWN_TEST_CHAINS: readonly string[] = ['test', 'test:all', 'test:api'];

/** The separate processes a body runs, whichever separator sequences them. */
function stagesOf(body: string): string[] {
  const tokens = tokensOf(body);
  const stages: string[][] = [[]];
  for (const token of tokens) {
    if ((STAGE_SEPARATORS as readonly string[]).includes(token)) stages.push([]);
    else stages.at(-1)?.push(token);
  }
  return stages.map((stage) => stage.join(' '));
}

/**
 * The stack a wrapper addresses, given the arguments after it and the stack the
 * environment it inherited already names — which is what it loads when its own
 * reader takes no selection from those arguments.
 */
function selectionAfter(
  wrapper: StackWrapper,
  tokens: readonly string[],
  inherited: StackMode
): StackMode {
  return wrapper.selectionFrom(tokens) ?? inherited;
}

/**
 * Every stack a body addresses, counted once per command that addresses one.
 *
 * A body is read the way it runs: split into stages, and each stage read left
 * to right and followed through the root scripts it delegates to, carrying the
 * stack the environment names at that point.
 */
function stacksAddressedBy(
  body: string,
  scripts: Readonly<Record<string, string>>,
  seen: ReadonlySet<string> = new Set(),
  inherited: StackMode = DEFAULT_STACK
): StackMode[] {
  return stagesOf(body).flatMap((stage) => stacksAddressedByStage(stage, scripts, seen, inherited));
}

/** A stage being read left to right, stopped at one of its tokens. */
interface StageStep {
  readonly tokens: readonly string[];
  readonly index: number;
  readonly scripts: Readonly<Record<string, string>>;
  /** The root scripts already being followed, so a cycle terminates. */
  readonly seen: ReadonlySet<string>;
  /** The stack the environment names by this point in the stage. */
  readonly carried: StackMode;
}

function stacksAddressedByStage(
  stage: string,
  scripts: Readonly<Record<string, string>>,
  seen: ReadonlySet<string>,
  inherited: StackMode
): StackMode[] {
  const tokens = tokensOf(stage);
  const stacks: StackMode[] = [];
  let carried = inherited;
  for (const index of tokens.keys()) {
    const step = stepThrough({ tokens, index, scripts, seen, carried });
    stacks.push(...step.stacks);
    carried = step.carried;
  }
  return stacks;
}

/** One token of a stage: what it addresses, and the stack it leaves behind. */
function stepThrough(step: StageStep): { stacks: StackMode[]; carried: StackMode } {
  const token = step.tokens[step.index] ?? '';
  const wrapper = STACK_WRAPPERS.find(({ entry }) => token.endsWith(entry));
  if (wrapper !== undefined) {
    const addressed = selectionAfter(wrapper, step.tokens.slice(step.index + 1), step.carried);
    return { stacks: [addressed], carried: wrapper.carriesInto ? addressed : step.carried };
  }
  if (SELF_LOADING_SCRIPTS.some((entry) => token.endsWith(entry))) {
    return { stacks: [step.carried], carried: step.carried };
  }
  const delegated = delegatedBody(step);
  if (delegated === undefined) return { stacks: [], carried: step.carried };
  const under = new Set([...step.seen, delegated.name]);
  return {
    stacks: stacksAddressedBy(delegated.body, step.scripts, under, step.carried),
    carried: step.carried,
  };
}

/**
 * The body a stage token delegates to, if it delegates at all, with that
 * token's trailing arguments already appended — which is where a package
 * manager puts a caller's arguments, and what makes
 * `pnpm ensure-stack --env-mode e2e` reach the stack CLI as a selection rather
 * than as an argument nothing reads.
 */
function delegatedBody(step: StageStep): { name: string; body: string } | undefined {
  const { tokens, index, scripts, seen } = step;
  const referenced = referencedScriptAt(tokens, index, scripts);
  if (referenced === undefined || seen.has(referenced.name)) return undefined;
  return { name: referenced.name, body: [referenced.body, ...tokens.slice(index + 2)].join(' ') };
}

function sortedStacks(stacks: readonly StackMode[]): StackMode[] {
  return [...new Set(stacks)].toSorted((left, right) => left.localeCompare(right));
}

function stacksOf(
  body: string,
  scripts: Readonly<Record<string, string>>,
  inherited: StackMode = DEFAULT_STACK
): StackMode[] {
  return sortedStacks(stacksAddressedBy(body, scripts, new Set(), inherited));
}

describe('the stacks a root script addresses', () => {
  it('still reads the stack out of every chain known to name one', () => {
    const scripts = rootScripts();
    const derived = Object.fromEntries(
      [...KNOWN_E2E_CHAINS, ...KNOWN_TEST_CHAINS, ...KNOWN_DEVELOPMENT_CHAINS].map((name) => [
        name,
        stacksOf(scripts[name] ?? '', scripts),
      ])
    );

    expect(
      derived,
      'the derivation no longer reads a stack out of these chains, so the cases below assert over less than they claim'
    ).toEqual({
      ...Object.fromEntries(KNOWN_E2E_CHAINS.map((name) => [name, ['e2e']])),
      ...Object.fromEntries(KNOWN_TEST_CHAINS.map((name) => [name, ['test']])),
      ...Object.fromEntries(KNOWN_DEVELOPMENT_CHAINS.map((name) => [name, [DEFAULT_STACK]])),
    });
  });

  it('still finds every script that loads a stack for itself', () => {
    expect(
      SELF_LOADING_SCRIPTS,
      'the derivation no longer reaches these scripts, so a stage that runs one of them reads as addressing no stack at all'
    ).toEqual(
      expect.arrayContaining([
        'scripts/generate-assets.ts',
        'scripts/generate-screenshots.ts',
        'scripts/test-watch.ts',
      ])
    );
  });

  it.each(KNOWN_STAGE_SEPARATORS)('reads the stages `%s` sequences as separate', (separator) => {
    const scripts = {
      'a-chain': `tsx scripts/with-env.ts --env-mode e2e tsx scripts/some-work.ts ${separator} tsx scripts/with-env.ts tsx scripts/other-work.ts`,
    };

    expect(
      stacksOf(scripts['a-chain'], scripts),
      `a chain sequenced by \`${separator}\` reads as one process, so a stage after it inherits the stack the stage before it named and a chain leaking across it reads as running on one stack`
    ).toEqual([DEFAULT_STACK, 'e2e']);
  });

  // What the case "runs every stage of a root script against one stack"
  // asserts is an empty list, which a derivation that reads nothing also
  // produces. This case is the other half of that non-vacuity floor: a stage
  // written without its selection, inside a chain that names one, is still
  // recognised as addressing the wrong stack.
  it('still recognises a stage that leaves the chain stack unnamed', () => {
    const scripts = {
      'a-chain': `tsx scripts/with-run-claim.ts --env-mode e2e pnpm a-stage ${STAGE_SEPARATOR} tsx scripts/with-env.ts --env-mode e2e tsx scripts/some-work.ts`,
      'a-stage': 'tsx scripts/with-env.ts tsx scripts/other-work.ts',
    };

    expect(stacksOf(scripts['a-chain'], scripts)).toEqual([DEFAULT_STACK, 'e2e']);
  });

  it('still recognises a stage that loads the environment for itself', () => {
    const scripts = {
      'a-chain': `tsx scripts/with-run-claim.ts --env-mode e2e pnpm a-stage ${STAGE_SEPARATOR} tsx scripts/with-env.ts --env-mode e2e tsx scripts/some-work.ts`,
      'a-stage': 'tsx scripts/generate-assets.ts',
    };

    expect(stacksOf(scripts['a-chain'], scripts)).toEqual([DEFAULT_STACK, 'e2e']);
  });

  it('reads one stack from a self-loading script the env wrapper runs', () => {
    const scripts = {
      'a-chain': 'tsx scripts/with-env.ts --env-mode e2e tsx scripts/generate-assets.ts',
    };

    expect(stacksOf(scripts['a-chain'], scripts)).toEqual(['e2e']);
  });

  it('reads the selection the stack CLI takes from anywhere in its arguments', () => {
    const scripts = {
      'a-chain': `tsx scripts/with-run-claim.ts pnpm a-stage ${STAGE_SEPARATOR} tsx scripts/with-env.ts tsx scripts/some-work.ts`,
      'a-stage': 'tsx scripts/ensure-stack-cli.ts --quiet --env-mode e2e',
    };

    expect(stacksOf(scripts['a-chain'], scripts)).toEqual([DEFAULT_STACK, 'e2e']);
  });

  it('reads one stack from a chain whose stack CLI names it late', () => {
    const scripts = {
      'a-chain': `tsx scripts/with-run-claim.ts --env-mode e2e pnpm a-stage ${STAGE_SEPARATOR} tsx scripts/with-env.ts --env-mode e2e tsx scripts/some-work.ts`,
      'a-stage': 'tsx scripts/ensure-stack-cli.ts --quiet --env-mode e2e',
    };

    expect(stacksOf(scripts['a-chain'], scripts)).toEqual(['e2e']);
  });

  it('reads the stack CLI as addressing the stack the environment names where nothing names one', () => {
    const scripts = { 'a-chain': 'tsx scripts/ensure-stack-cli.ts --quiet' };

    expect(stacksOf(scripts['a-chain'], scripts, 'e2e')).toEqual(['e2e']);
  });

  it('ignores a selection written after the command in the wrappers that read only a leading one', () => {
    const scripts = {
      'a-chain':
        'tsx scripts/with-run-claim.ts tsx scripts/with-env.ts tsx scripts/some-work.ts --env-mode e2e',
    };

    expect(stacksOf(scripts['a-chain'], scripts)).toEqual([DEFAULT_STACK]);
  });

  it('reads one stack from the same chain once the stage names it', () => {
    const scripts = {
      'a-chain': `tsx scripts/with-run-claim.ts --env-mode e2e pnpm a-stage ${STAGE_SEPARATOR} tsx scripts/with-env.ts --env-mode e2e tsx scripts/some-work.ts`,
      'a-stage': 'tsx scripts/with-env.ts --env-mode e2e tsx scripts/other-work.ts',
    };

    expect(stacksOf(scripts['a-chain'], scripts)).toEqual(['e2e']);
  });

  it('runs every stage of a root script against one stack', () => {
    const scripts = rootScripts();
    const mixed = Object.entries(scripts)
      .map(([name, body]) => ({ name, stacks: stacksOf(body, scripts) }))
      .filter((script) => script.stacks.length > 1);

    expect(
      mixed,
      `these root scripts address more than one stack: ${JSON.stringify(mixed)}. A stage that names no stack loads the default one, so a chain that names another reaches into that stack's data plane for the length of that stage. Name the chain's stack on every stage of it, leading, as \`--env-mode <mode>\``
    ).toEqual([]);
  });
});

/**
 * Where the continuous-integration jobs live. Every file in it is read rather
 * than a named one, so a job put in a workflow of its own is checked without
 * anyone having listed it.
 */
const WORKFLOWS_DIR = path.join('.github', 'workflows');

/** The root script a step runs to write a stack's generated env files. */
const GENERATOR_SCRIPT = 'generate:env';

/**
 * As much of a workflow as the stack question needs: the steps that run
 * commands, and the env block a job states once for all of them.
 */
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
 * The arguments of one invocation inside a step's shell fragment. A step runs
 * more than one command, and the words of the next one are not arguments of
 * this one, so the reading stops at the first word carrying no leading dash.
 */
function argumentsAfter(tokens: readonly string[], index: number): string[] {
  const rest = tokens.slice(index + 1);
  const next = rest.findIndex((token) => !token.startsWith('-'));
  return next === -1 ? [...rest] : rest.slice(0, next);
}

/**
 * The stacks a job writes generated env files for.
 *
 * A job that writes none still addresses one — the stack whose files carry no
 * mode in their names — so it answers with that rather than with nothing, and
 * a job that never heard of the mode split reads as the stack it always ran on.
 */
function stacksGeneratedBy(job: WorkflowJob): StackMode[] {
  const generated = (job.steps ?? []).flatMap((step) => {
    const tokens = tokensOf(step.run ?? '');
    return tokens.flatMap((token, index) =>
      token.endsWith(GENERATOR_SCRIPT)
        ? [stackModeFor(parseArgs(argumentsAfter(tokens, index)))]
        : []
    );
  });
  return generated.length === 0 ? [DEFAULT_STACK] : sortedStacks(generated);
}

/**
 * The stack a declared value runs, where the value names a mode at all.
 *
 * The selector carries an env mode, so the stack is derived rather than read:
 * the mode that runs no stack still resolves the one its port allocation comes
 * from, which is what a job declaring it addresses.
 *
 * The comparison stays over stacks rather than over the modes themselves
 * because one job legitimately serves two modes that share a stack: the
 * continuous-integration test job generates under `--mode=test` on a pull
 * request and `--mode=ciVitest` otherwise, chosen by a condition no static
 * reader can evaluate, so an equality over modes reports a defect there that is
 * not one. What mapping to stacks costs is that a declaration resolving the
 * default stack — production's does — cannot fail here; the assertion that
 * covers those is in `scripts/ci-workflow.test.ts`.
 */
function stackOfDeclaredMode(value: string): StackMode | undefined {
  return (ENV_MODES as readonly string[]).includes(value)
    ? stackModeFor(value as EnvMode)
    : undefined;
}

/**
 * The stacks a job states to the steps that run under it.
 *
 * A step is a process of its own and inherits nothing from the step before it,
 * so the variable a generated scripts file would have carried has to be stated
 * in the job's own env block instead. Where the value is a workflow expression
 * the job runs under whichever of its quoted literals names a stack, so all of
 * them count as stated.
 */
function stacksDeclaredBy(job: WorkflowJob): StackMode[] {
  const declared = job.env?.[ENV_MODE_VARIABLE];
  if (declared === undefined) return [DEFAULT_STACK];
  if (typeof declared !== 'string') return [];
  const named = stackOfDeclaredMode(declared);
  if (named !== undefined) return [named];
  const literals = [...declared.matchAll(/'([^']*)'/g)].map(([, literal]) => literal ?? '');
  return sortedStacks(
    literals.flatMap((literal) => {
      const stack = stackOfDeclaredMode(literal);
      return stack === undefined ? [] : [stack];
    })
  );
}

/** The command a step leads with, for a message that names the step it is about. */
function leadCommandOf(run: string): string {
  return (run.split('\n').find((line) => line.trim().length > 0) ?? '').trim();
}

/**
 * What a job gets wrong about the stack it runs against.
 *
 * A job states its stack twice: to the generator, which writes that stack's env
 * files, and to its steps, which read them. Both statements must name the same
 * stack, and under it every step must address that stack alone — a step
 * addressing another reads files this job never wrote, which on a runner is an
 * empty environment rather than a wrong one, because nothing there generates
 * the files a developer's checkout already has.
 */
function stackDefectsOf(job: WorkflowJob, scripts: Readonly<Record<string, string>>): string[] {
  const declared = stacksDeclaredBy(job);
  const generated = stacksGeneratedBy(job);
  const mismatch =
    declared.join(' ') === generated.join(' ')
      ? []
      : [
          `states ${ENV_MODE_VARIABLE}=${declared.join(' ') || '(none)'} to its steps but generates env files for ${generated.join(' ')}`,
        ];
  const strays = declared.flatMap((stack) =>
    (job.steps ?? []).flatMap((step) => {
      const addressed = stacksOf(step.run ?? '', scripts, stack).filter((one) => one !== stack);
      return addressed.length === 0
        ? []
        : [`under ${stack}, \`${leadCommandOf(step.run ?? '')}\` addresses ${addressed.join(' ')}`];
    })
  );
  return [...mismatch, ...strays];
}

/**
 * The root script that runs the stack CLI, whose body a runner never reaches:
 * the CLI returns at its `CI` guard before it generates, brings up or wipes
 * anything, so a step that runs it prepares no stack and loads no stack's
 * files. Named here so the workflow cases read the manifest the way a runner
 * runs it, and asserted below so a rename cannot leave that quietly untrue.
 *
 * It is the root script that is emptied, not the module: a step written as a
 * direct invocation of the module is still read as addressing the stack the CLI
 * would prepare, and reported. No step is written that way, and being reported
 * for one that is errs on the loud side.
 */
const INERT_IN_CI_SCRIPT = 'ensure-stack';

/** The stack CLI's own module, as a manifest token names it. */
const STACK_CLI_ENTRY = 'scripts/ensure-stack-cli.ts';

function scriptsAsARunnerRunsThem(
  scripts: Readonly<Record<string, string>>
): Record<string, string> {
  return { ...scripts, [INERT_IN_CI_SCRIPT]: '' };
}

describe('the stack a workflow job runs against', () => {
  it('still names the script a runner runs for no effect', () => {
    expect(
      rootScripts()[INERT_IN_CI_SCRIPT],
      'the stack CLI is reached under another name now, so emptying this one hides nothing and the cases below read a body a runner never runs'
    ).toContain(STACK_CLI_ENTRY);
  });

  it('still finds every job that generates a stack other than the default', () => {
    const named = workflowJobs()
      .map(({ file, name, job }) => ({ where: `${file} ${name}`, stacks: stacksGeneratedBy(job) }))
      .filter(({ stacks }) => stacks.some((stack) => stack !== DEFAULT_STACK))
      .map(({ where, stacks }) => `${where} -> ${stacks.join(' ')}`);

    expect(
      named,
      'the derivation no longer reads a generated stack out of these jobs, so the case below asserts over less than it claims'
    ).toEqual(
      expect.arrayContaining([
        '.github/workflows/ci.yml test -> test',
        '.github/workflows/ci.yml e2e -> e2e',
        '.github/workflows/ci.yml mobile-test -> e2e',
      ])
    );
  });

  it('runs every step of a job against the stack that job generated', () => {
    const scripts = scriptsAsARunnerRunsThem(rootScripts());
    const defects = workflowJobs().flatMap(({ file, name, job }) =>
      stackDefectsOf(job, scripts).map((defect) => `${file} ${name} ${defect}`)
    );

    expect(
      defects,
      `these jobs run a step against a stack other than their own: ${JSON.stringify(defects)}. A step is a process of its own, so it reads whichever stack's generated files ${ENV_MODE_VARIABLE} names, and a runner generates only the stack its job asked for. State the job's stack once in its env block, as ${ENV_MODE_VARIABLE}`
    ).toEqual([]);
  });

  it('reports a step left to the default stack in a job that generated another', () => {
    const job: WorkflowJob = {
      steps: [{ run: 'pnpm generate:env --mode=ciE2E' }, { run: 'pnpm db:migrate' }],
    };

    expect(stackDefectsOf(job, scriptsAsARunnerRunsThem(rootScripts()))).toEqual([
      `states ${ENV_MODE_VARIABLE}=development to its steps but generates env files for e2e`,
    ]);
  });

  it('reports nothing once that job states the stack it generated', () => {
    const job: WorkflowJob = {
      env: { [ENV_MODE_VARIABLE]: 'e2e' },
      steps: [{ run: 'pnpm generate:env --mode=ciE2E' }, { run: 'pnpm db:migrate' }],
    };

    expect(stackDefectsOf(job, scriptsAsARunnerRunsThem(rootScripts()))).toEqual([]);
  });

  it('reads a job declaring the mode that runs no stack', () => {
    const job: WorkflowJob = {
      env: { [ENV_MODE_VARIABLE]: 'production' },
      steps: [{ run: 'pnpm generate:env --mode=production' }, { run: 'pnpm build' }],
    };

    expect(stackDefectsOf(job, scriptsAsARunnerRunsThem(rootScripts()))).toEqual([]);
  });

  it('reports a step that names a stack its job does not run', () => {
    const job: WorkflowJob = { steps: [{ run: 'pnpm db:seed:e2e' }] };

    expect(stackDefectsOf(job, scriptsAsARunnerRunsThem(rootScripts()))).toEqual([
      'under development, `pnpm db:seed:e2e` addresses e2e',
    ]);
  });
});

/**
 * The flag a command names a build's mode under. A build's mode decides which
 * generated frontend env file it bakes, and that file is a build's sole supply,
 * so a mode named on a command line is a stack chosen there — beside, and free
 * to disagree with, the one the environment names.
 */
const MODE_FLAG = '--mode';

/**
 * Whether a token names the mode, in either spelling the bundlers accept. Both
 * `--mode production` and `--mode=production` set it, and the equals form is
 * this repository's own house spelling for the flag, so a check on the bare
 * token would admit the shape a future edit is likelier to write.
 */
function namesTheMode(token: string): boolean {
  return token === MODE_FLAG || token.startsWith(`${MODE_FLAG}=`);
}

/** The site builder, as a command names it. */
const SITE_BUILDER = 'astro';

/**
 * The entry a site build names instead of the site builder.
 *
 * The site builder takes its mode from its command line alone, so a build that
 * names it directly resolves whatever default that command carries — which is
 * the production default for every build command, whatever stack the
 * environment names. The entry is where the derivation reaches a site build.
 */
const SITE_BUILD_ENTRY = 'scripts/build-marketing-site.ts';

/** The derivation a bundler configuration calls to resolve its own mode. */
const MODE_DERIVATION = 'buildEnvMode';

/** The guard that fails a build whose mode names a file that is not there. */
const MISSING_FILE_GUARD = 'frontendEnvFilePlugin';

/**
 * The marketing package's build scripts, named here rather than derived from
 * its manifest, because the second of them is the reason the derivation cannot
 * ride a pass-through argument at all: a pass-through reaches a task only when
 * its name matches a requested task name, and `admin-preview:build` is never
 * requested — it runs as a dependency of the admin origin's assets. So that
 * task can receive no mode however it is invoked, and a derivation that reached
 * every other build through the pass-through would leave it alone and silent.
 */
const SITE_BUILD_SCRIPTS: readonly string[] = ['build', 'admin-preview:build'];

/** The marketing package's manifest, which {@link SITE_BUILD_SCRIPTS} names. */
const SITE_MANIFEST = 'apps/marketing/package.json';

/**
 * What a command gets wrong about the mode its build resolves.
 *
 * Two shapes, and a rule that refused only the first would leave every command
 * in the second unchanged: a mode written on the command line overrides the
 * derivation, and a site builder named directly reaches no derivation at all.
 */
function buildModeDefectsIn(where: string, body: string): string[] {
  const tokens = tokensOf(body);
  const defects: string[] = [];
  if (tokens.includes('build') && tokens.some((token) => namesTheMode(token))) {
    defects.push(
      `${where} names a build's mode on its command line; the mode is derived from ${ENV_MODE_VARIABLE}`
    );
  }
  if (
    tokens.some((token, index) => token.endsWith(SITE_BUILDER) && tokens[index + 1] === 'build')
  ) {
    defects.push(`${where} runs the site builder directly instead of ${SITE_BUILD_ENTRY}`);
  }
  return defects;
}

/** What a bundler configuration gets wrong about the mode its build resolves. */
function bundlerConfigDefectsIn(where: string, source: string, derivesItsOwn: boolean): string[] {
  const defects: string[] = [];
  if (!source.includes(MISSING_FILE_GUARD)) {
    defects.push(`${where} does not call ${MISSING_FILE_GUARD}, so a missing env file passes`);
  }
  if (derivesItsOwn && !source.includes(MODE_DERIVATION)) {
    defects.push(`${where} does not call ${MODE_DERIVATION}, so its build takes a default mode`);
  }
  return defects;
}

/** Every command the repository's manifests and workflow jobs run. */
function everyCommand(): { where: string; body: string }[] {
  const manifests = [
    'package.json',
    ...getWorkspacePaths(REPO_ROOT).map((dir) => `${dir}/package.json`),
  ];
  const fromManifests = manifests.flatMap((file) =>
    Object.entries(manifestScripts(file)).map(([name, body]) => ({
      where: `${file} ${name}`,
      body,
    }))
  );
  const fromWorkflows = workflowJobs().flatMap(({ file, name, job }) =>
    (job.steps ?? []).map((step) => ({ where: `${file} ${name}`, body: step.run ?? '' }))
  );
  return [...fromManifests, ...fromWorkflows];
}

/**
 * The bundler configuration each buildable package's build resolves, and
 * whether the mode is derived there. A site build derives on its command line
 * instead, for the reason {@link SITE_BUILD_ENTRY} states, so its configuration
 * carries the guard alone.
 */
interface BundlerConfig {
  readonly file: string;
  /** Whether the mode is derived in the configuration rather than on the command line. */
  readonly derivesItsOwn: boolean;
}

function bundlerConfigs(): BundlerConfig[] {
  return getWorkspacePaths(REPO_ROOT).flatMap((dir): BundlerConfig[] => {
    const bodies = Object.values(manifestScripts(`${dir}/package.json`));
    const runsBundler = bodies.some((body) => {
      const tokens = tokensOf(body);
      return tokens.some((token, index) => token.endsWith('vite') && tokens[index + 1] === 'build');
    });
    if (runsBundler) return [{ file: `${dir}/vite.config.ts`, derivesItsOwn: true }];
    return bodies.some((body) => body.includes(SITE_BUILD_ENTRY))
      ? [{ file: `${dir}/astro.config.mjs`, derivesItsOwn: false }]
      : [];
  });
}

describe('the mode a build resolves', () => {
  it('refuses a mode typed onto a build command', () => {
    expect(buildModeDefectsIn('a-package build', 'vite build --mode production')).toEqual([
      `a-package build names a build's mode on its command line; the mode is derived from ${ENV_MODE_VARIABLE}`,
    ]);
  });

  it('refuses a mode attached to the flag with an equals sign', () => {
    expect(buildModeDefectsIn('a-package build', 'vite build --mode=production')).toEqual([
      `a-package build names a build's mode on its command line; the mode is derived from ${ENV_MODE_VARIABLE}`,
    ]);
  });

  it('refuses a site build that names no derivation', () => {
    expect(
      buildModeDefectsIn('a-package build', 'tsx ../../scripts/with-env.ts astro build')
    ).toEqual([`a-package build runs the site builder directly instead of ${SITE_BUILD_ENTRY}`]);
  });

  it('takes a build that derives its mode', () => {
    expect(buildModeDefectsIn('a-package build', 'vite build')).toEqual([]);
    expect(
      buildModeDefectsIn(
        'a-package build',
        `tsx ../../scripts/with-env.ts tsx ../../${SITE_BUILD_ENTRY}`
      )
    ).toEqual([]);
  });

  it('refuses a bundler configuration that derives no mode', () => {
    expect(
      bundlerConfigDefectsIn('a-config', `plugins: [${MISSING_FILE_GUARD}(root)]`, true)
    ).toEqual([`a-config does not call ${MODE_DERIVATION}, so its build takes a default mode`]);
  });

  it('refuses a bundler configuration that lets a missing env file pass', () => {
    expect(
      bundlerConfigDefectsIn('a-config', `const mode = ${MODE_DERIVATION}(process.env)`, true)
    ).toEqual([`a-config does not call ${MISSING_FILE_GUARD}, so a missing env file passes`]);
  });

  it('takes a bundler configuration that does both', () => {
    expect(
      bundlerConfigDefectsIn(
        'a-config',
        `const mode = ${MODE_DERIVATION}(process.env); plugins: [${MISSING_FILE_GUARD}(root)]`,
        true
      )
    ).toEqual([]);
  });

  it('derives its mode in every command the repository runs', () => {
    const defects = everyCommand().flatMap(({ where, body }) => buildModeDefectsIn(where, body));

    expect(
      defects,
      `these commands decide a build's mode for themselves: ${JSON.stringify(defects)}. A build's mode names the generated env file it bakes, which is its sole supply, so a mode named on a command line is a stack chosen beside the one ${ENV_MODE_VARIABLE} names`
    ).toEqual([]);
  });

  it('derives its mode in every bundler configuration', () => {
    const configs = bundlerConfigs();
    const defects = configs.flatMap(({ file, derivesItsOwn }) =>
      bundlerConfigDefectsIn(file, readFileSync(path.join(REPO_ROOT, file), 'utf8'), derivesItsOwn)
    );

    expect(
      configs.map(({ file }) => file),
      'the derivation no longer reads a bundler configuration out of the manifests, so the case below asserts over less than it claims'
    ).toEqual(
      expect.arrayContaining([
        'apps/web/vite.config.ts',
        'apps/admin/vite.config.ts',
        'apps/marketing/astro.config.mjs',
      ])
    );
    expect(defects).toEqual([]);
  });

  it('names the site build entry in every script that builds the site', () => {
    const scripts = manifestScripts(SITE_MANIFEST);

    expect(
      SITE_BUILD_SCRIPTS.map((name) => [name, (scripts[name] ?? '').includes(SITE_BUILD_ENTRY)])
    ).toEqual(SITE_BUILD_SCRIPTS.map((name) => [name, true]));
  });
});
