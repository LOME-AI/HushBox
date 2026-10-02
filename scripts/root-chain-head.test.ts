import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RUN_CLAIM_ENV } from './lib/claims/registry.js';
import { LIFELINE_ENV, killTree } from './lib/spawn/long-lived.js';
import {
  CHAIN_ANNOUNCEMENT_BUDGET_MS,
  CHAIN_CASE_TIMEOUT_MS,
  untilFileWritten,
  untilSettled,
} from './lib/bounded-wait.setup.js';
import { rootScripts, tokensOf } from './lib/root-manifest.js';
import { GROUP_SEPARATOR } from './run-checks.js';
import type { Readable } from 'node:stream';

/**
 * What a root script starts, and what dies with it.
 *
 * Everything below a spawner's own process holds a lifeline and goes when that
 * process goes. Nothing reaches a process *above* it: a command line that forks
 * and then waits is never told anything when it is killed hard, so it closes no
 * socket and the tree it forked lives on, reparented and unowned. The only
 * thing that removes that hazard is not having such a process, which is why a
 * root script's own module runs in the process the manifest starts rather than
 * in one a runner's command line forks from it.
 *
 * The rule is over every entry whose head launches one of our own, not over the
 * entries that start something long-lived. Which entries those are is a
 * judgement that would have to be made again every time one gained a server;
 * a rule quantified over all of them costs a word per entry and is something a
 * check can hold.
 *
 * The hop below is a different matter and is deliberately kept: the stage still
 * goes through the runner's command line, exactly as every root script runs
 * one, so the case that kills is killing the head of a chain that still has the
 * hops a real command has.
 */

/** The chain's own module, named the way a root script names it. */
const WRAPPER_ENTRY = 'scripts/with-run-claim.ts';

/**
 * What runs the chain's module in the process it is spawned as. The runner's
 * loader is asked for by name and applied in-process; its command line, asked
 * for the same file, forks instead and leaves itself standing above the result.
 */
const IN_PROCESS_LAUNCH: readonly string[] = ['node', '--import', 'tsx'];

/**
 * The words that launch one of our modules rather than run a program of their
 * own. A body starting with any other word is that program's, so the file
 * further along is its business rather than the entry's head.
 */
const LAUNCH_WORDS: ReadonlySet<string> = new Set(['node', 'tsx']);

/** What a launcher runs as a module, which is what makes a path one of our own scripts. */
const MODULE_SUFFIXES: readonly string[] = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs'];

/**
 * Root scripts known to head a chain. The derivation finds them itself; this
 * list is the non-vacuity floor, without which a renamed entry point narrows
 * the derived set to nothing and the case below passes over an empty list.
 */
const KNOWN_CHAINS: readonly string[] = ['dev', 'test', 'e2e', 'preview', 'mobile:test'];

/**
 * Root scripts known to launch one of our own at their head, which is the wider
 * rule's non-vacuity floor. It names a chain, the checks runner, the
 * environment wrapper and a file outside the scripts directory, so a derivation
 * that quietly narrowed to one launcher, one shape or one directory fails here
 * rather than passing over what is left.
 */
const KNOWN_LAUNCHERS: readonly string[] = [...KNOWN_CHAINS, 'dev:restart', 'db:seed', 'arch:scan'];

/** The wrapper that loads the environment, which hosts a lifeline of its own. */
const ENVIRONMENT_WRAPPER = 'scripts/with-env.ts';

/** The runner that heads the command a developer types when the stack is wedged. */
const CHECKS_RUNNER = 'scripts/run-checks.ts';

/**
 * The runner's own command line as a manifest would name it: a program the
 * launcher would run, rather than a module the runtime would load.
 */
const RUNNER_COMMAND = 'node_modules/.bin/tsx';

/** What the checks runner takes before the words of a lane: a separator and the lane's label. */
const CHECKS_LANE: readonly string[] = [GROUP_SEPARATOR, 'stage'];

/** The chain a case drives, taken from the manifest rather than written here. */
const DRIVEN_CHAIN = 'dev';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
/** The runner's command line, which is the hop every stage of every chain has. */
const TSX_CLI = fileURLToPath(new URL('../node_modules/.bin/tsx', import.meta.url));
/** Where the package manager puts a repository's own binaries for a script it runs. */
const LOCAL_BINARIES = fileURLToPath(new URL('../node_modules/.bin', import.meta.url));
const LEADER_ENTRY = fileURLToPath(new URL('lib/spawn/lifeline-leader-entry.mjs', import.meta.url));

