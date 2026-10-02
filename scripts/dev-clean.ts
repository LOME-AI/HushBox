import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listStageDatabasesSql, listTestDatabasesSql } from '@hushbox/db/test-db';
import {
  auditExitCode,
  readComposeProjectWorld,
  removeWranglerStore,
  reportWorldAudit,
} from './lib/claims/world-audit.js';
import { currentRunId, reapPass, unownedFinding } from './lib/claims/ownership.js';
import {
  containerAge,
  getActiveWorktreePaths,
  getRunningDockerProjects,
  getStuckContainers,
  listUnmanagedContainers,
  slotLookup,
} from './docker-cleanup.js';
import { HOST_BOUND_PORT_ENVS, MODE_BANDED_PORT_ENVS } from './lib/stack/dev-ports.js';
import { composeProjectOf } from './lib/stack/idle-killer-daemon.js';
import { describePort, modesBinding, portFor } from './lib/stack/port-plan.js';
import { requireScratchBucketStore } from './lib/test-run/scratch-bucket-reclaim.js';
import { withMaintenanceExecutor } from './lib/test-run/test-db-provision.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { resolveGitCommonDir } from './lib/cli/git-checkout.js';
import { runMain } from './lib/cli/run-main.js';
import {
  RECLAIM_BOUNDARY_PHRASE,
  pastReclaimBoundary,
  unreadAgeClause,
} from './lib/claims/resource-age.js';
import {
  groupSignalWasRefused,
  killTree,
  lifelineSocketDir,
  reclaimLifelineSockets,
  reclaimProcessGroups,
  scanLifelineSockets,
  socketRemovalWasRefused,
} from './lib/spawn/long-lived.js';
import {
  listenerAge,
  selectAgeResolver,
  selectIdentityResolver,
  selectListenerLookup,
  selectPgidResolver,
  youngestAge,
} from './lib/spawn/process-probes.js';
import type {
  KillTreeDeps,
  LifelineSocketReclaimOptions,
  LifelineSocketReport,
  ProcessGroupReclaimOptions,
  ProcessGroupReclaimReport,
} from './lib/spawn/long-lived.js';
import type {
  AgeResolver,
  IdentityResolver,
  KillerDeps,
  ListenerLookup,
  PgidResolver,
} from './lib/spawn/process-probes.js';
import type { UnmanagedContainer } from './docker-cleanup.js';
import type { Ownership, OwnershipState } from './lib/claims/ownership.js';
import type { ResourceAge } from './lib/claims/resource-age.js';
import type { WorldAuditReport } from './lib/claims/world-audit.js';
import type { WorldScanDeps } from './lib/claims/world-scan.js';
import type { SqlExecutor } from './lib/stack/stack-meta.js';

/** This checkout: the parent of the scripts directory this file lives in. */
const WORKTREE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function resolvePorts(envNames: readonly string[]): number[] {
  const ports: number[] = [];
  for (const name of envNames) {
    const raw = process.env[name];
    if (!raw) continue;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) continue;
    ports.push(parsed);
  }
  return ports;
}

/**
 * The ports a pass reads before it decides anything: every mode-banded port of
 * this checkout, in both bands.
 *
 * This is an address space, not a verdict. Nothing here is reclaimable by
 * virtue of being in it — each port found listening is then classified, and
 * only the ones a dead run's claim names are ended. A port in this set whose
 * claim is live is untouched, and one no claim names is reported.
 *
 * Mode-banding is exactly host-bound less the idle daemon's sentinel — one per
 * slot, outliving every run and claimed by none — and that is why the set is
 * derived this way rather than from the host-bound set. A pass that reached the
 * sentinel would classify as unowned the daemon that reclaims on everyone's
 * behalf, and would then report the same resource on every run forever.
 */
export function portsToClassify(): number[] {
  return bandedHostBoundPorts(MODE_BANDED_PORT_ENVS);
}

/** The claim a resource is attributed to, as the registry recorded it. */
type ResourceOwner = ReturnType<Ownership['resourceOwner']>;

export interface PortReclaimOptions {
  /** Defaults to {@link portsToClassify}. */
  readonly ports?: readonly number[];
  readonly lookup?: ListenerLookup;
  readonly pgid?: PgidResolver;
  /** Resolves what an unclaimed listener is, so the line naming it is readable. */
  readonly identity?: IdentityResolver;
  /** Resolves how long a listener nothing accounts for has stood. */
  readonly age?: AgeResolver;
  readonly deps?: KillerDeps;
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string;
  /**
   * How a tree is ended, injected so both platform branches are testable off
   * the platform that takes them and so a test can watch what would be
   * signalled rather than signal it.
   */
  readonly killer?: KillTreeDeps;
  /** Also end the live runs of this checkout. */
  readonly all?: boolean;
  /** Also end listeners no claim accounts for. */
  readonly unowned?: boolean;
  /** This checkout, so `all` reaches no other one. */
  readonly gitCommonDir?: string | null;
  readonly log?: (message: string) => void;
}

export interface PortReclaimReport {
  /** Ports whose holders this pass ended. */
  readonly reclaimed: number[];
  /** Ports a live run owns, left exactly as they were. */
  readonly live: number[];
  /** Ports no claim accounts for, reported and left standing. */
  readonly unowned: number[];
}

/** Everything the tree address of a pid is resolved from. */
interface TreeAddressing {
  readonly platform: NodeJS.Platform;
  readonly pgidResolver: PgidResolver;
  readonly deps: KillerDeps | undefined;
}

interface ReclaimContext extends TreeAddressing {
  readonly lookup: ListenerLookup;
  readonly identity: IdentityResolver;
  readonly age: AgeResolver;
  readonly killer: KillTreeDeps;
  readonly log: (message: string) => void;
  /** The tree this process is in, which it must never signal. */
  readonly ownAddress: number | null;
}

interface ReclaimFlags {
  readonly all: boolean;
  readonly unowned: boolean;
  readonly gitCommonDir: string | null;
  readonly selfRunId: string | null;
}

/**
 * One port and the processes listening on it, as a single id.
 *
 * The holders are part of the id rather than beside it, so a port that changed
 * hands between two readings reads as a resource that appeared — which is what
 * makes {@link reapPass} restart instead of acting on a reading the world has
 * already left behind.
 */
function holderId(port: number, pids: readonly number[]): string {
  return `${String(port)}:${pids.toSorted((first, second) => first - second).join(',')}`;
}

function portOf(id: string): number {
  return Number(id.slice(0, id.indexOf(':')));
}

function pidsOf(id: string): number[] {
  return id
    .slice(id.indexOf(':') + 1)
    .split(',')
    .map(Number);
}

/**
 * What a signal must address to reach a listener's whole tree: its process
 * group on POSIX, where ending the leaf alone lets a supervisor put a fresh one
 * on the same port, and the process itself on Windows, where `taskkill /T`
 * walks down from a pid and no API addresses a group.
 */
async function treeAddress(pid: number, addressing: TreeAddressing): Promise<number | null> {
  if (addressing.platform === 'win32') return pid;
  return addressing.pgidResolver(pid, addressing.deps);
}

/**
 * Ends the trees holding `port`, and answers whether it ended any.
 *
 * The claim that licensed this names the port, never the process: a pid is the
 * kernel's to reissue the moment its holder exits, so a recorded one is no
 * evidence about who holds the address now. Every group signalled here is
 * resolved from a process listening on the claimed port at the moment of the
 * signal, which is what stops a recycled id being signalled in a dead run's
 * name; a holder that let go between the classification and here is left to
 * the next run rather than guessed at.
 */
async function endHolders(
  port: number,
  classified: readonly number[],
  context: ReclaimContext
): Promise<boolean> {
  const holding = new Set(await context.lookup(port, context.deps));
  const addresses = new Set<number>();
  for (const pid of classified) {
    if (!holding.has(pid)) continue;
    const address = await treeAddress(pid, context);
    // Our own tree would take the reclaiming process down with the orphan and,
    // in a `dev:clean && dev` chain, the server about to start with it.
    if (address === null || address === context.ownAddress) continue;
    addresses.add(address);
  }

  if (addresses.size === 0) {
    context.log(
      `port ${String(port)} — nothing addressable is holding it any more, so there was ` +
        'nothing to end; the next run reclaims whatever takes it next'
    );
    return false;
  }
  for (const address of addresses) killTree(address, 'SIGKILL', context.killer);
  return true;
}