/** The words a root script runs before, and including, the chain's own module. */
function headOf(body: string): string[] {
  const tokens = tokensOf(body);
  const entry = tokens.indexOf(WRAPPER_ENTRY);
  return entry === -1 ? [] : tokens.slice(0, entry + 1);
}

/** The root scripts that head a chain, by name. */
function chainScripts(): string[] {
  return Object.entries(rootScripts())
    .filter(([, body]) => headOf(body).length > 0)
    .map(([name]) => name);
}

/** Whether a word names a module this repository holds, rather than a flag or another tool. */
function isOwnScript(token: string): boolean {
  return (
    MODULE_SUFFIXES.some((suffix) => token.endsWith(suffix)) &&
    existsSync(path.join(REPO_ROOT, token))
  );
}

interface HeadLaunch {
  /** The words that run the file, which are what the rule below is about. */
  readonly launcher: string[];
  readonly file: string;
}

/**
 * What a root script launches at its head, or nothing where its head runs
 * something else — another tool, or the package manager.
 *
 * Derived from the manifest's own words against the files this repository
 * holds, so an entry added tomorrow is in the subject set without anyone
 * listing it. The first word decides membership and nothing after it does: a
 * body starting with a launcher is one this rule is about, and the file is the
 * first word naming one of our modules. Everything between the two is the
 * launcher, whatever shape it takes — which is what keeps a flag carrying its
 * value as a separate word inside the launcher, where the rule below judges it,
 * rather than letting it put the entry outside the subject set.
 */
function headLaunchOf(body: string): HeadLaunch | undefined {
  const tokens = tokensOf(body);
  const head = tokens[0];
  if (head === undefined || !LAUNCH_WORDS.has(head)) return undefined;
  const index = tokens.findIndex((token) => isOwnScript(token));
  const file = tokens[index];
  if (index < 1 || file === undefined) return undefined;
  return { launcher: tokens.slice(0, index), file };
}

/**
 * Whether a launcher applies the runner's loader in the process it starts.
 *
 * The loader asked for by name is applied in-process; the runner's own command
 * line, asked for the same file, forks and leaves itself standing above the
 * result. A runtime option sitting inside the launcher configures the very
 * process the manifest starts, so it changes what that process is rather than
 * how many there are, which is why anything may precede the loader here rather
 * than the launcher having to read word for word.
 *
 * The loader must be the last thing the launcher says. A word after it is what
 * runs the file, so the loader would be configuring a process that then forks —
 * which is the hazard wearing a runtime this rule accepts. The cost is that a
 * runtime option written after the loader reads as forking; it is a rejection,
 * so it names itself and the entry is rewritten with the option ahead.
 */
function launchesInProcess(launcher: readonly string[]): boolean {
  const [runtime, ...loader] = IN_PROCESS_LAUNCH;
  if (launcher[0] !== runtime) return false;
  const at = launcher.length - loader.length;
  return at > 0 && loader.every((word, offset) => launcher[at + offset] === word);
}

/** The root scripts whose head launches one of our own, by name. */
function launchingScripts(): string[] {
  return Object.entries(rootScripts())
    .filter(([, body]) => headLaunchOf(body) !== undefined)
    .map(([name]) => name);
}

/** The head words of a root script that launches `file`, as the manifest writes them. */
function headLaunching(file: string): string[] {
  for (const body of Object.values(rootScripts())) {
    const launch = headLaunchOf(body);
    if (launch?.file === file) return [...launch.launcher, launch.file];
  }
  throw new Error(`No root script launches ${file} at its head.`);
}

type ChainProcess = ChildProcessByStdio<null, Readable, null>;

interface StartedChain {
  /** The process the manifest's own words start, which is what a case kills. */
  readonly head: ChainProcess;
  /** The stage's parent: the runner's command line, which the chain still hops through. */
  readonly hop: number;
  readonly leader: number;
  readonly supervisor: number;
  /** The supervisor's task, in a group of its own, which no group signal reaches. */
  readonly task: number;
}

let chains: ChainProcess[];
let started: number[];
let scratchDir = '';
let claimDir = '';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

function waitForExit(child: ChainProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    child.once('exit', () => {
      resolve();
    });
  });
}

/** One id out of what a tree announced, refused unless it is one this file can watch. */
function announcedId(value: number | undefined, announced: string): number {
  if (value === undefined || !Number.isInteger(value) || value <= 1) {
    throw new Error(`The chain announced no id to watch. It said: ${announced}`);
  }
  return value;
}