/**
 * Whether the reclaim may end whatever holds this port.
 *
 * `owned-expired` is the one state that licenses destruction unasked: the
 * kernel has already said the run that took the claim is gone. `unowned` needs
 * the printed flag, because nothing whatever is known about who is holding it.
 * `owned-live` needs that flag and the claim to belong to this checkout and to
 * a run other than the one doing the reclaiming.
 */
function mayEnd(
  state: OwnershipState,
  owner: ResourceOwner,
  flags: ReclaimFlags,
  age?: ResourceAge
): boolean {
  if (state === 'owned-expired') return true;
  // No claim names it, which is the same reading `unowned` is: one question,
  // asked once, so the answer cannot be one thing here and another below. The
  // printed flag is one of two licences now: a resource nothing accounts for
  // that has stood past the boundary is reclaimed by the next run that sees it,
  // because one reported every day for a month is an accumulation nobody
  // clears, and one younger than the boundary is left exactly as it was.
  if (owner === undefined) return flags.unowned || pastReclaimBoundary(age);
  return flags.all && owner.runId !== flags.selfRunId && owner.gitCommonDir === flags.gitCommonDir;
}

/** How a live claim is named in the line saying its port was left alone. */
function describeKept(port: number, owner: NonNullable<ResourceOwner>): string {
  return (
    `port ${String(port)} — \`${owner.command}\` (pid ${String(owner.pid)}, slot ` +
    `${String(owner.slot)}, ${owner.mode}, ${owner.gitCommonDir}) is live on it: nothing to do`
  );
}

/** The line naming a listener no claim accounts for, and the repair for it. */
async function describeUnowned(
  found: { readonly port: number; readonly pids: readonly number[]; readonly age: ResourceAge },
  context: ReclaimContext,
  ownership: Ownership
): Promise<string> {
  const { port, pids, age } = found;
  const holding: string[] = [];
  for (const pid of pids) {
    const found = await context.identity(pid, context.deps);
    const where = found.cwd === null ? 'unreadable working directory' : `cwd ${found.cwd}`;
    holding.push(`pid ${String(pid)} (${where}, ${found.command ?? 'unreadable command line'})`);
  }
  // Said only where the question was put and went unanswered. A line that left
  // it out would read as a resource this run established to be young, which is
  // the one thing this pass would then never come back and reclaim.
  const unread = age.kind === 'unreadable' ? ` ${capitalise(unreadAgeClause(age.reason))}.` : '';
  return (
    `port ${String(port)} is ${unownedFinding(ownership)}. Listening on it: ` +
    `${holding.join('; ')}. End it with \`pnpm dev:clean --unowned\` once you have confirmed ` +
    `it is yours.${unread}`
  );
}

/** A clause written to stand mid-sentence, made to open one. */
function capitalise(clause: string): string {
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}

/**
 * The line naming a listener nothing accounts for that the boundary licensed
 * this run to end. Printed rather than silent, because nothing else would say
 * why a command nobody passed a flag to ended somebody's process.
 */
function describeReclaimedByAge(port: number): string {
  return (
    `port ${String(port)} — no claim accounts for it and it has stood longer than the ` +
    `${RECLAIM_BOUNDARY_PHRASE} such a resource is left standing for, so this run ends it`
  );
}

/** What one pass did about one port, which is the list its number goes in. */
type Disposition = 'reclaimed' | 'live' | 'unowned' | 'gone';

/**
 * Ends what is holding a port and says which of the two that was: a reclaim, or
 * a holder that had already let go by the time the signal was addressed.
 */
async function endAndAnswer(
  port: number,
  pids: readonly number[],
  context: ReclaimContext
): Promise<Disposition> {
  return (await endHolders(port, pids, context)) ? 'reclaimed' : 'gone';
}

/** Decides one port's fate, prints the line about it, and says what it did. */
async function reapHolder(
  id: string,
  ownership: Ownership,
  context: ReclaimContext,
  flags: ReclaimFlags
): Promise<Disposition> {
  const port = portOf(id);
  const owner = ownership.resourceOwner('port', String(port));
  const state = ownership.stateOfResource('port', String(port));
  if (owner !== undefined) {
    // A port some claim names is settled by that claim, so how long it has
    // stood is never asked: the question belongs to the resources the claims
    // leave unaccounted for, and asking it here would read a machine for an
    // answer nothing would act on.
    if (mayEnd(state, owner, flags)) return endAndAnswer(port, pidsOf(id), context);
    context.log(describeKept(port, owner));
    return 'live';
  }
  const age = await youngestAge(pidsOf(id), context.age, context.deps);
  if (mayEnd(state, owner, flags, age)) {
    if (pastReclaimBoundary(age)) context.log(describeReclaimedByAge(port));
    return endAndAnswer(port, pidsOf(id), context);
  }
  context.log(await describeUnowned({ port, pids: pidsOf(id), age }, context, ownership));
  return 'unowned';
}

async function reapHolders(
  present: readonly string[],
  ownership: Ownership,
  context: ReclaimContext,
  flags: ReclaimFlags
): Promise<PortReclaimReport> {
  const reclaimed: number[] = [];
  const live: number[] = [];
  const unowned: number[] = [];

  const found: Record<Exclude<Disposition, 'gone'>, number[]> = { reclaimed, live, unowned };
  for (const id of present) {
    const disposition = await reapHolder(id, ownership, context, flags);
    // A holder that let go between the classification and the signal is in none
    // of the three lists: nothing was ended, and nothing is left to report.
    if (disposition !== 'gone') found[disposition].push(portOf(id));
  }

  return { reclaimed, live, unowned };
}

/**
 * Frees the ports of this checkout that nothing alive is entitled to keep.
 *
 * Ownership is a claim lookup and nothing else. The tests this replaces asked
 * whether a listener's working directory sat inside this checkout, which a live
 * peer `pnpm test` satisfies, and — when that could not be read — whether its
 * command line looked like one of our dev servers, which is the guess
 * Playwright's own port cleanup ships. Both answer "may I kill this" with
 * evidence about what a process resembles; only a claim answers it with
 * evidence about whether anyone still needs it.
 */
async function contextFor(options: PortReclaimOptions): Promise<ReclaimContext> {
  const addressing: TreeAddressing = {
    platform: options.killer?.platform ?? process.platform,
    pgidResolver: options.pgid ?? selectPgidResolver(),
    deps: options.deps,
  };
  return {
    ...addressing,
    lookup: options.lookup ?? selectListenerLookup(),
    identity: options.identity ?? selectIdentityResolver(),
    age: options.age ?? selectAgeResolver(),
    killer: { ...options.killer, platform: addressing.platform },
    log:
      options.log ??
      ((message: string): void => {
        console.warn(message);
      }),
    ownAddress: await treeAddress(process.pid, addressing),
  };
}

function flagsFor(options: PortReclaimOptions): ReclaimFlags {
  return {
    all: options.all ?? false,
    unowned: options.unowned ?? false,
    gitCommonDir: options.gitCommonDir ?? null,
    selfRunId: currentRunId(),
  };
}

export async function reclaimPorts(options: PortReclaimOptions = {}): Promise<PortReclaimReport> {
  const ports = options.ports ?? portsToClassify();
  const context = await contextFor(options);
  const flags = flagsFor(options);

  const report = await reapPass({
    what: 'ports',
    registryDir: options.registryDir,
    scan: async () => {
      const found: string[] = [];
      for (const port of ports) {
        const pids = await context.lookup(port, context.deps);
        if (pids.length > 0) found.push(holderId(port, pids));
      }
      return found;
    },
    reap: (present, ownership) => reapHolders(present, ownership, context, flags),
  });

  // A skipped pass reclaimed nothing, which is the empty report: the skip is
  // already printed where it was decided.
  return report ?? { reclaimed: [], live: [], unowned: [] };
}