/**
 * The environment a root script runs under, reproduced: the repository's own
 * binaries on the path, which is what the package manager puts there and what
 * lets the manifest's words name one.
 *
 * The claim points at a directory of this case's own, so the chain adopts a run
 * instead of registering one in the machine-wide registry. The lifeline address
 * is removed rather than emptied: the value this process inherited names the
 * chain hosting these tests, and leaving it would make each chain here a
 * watcher of that one rather than the head of its own.
 */
function chainEnvironment(): NodeJS.ProcessEnv {
  const inherited = Object.entries(process.env).filter(([name]) => name !== LIFELINE_ENV);
  return {
    ...Object.fromEntries(inherited),
    PATH: [LOCAL_BINARIES, process.env['PATH'] ?? ''].join(path.delimiter),
    [RUN_CLAIM_ENV]: claimDir,
    // Each chain answers on a socket under this case's own directory, so the
    // sockets of the processes it kills hard go when that directory goes.
    TMPDIR: scratchDir,
  };
}

/**
 * Starts a chain with the manifest's own head words and a stage of this file's
 * choosing, and resolves once the tree below has announced itself. `detached`
 * puts the head in a group of its own, so a case can address it alone.
 */
async function startChain(
  head: readonly string[],
  beforeStage: readonly string[] = []
): Promise<StartedChain> {
  const reportDir = await fs.mkdtemp(path.join(scratchDir, 'chain-'));
  const [file, ...args] = head;
  if (file === undefined) throw new Error(`No root script heads a chain with ${WRAPPER_ENTRY}.`);

  const chain = spawn(file, [...args, ...beforeStage, TSX_CLI, LEADER_ENTRY, reportDir], {
    cwd: REPO_ROOT,
    env: chainEnvironment(),
    stdio: ['ignore', 'pipe', 'inherit'],
    detached: true,
  });
  chains.push(chain);

  const announced = await untilFileWritten(
    path.join(reportDir, 'leader'),
    CHAIN_ANNOUNCEMENT_BUDGET_MS
  );
  const ids = announced.split(' ').map(Number);
  const leader = announcedId(ids[0], announced);
  const hop = announcedId(ids[1], announced);
  const supervisor = announcedId(ids[2], announced);
  const task = announcedId(
    Number(await untilFileWritten(path.join(reportDir, 'task'), CHAIN_ANNOUNCEMENT_BUDGET_MS)),
    'task'
  );
  started.push(hop, leader, supervisor, task);

  return { head: chain, hop, leader, supervisor, task };
}

beforeEach(async () => {
  scratchDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-chain-head-'));
  claimDir = path.join(scratchDir, 'run');
  await fs.mkdir(claimDir);
  chains = [];
  started = [];
  // Read empty so nothing a case spawns records itself against the claim of the
  // run hosting these tests.
  vi.stubEnv(RUN_CLAIM_ENV, '');
});

afterEach(async () => {
  // Ahead of the cleanup, because a cleanup that throws would otherwise skip it
  // and leave the worker without the claim this file was handed.
  vi.unstubAllEnvs();
  // Runs whether the case passed or failed, because a leak that only appears on
  // the unhappy path is the same leak. Every id here was watched being born by
  // this file, and each leads a group of its own.
  for (const pid of started) {
    if (Number.isInteger(pid) && pid > 1) killTree(pid, 'SIGKILL');
  }
  for (const chain of chains) {
    if (chain.pid !== undefined) killTree(chain.pid, 'SIGKILL');
    await waitForExit(chain);
  }
  await fs.rm(scratchDir, { recursive: true, force: true });
});

describe('the root scripts that head a chain', () => {
  it('still derives every root script known to head one', () => {
    const derived = new Set(chainScripts());

    expect(
      KNOWN_CHAINS.filter((name) => !derived.has(name)),
      `the derivation (a root script whose words reach ${WRAPPER_ENTRY}) no longer finds these, so the case below asserts over less than it claims`
    ).toEqual([]);
  });
});