/**
 * The lifeline socket files `pnpm dev:clean` reclaims: the port pass's
 * counterpart, and this command's other half.
 *
 * Every decision about a file is {@link reclaimLifelineSockets}'s and none of
 * it is taken again here. What this adds is the one thing that reclaim leaves
 * to its caller: a removal the operating system refuses this user is named,
 * the file is left standing, and the pass carries on to the files behind it,
 * while every other removal failure still raises. Raising at the first refusal
 * would leave every file behind it unexamined and stop the next run in the same
 * place, so a command that cannot clean up after another user's dead run would
 * stop cleaning up after this one's.
 *
 * Stepping over such a file is what lets the pass finish; it is not a finding
 * that the file has been dealt with, which is why {@link reclaimExitCode}
 * counts one.
 */
export async function reclaimSockets(
  options: Pick<LifelineSocketReclaimOptions, 'scan' | 'log' | 'registryDir'>
): Promise<LifelineSocketReport> {
  return reclaimLifelineSockets({ ...options, removalRefused: socketRemovalWasRefused });
}

/**
 * The process trees `pnpm dev:clean` reclaims: the third of this command's
 * passes, and the one that reaches a tree binding no address at all.
 *
 * Every decision about a tree is {@link reclaimProcessGroups}'s and none of it
 * is taken again here. What this adds is the one thing that reclaim leaves to
 * its caller, on exactly the terms {@link reclaimSockets} states for a file: a
 * signal the operating system refuses this user is named, the tree is left
 * running, and the pass carries on to the trees behind it, while every other
 * failure still raises.
 *
 * Stepping over such a tree is what lets the pass finish; it is not a finding
 * that the tree has been dealt with, which is why {@link reclaimExitCode}
 * counts one.
 */
export async function reclaimGroups(
  options: Pick<ProcessGroupReclaimOptions, 'log' | 'registryDir' | 'killer'>
): Promise<ProcessGroupReclaimReport> {
  return reclaimProcessGroups({ ...options, signalRefused: groupSignalWasRefused });
}

/**
 * What `pnpm dev:clean` exits with once its three passes have run: non-zero
 * where any of them left something a human must act on, zero where none did.
 *
 * Four lists are that: a listener no claim accounts for, a socket file no claim
 * accounts for, a socket file this user was refused permission to remove, and a
 * process tree this user was refused permission to end. What a pass reclaimed
 * is something it did rather than something left to do, and what a live run
 * holds was never anyone's to act on.
 */
export function reclaimExitCode(
  ports: PortReclaimReport,
  sockets: LifelineSocketReport,
  groups: ProcessGroupReclaimReport
): number {
  const leftForAHuman =
    ports.unowned.length + sockets.unowned.length + sockets.refused.length + groups.refused.length;
  return leftForAHuman > 0 ? 1 : 0;
}

const BINDING_MODES = modesBinding(true);

/**
 * Every host-bound port of this checkout in the band of every stack that binds
 * one, derived from the ports the environment carries. The environment holds a
 * single band — whichever stack the command was loaded for — and each of the
 * others is the same service, lane and slot in that stack's band, so the set is
 * derived rather than read. A stack that declares it binds no host port is left
 * out: its band is allocated but never listened on, so probing it can only ever
 * find a process that is not there.
 */
export function bandedHostBoundPorts(envNames: readonly string[] = HOST_BOUND_PORT_ENVS): number[] {
  const banded = new Set<number>();
  for (const port of resolvePorts(envNames)) {
    const described = describePort(port);
    // A port outside the allocation belongs to no band of ours to widen.
    if (described === undefined) continue;
    for (const mode of BINDING_MODES) {
      banded.add(portFor(described.service, { slot: described.slot, mode, lane: described.lane }));
    }
  }
  return [...banded].toSorted((first, second) => first - second);
}

interface ListeningPortOptions {
  readonly ports?: readonly number[];
  readonly lookup?: ListenerLookup;
  readonly deps?: KillerDeps;
}

/** The subset of this checkout's banded ports something is listening on. */
export async function listeningPorts(options: ListeningPortOptions = {}): Promise<number[]> {
  const lookup = options.lookup ?? selectListenerLookup();
  const ports = options.ports ?? bandedHostBoundPorts();
  const listening: number[] = [];
  for (const port of ports) {
    const pids = await lookup(port, options.deps);
    if (pids.length > 0) listening.push(port);
  }
  return listening;
}

/** Every database the auditor classifies: the per-run ones and the staged templates. */
export async function auditedDatabaseNames(executor: SqlExecutor): Promise<string[]> {
  const [perRun, staged] = await Promise.all([
    executor.query<{ datname: string }>(listTestDatabasesSql()),
    executor.query<{ datname: string }>(listStageDatabasesSql()),
  ]);
  return [...perRun, ...staged].map((row) => row.datname);
}

/** The connection the audit classifies databases through, or a clear refusal. */
export function requireDatabaseUrl(): string {
  const databaseUrl = process.env['DATABASE_URL'];
  if (databaseUrl === undefined || databaseUrl === '') {
    throw new Error('DATABASE_URL is not loaded, so no database can be classified');
  }
  return databaseUrl;
}

/**
 * Which of the audit's two readers a pass is for.
 *
 * `housekeeping` is the pass every bring-up runs on its way in, for a reader
 * who asked for a stack and not for a report: it reclaims the stranded wrangler
 * stores, and what it prints is stated once at `AuditShape` in
 * `scripts/lib/claims/world-audit.ts`, whose `what-must-be-done` shape this
 * selects. It is the default because it is what every caller but one is doing.
 *
 * `report` is `pnpm dev:clean --dry-run`, whose whole purpose is the
 * classification: it changes nothing and prints a line per resource.
 */
export type AuditPass = 'housekeeping' | 'report';

/**
 * Where a pass reads the world, less the two questions it puts about containers
 * itself: those it derives from one listing, so what it needs here is the
 * listing rather than either answer.
 *
 * Injected whole, and defaulted to {@link machineWorldSources}, so a pass can be
 * driven over a world that holds still. The derivation below is the kind of
 * code nothing observes until it is wrong — an unsupplied age reads exactly
 * like a class with no age at all — and a pass no case can drive is a pass
 * nothing proves.
 */
export type StackWorldSources = Omit<
  WorldScanDeps,
  'containers' | 'containerAges' | 'repoRoot' | 'stack' | 'reclaimStrandedStores'
> & {
  /** Every container under our prefix no compose project owns, dated as docker dated it. */
  readonly containers: () => Promise<readonly UnmanagedContainer[]>;
  /** The claims every resource is classified against; the machine's own where absent. */
  readonly registryDir?: string | undefined;
};

/* v8 ignore start -- the live machine itself: every reading it names is covered where it lives */
/** Every class read off the machine this checkout is running on. */
export function machineWorldSources(repoRoot: string): StackWorldSources {
  return {
    containers: listUnmanagedContainers,
    stuckContainers: getStuckContainers,
    databases: () => withMaintenanceExecutor(requireDatabaseUrl(), auditedDatabaseNames),
    buckets: () => requireScratchBucketStore(process.env).list(),
    listeningPorts: () => listeningPorts(),
    // The pass reclaims this class itself, so how long one has been held is a
    // question it can act on: past the boundary a listener nothing accounts
    // for is the next run's rather than a human's, and the report is where a
    // reader sees that before it happens.
    listenerAge: (port) => listenerAge(port),
    lifelineSockets: () => scanLifelineSockets(lifelineSocketDir()),
    composeProjects: () =>
      readComposeProjectWorld({
        checkout: repoRoot,
        projects: getRunningDockerProjects,
        activeWorktreePaths: getActiveWorktreePaths,
        commonDirOf: resolveGitCommonDir,
        slotOfWorktree: () => slotLookup(),
      }),
  };
}
/* v8 ignore stop */

/**
 * One reading, however many questions are put to it. The container class is
 * asked twice — which containers stand, and how long each has stood — and both
 * answers must be about the same set: a container that appeared between two
 * listings would be classified with no age, and one that left would carry an
 * age nothing is classifying.
 */
function readOnce<T>(read: () => Promise<T>): () => Promise<T> {
  let reading: Promise<T> | undefined;
  return () => (reading ??= read());
}