describe('the root scripts that launch one of our own', () => {
  it('still derives every root script known to launch one', () => {
    const derived = new Set(launchingScripts());

    expect(
      KNOWN_LAUNCHERS.filter((name) => !derived.has(name)),
      "the derivation (a root script whose head words run one of this repository's own modules) no longer finds these, so the case below asserts over less than it claims"
    ).toEqual([]);
  });

  it('counts a head whose launcher takes a flag with a separate value', () => {
    const launch = headLaunchOf(`tsx --tsconfig tsconfig.json ${CHECKS_RUNNER}`);

    expect(
      launch?.launcher,
      'a launcher word followed by a flag and its value is still a launcher, so an entry written that way is one this rule is about rather than one it passes over'
    ).toEqual(['tsx', '--tsconfig', 'tsconfig.json']);
  });

  it('counts a launcher that sets a runtime option as launching in the process it starts', () => {
    expect(
      launchesInProcess(['node', '--enable-source-maps', '--import', 'tsx']),
      `a runtime option configures the very process the manifest starts, so one inside the launcher changes what that process is rather than putting another above the module`
    ).toBe(true);
  });

  it('counts a launcher that omits the runner loader as not applying it in process', () => {
    expect(
      launchesInProcess(['node']),
      `the loader is what runs one of our modules in the process node starts, so a launcher without it is not the shape this rule accepts`
    ).toBe(false);
  });

  it('counts the runner command line as forking rather than launching in process', () => {
    expect(
      launchesInProcess(['tsx']),
      `the runner asked for a file by its own command line forks it, which is the shape this rule exists to keep out of a head`
    ).toBe(false);
  });

  it('counts a launcher that runs a program after the loader as forking', () => {
    const launch = headLaunchOf(`node --import tsx ${RUNNER_COMMAND} ${CHECKS_RUNNER}`);

    expect(
      launchesInProcess(launch?.launcher ?? []),
      `a program word between the loader and the file is what runs the file, so the loader applies to a process that then forks — the shape this rule exists to keep out of a head, wearing a runtime the rule accepts`
    ).toBe(false);
  });

  it('launches it in the process the manifest itself starts', () => {
    const forked = launchingScripts().filter(
      (name) => !launchesInProcess(headLaunchOf(rootScripts()[name] ?? '')?.launcher ?? [])
    );

    expect(
      forked,
      `these root scripts launch one of our own through something that forks it: ${JSON.stringify(forked)}. The forking process is then the outermost of the command, and it is what an operator finds and kills — while the script, one process below it, is never told and keeps every tree it started. Launch it as \`${IN_PROCESS_LAUNCH.join(' ')} <file>\`, which applies the runner's loader in the process the manifest starts. The rule is over every entry rather than over the ones that start something long-lived, so an entry that gains a server later is already covered.`
    ).toEqual([]);
  });
});

/**
 * The whole proof for one head: start the real chain with the manifest's own
 * words, show the hop below is still there so nothing was removed to make the
 * assertion pass, kill the single process those words started, and watch the
 * tree go.
 */
async function expectHeadTakesItsTree(
  head: readonly string[],
  beforeStage: readonly string[] = []
): Promise<void> {
  const chain = await startChain(head, beforeStage);
  // The stage still reaches its work through the runner's command line, so
  // this is the real chain rather than one with the hops taken out.
  expect(chain.hop).not.toBe(chain.head.pid);
  expect(isAlive(chain.hop)).toBe(true);
  expect(isAlive(chain.leader)).toBe(true);
  expect(isAlive(chain.supervisor)).toBe(true);
  expect(isAlive(chain.task)).toBe(true);

  // The head's own id and nothing else: a group signal would reach the stage
  // by itself and prove nothing about what the head's death does.
  chain.head.kill('SIGKILL');
  await waitForExit(chain.head);

  expect(await untilSettled(() => !isAlive(chain.task))).toBe(true);
  expect(await untilSettled(() => !isAlive(chain.supervisor))).toBe(true);
  expect(await untilSettled(() => !isAlive(chain.leader))).toBe(true);
  expect(await untilSettled(() => !isAlive(chain.hop))).toBe(true);
}

describe(
  'a chain started the way its root script starts it',
  { timeout: CHAIN_CASE_TIMEOUT_MS },
  () => {
    it('takes its whole tree with it when its outermost process is killed hard', async () => {
      await expectHeadTakesItsTree(headOf(rootScripts()[DRIVEN_CHAIN] ?? ''));
    });

    it('takes its whole tree with it when the environment wrapper is its outermost process', async () => {
      await expectHeadTakesItsTree(headLaunching(ENVIRONMENT_WRAPPER));
    });

    it('takes its whole tree with it when the checks runner is its outermost process', async () => {
      await expectHeadTakesItsTree(headLaunching(CHECKS_RUNNER), CHECKS_LANE);
    });
  }
);