/**
 * The audit of everything this stack leaves in the world. Run by
 * `pnpm dev:clean --dry-run` and again at the end of `ensureStack`, so a
 * resource nothing claims is named the first time anyone touches the stack.
 *
 * Every source is a thunk, opened inside the pass rather than before it: a
 * class whose credentials the calling command never loaded must be reported as
 * unclassified rather than take the whole audit, and the command it is
 * housekeeping for, down with it.
 */
export async function auditStackWorld(
  repoRoot: string,
  log: (message: string) => void,
  pass: AuditPass = 'housekeeping',
  world: StackWorldSources = machineWorldSources(repoRoot)
): Promise<WorldAuditReport> {
  const { containers, registryDir, ...classes } = world;
  const listed = readOnce(containers);
  return reportWorldAudit(
    {
      ...classes,
      repoRoot,
      // Read at the pass rather than cached anywhere: the daemon captured its
      // project at spawn and never re-reads it, so what this stack is *now* is
      // what a daemon on the sentinel port has to still agree with.
      stack: { composeProject: composeProjectOf(process.env), checkout: repoRoot },
      containers: async () => {
        const present = await listed();
        return present.map((found) => found.name);
      },
      // The boundary reclaims a container as it reclaims a listener, so the
      // creation time the listing already carried is read into an age here
      // rather than dropped at this seam. Dropping it is not a class with no
      // age — it is a class the boundary can never release, reported for ever
      // as something a human must remove by hand.
      containerAges: async () => {
        const now = Date.now();
        const present = await listed();
        return new Map(present.map((found) => [found.name, containerAge(found.createdAt, now)]));
      },
      // Given only to the pass that may change something: a dry run that
      // removed a directory would not be a dry run.
      reclaimStrandedStores:
        pass === 'report' ? undefined : (store) => removeWranglerStore(repoRoot, store),
    },
    log,
    registryDir,
    pass === 'report' ? 'every-line' : 'what-must-be-done'
  );
}

/**
 * `pnpm dev:clean`, and its three flags.
 *
 * `--dry-run` classifies everything and changes nothing. `--all` extends the
 * reclaim to this checkout's own live runs, which is what "restart everything"
 * means once ownership is a claim. `--unowned` is the printed permission a
 * listener nothing accounts for needs before anything may end it — without it
 * such a listener is named and left, and the command exits non-zero so the
 * developer is told rather than left to discover it.
 */
export const COMMAND_LINE = {
  command: 'pnpm dev:clean',
  summary:
    'Ends what a finished run of this checkout left behind, and reports what nothing accounts for.',
  flags: [
    {
      flag: '--all',
      kind: 'boolean',
      summary: "Reclaim this checkout's own live runs too, not just expired ones.",
    },
    {
      flag: '--dry-run',
      kind: 'boolean',
      summary: 'Classify every resource and change nothing.',
    },
    {
      flag: '--unowned',
      kind: 'boolean',
      summary: 'Permission to end a listener no claim accounts for.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via package.json scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
    if (parsed === null) return 0;
    if (parsed.flags['--dry-run']) {
      const report = await auditStackWorld(
        WORKTREE_ROOT,
        (message) => {
          console.log(message);
        },
        'report'
      );
      return auditExitCode(report.lines, report.unreadable);
    }
    const report = await reclaimPorts({
      all: parsed.flags['--all'],
      unowned: parsed.flags['--unowned'],
      gitCommonDir: await resolveGitCommonDir(WORKTREE_ROOT),
      log: (message) => {
        console.log(message);
      },
    });
    // The flags above reach ports and nothing else: neither of the two passes
    // that follow reads one, so nothing a caller can type widens what either
    // does. A tree a live claim names is left alone whatever was typed, which
    // is the whole of what separates this from the blind killing it replaced.
    const sockets = await reclaimSockets({
      scan: () => scanLifelineSockets(lifelineSocketDir()),
      log: (message) => {
        console.log(message);
      },
    });
    // After the ports, never before: a tree holding a claimed address is ended
    // through that address, and this pass then finds its group empty. What is
    // left for it is the tree that bound nothing, which no address names.
    const groups = await reclaimGroups({
      log: (message) => {
        console.log(message);
      },
    });
    return reclaimExitCode(report, sockets, groups);
  });
}
/* v8 ignore stop */
