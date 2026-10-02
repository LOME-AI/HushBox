import { randomBytes } from 'node:crypto';
import { readdir, unlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import {
  currentRunId,
  reapPass,
  recordOwnedResourceIfClaimed,
  unownedFinding,
} from '../claims/ownership.js';
import {
  RUN_CLAIM_ENV,
  addResource,
  addSpawnedProcess,
  releaseBeforeRecordDrops,
} from '../claims/registry.js';
import { FORWARDED_SIGNALS, killTree, sendSignal, signalTolerantly } from './kill-tree.js';
import { leaderIsStanding, treeIsStanding } from './process-groups.js';
import type { Ownership } from '../claims/ownership.js';
import type { KillSignal, TreeSignal } from './kill-tree.js';

/**
 * Ending a tree and reclaiming a recorded process group are published from here
 * as well as from their own modules, because this is the door their callers
 * already come through.
 */
export { FORWARDED_SIGNALS, killTree } from './kill-tree.js';
export type { KillSignal, KillTreeDeps, TreeSignal } from './kill-tree.js';
export {
  addressesOneTree,
  attributeLiveGroup,
  groupIsAlive,
  groupMembers,
  groupSignalWasRefused,
  parseProcStatGroupState,
  processGroupOf,
  readRecordedProcessGroups,
  recordedGroupAddressesATree,
  reclaimProcessGroups,
  treeIsStanding,
} from './process-groups.js';
export type { ProcessGroupReclaimOptions, ProcessGroupReclaimReport } from './process-groups.js';

/**
 * The one way this repository starts a child that outlives the call which
 * started it — a dev server, a watcher, an emulator's API — and the one place
 * such a child is recorded. What that record buys, and what it does not, is
 * {@link spawnLongLived}'s.
 *
 * Each mechanism that keeps a killed starter from leaving a tree behind
 * answers a case the others do not. A child that runs this module connects to
 * the socket its spawner is listening on and ends its own tree when that
 * connection ends, which is prevention (see {@link watchSpawner}). A child that
 * does not — anything third-party — is instead made *addressable*: the group id
 * goes into the run's claim before the caller waits for the child to become
 * ready, so a run killed during that wait still leaves behind a record naming
 * what it started.
 *
 * Recording before the wait is the whole point of the ordering. A preview
 * server that took thirty seconds to answer, started by a run killed at second
 * ten, is exactly the orphan this exists for: it keeps its port, and without
 * the record nothing can name it.
 *
 * A group id alone does not name that tree, which is why the ports go in too. A
 * supervisor is free to make each task it runs the leader of a *second* group —
 * `turbo` does, so every dev server behind `pnpm dev` sits outside the group
 * recorded here — and signalling the recorded group then empties it while the
 * servers keep their ports and their listeners. The port is the handle that
 * survives that, because it is a property of what was bound rather than of who
 * bound it.
 *
 * The spawn is platform-conditional because `detached` is worth the opposite
 * on each platform:
 *
 * - On POSIX `detached: true` gives the child its own process group, which is
 *   what makes `kill(-group)` reach a supervisor and everything under it —
 *   killing only the leaf lets the supervisor put a fresh one on the same port.
 *   It also disables execa's own `cleanup`, so the signal and exit handling
 *   below is the entire mechanism rather than a backstop.
 * - On Windows libuv puts every non-detached child in one global job object
 *   whose only handle it holds, so the children it explicitly added are killed
 *   when the spawning process exits. That reaches the child and stops there:
 *   the job is created with `JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK`, whose whole
 *   purpose in libuv's own words is that "only the processes that we explicitly
 *   add are affected, and *their* subprocesses are not". So a supervisor's tasks
 *   are outside the job exactly as they are outside the process group on POSIX,
 *   and the job is a guarantee about the child, never about the tree. `detached`
 *   there opts out of even that, in exchange for a group concept no Node API can
 *   address, so Windows spawns attached and kills trees with `taskkill /T /F`.
 */

/**
 * Carries the address of the socket the spawning process answers on, to every
 * child it starts and to everything those children start in turn.
 *
 * An address rather than an inherited descriptor, and the difference is the
 * whole of why this mechanism runs at all. A descriptor is dropped by any
 * process in between that does not pass it on, and every production chain here
 * has such a process: the runner's command line forks, and the package manager
 * puts a shell and its own process in the way. An environment survives all of
 * them, so a grandchild reached through two hops holds the same address its
 * spawner published, and nothing has to be inherited for the connection to be
 * made.
 */
export const LIFELINE_ENV = 'HB_SPAWN_LIFELINE';

/**
 * Everything in an environment that says which run a process belongs to: the
 * spawner it may end its tree with, and the run whose record it may write into.
 * One list because they are one idea — an inherited identity — and a child that
 * outlives its launcher must hold none of them.
 */
const INHERITED_IDENTITY_ENV = new Set<string>([LIFELINE_ENV, RUN_CLAIM_ENV]);

/**
 * The environment for a child that must outlive the process starting it,
 * naming none of the identities its launcher holds.
 *
 * A daemon is the case: it is spawned by a launcher, detached, and goes on
 * running after every process above it has gone. Handed the address its
 * launcher inherited, it would watch a process it is not below and tear its own
 * tree down the moment that process ended — the recorded-identity-reuse hazard
 * in a value rather than in an id. Handed the run claim, anything it recorded
 * would land in a record its launcher removes on the way out, so a resource
 * still in use would read as belonging to nobody. Removing them is what makes
 * each unreachable rather than merely unreached: a process whose environment
 * names no spawner and no run is the head of its own chain, whatever it goes on
 * to import, spawn or record.
 *
 * Removed rather than emptied, because an address that is present and names
 * nothing is a spawner that handed one over and lost it, which
 * {@link watchSpawner} refuses to run on.
 */
export function withoutInheritedIdentity(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(env).filter(([name]) => !INHERITED_IDENTITY_ENV.has(name))
  );
}

/** How many random bytes name one process's socket. */
const LIFELINE_NONCE_BYTES = 5;

/** What every one of these sockets is called, before its nonce. */
const LIFELINE_SOCKET_PREFIX = 'hb-';

/** Windows keeps its named pipes in a namespace of its own, which is not a path. */
const NAMED_PIPE_DIR = String.raw`\\.\pipe`;

/** What one process's socket is called, wherever the platform puts it. */
function lifelineSocketName(nonce: string): string {
  return `${LIFELINE_SOCKET_PREFIX}${nonce}`;
}

/**
 * Whether a name in the temporary directory is one of these sockets.
 *
 * Built from the same facts {@link lifelineSocketName} is built from, so a
 * name this mechanism could not have produced is never one a reclaimer
 * removes: the temporary directory is shared with every other tool on the
 * machine, and a looser match would hand one of theirs to a pass that deletes.
 */
function isLifelineSocketName(name: string): boolean {
  return LIFELINE_SOCKET_NAME.test(name);
}

const LIFELINE_SOCKET_NAME = new RegExp(
  `^${LIFELINE_SOCKET_PREFIX}[0-9a-f]{${String(LIFELINE_NONCE_BYTES * 2)}}$`
);

/**
 * How many bytes of address a POSIX socket may carry, terminator included.
 *
 * `sun_path` is 108 bytes in the Linux kernel and 104 in the BSD kernel macOS
 * is built on. Past its platform's field the kernel truncates rather than
 * refuses, which is why this is checked here: the failure a truncated address
 * produces is an address already in use, raised before any child starts, from
 * a name freshly drawn at random in an empty directory.
 */
function socketAddressBytes(platform: NodeJS.Platform): number {
  return platform === 'darwin' ? 104 : 108;
}

/**
 * Where a process listens for the children it starts.
 *
 * The name is random and short rather than descriptive. Short because a POSIX
 * socket address is a filesystem path under a length limit far below what a
 * path may otherwise carry, and the temporary directory is already most of it.
 * Random because a name derived from anything a later process could hold — a
 * process id above all — would let that later process answer for this one, and
 * a watcher would then hold a live connection to a stranger. That is also why
 * the rejected alternative is rejected: a loopback port can be reused by a
 * foreign server, and a false end-of-file on one would tear down a live tree.
 *
 * An address the platform cannot carry whole is refused rather than shortened:
 * truncation is what takes the randomness back out of the name, since two
 * processes under the same long directory truncate to the same address.
 *
 * Windows has no socket in the filesystem, so the address there is a named
 * pipe, which is not a path, is never built by joining one, and carries no
 * length the temporary directory could push past.
 */
export function lifelineAddress(
  nonce: string,
  platform: NodeJS.Platform,
  temporaryDir: string
): string {
  const name = lifelineSocketName(nonce);
  if (platform === 'win32') return `${NAMED_PIPE_DIR}\\${name}`;

  const address = path.join(temporaryDir, name);
  const limit = socketAddressBytes(platform) - 1;
  const length = Buffer.byteLength(address);
  if (length > limit) {
    throw new Error(
      `A socket address of ${String(length)} bytes does not fit the ${String(limit)} this ` +
        `platform allows, and the kernel would truncate it rather than refuse it — which makes ` +
        `two processes under the same directory answer at one address. It is built under the ` +
        `temporary directory \`${temporaryDir}\`, so point the temporary directory somewhere ` +
        `shorter.`
    );
  }
  return address;
}

/**
 * The directory these sockets are made in: the temporary directory of whatever
 * process made one. A run pointed at another temporary directory leaves its
 * socket there, outside what a pass over this one enumerates.
 */
export function lifelineSocketDir(): string {
  return os.tmpdir();
}

/** Every socket file of this mechanism in `dir`, or none where there is no such directory. */
export async function scanLifelineSockets(dir: string): Promise<readonly string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return entries
    .filter((entry) => entry.isSocket() && isLifelineSocketName(entry.name))
    .map((entry) => path.join(dir, entry.name));
}

/**
 * What a connect to one of these socket files answered.
 *
 * `refused` is the kernel saying nothing is accepting at that name, and it is
 * the only answer here that establishes anything. `answered` is something
 * accepting there. `unknown` is every other failure, and it establishes
 * neither — a connect the caller is not permitted to make fails identically
 * whether a listener is behind the file or nothing is.
 *
 * A refusal on its own is not licence to remove a file, and this type is not
 * where that is decided: a bind creates the file and a listen arms it, so a
 * spawner refuses for the moment between the two. What rules that moment out
 * is the claim the spawner took before the bind, which is read before anything
 * here is asked — see {@link reclaimLifelineSockets}.
 *
 * Deliberately not {@link SPAWNER_GONE_CODES}, which is the set a child reads
 * when it watches its own spawner. That set counts `ENOENT` and `ECONNRESET`
 * as the spawner having gone, which is right for a watcher deciding whether to
 * end its own tree and wrong for a pass deciding whether to remove a file:
 * `ENOENT` names no file there is anything to remove, and an `ECONNRESET` is a
 * connection something reset, which is something having been there.
 */
export type SocketAnswer =
  | { readonly kind: 'answered' }
  | { readonly kind: 'refused' }
  | {
      readonly kind: 'unknown';
      /** What the connect failed with, in the words the line prints. */
      readonly reason: string;
    };

/**
 * What one failed connect says about the file it was made to. Exported and
 * pure for the same reason {@link isSpawnerGone} is: this is the decision, and
 * driving it directly is the only way to put every answer a connect can give
 * to it, including the ones no kernel produces on demand.
 *
 * An error carrying no code at all is unknown like any other unrecognised
 * failure, and says so in place of a code.
 */
export function socketAnswerFor(code?: string): SocketAnswer {
  if (code === 'ECONNREFUSED') return { kind: 'refused' };
  return { kind: 'unknown', reason: code ?? 'no error code' };
}

/**
 * Asks the kernel what is behind `address`, by connecting to it and doing
 * nothing else.
 *
 * The connect is the whole question: nothing is written, nothing is read and
 * nothing is waited for past the answer. A process that is answering gets one
 * connection accepted and immediately ended, and {@link hostLifeline} neither
 * reads from a connection, writes to one, nor acts on one ending — so this is
 * indistinguishable there from a child that started and stopped.
 */
export function probeLifelineSocket(address: string): Promise<SocketAnswer> {
  return new Promise((resolve) => {
    const socket = createConnection(address);
    socket.unref();
    socket.once('connect', () => {
      socket.destroy();
      resolve({ kind: 'answered' });
    });
    socket.once('error', (error: NodeJS.ErrnoException) => {
      socket.destroy();
      resolve(socketAnswerFor(error.code));
    });
  });
}

export interface LifelineSocketReclaimOptions {
  /**
   * Every socket file present right now. Named by the caller rather than
   * defaulted, and injected so a case can drive a world that never holds still.
   */
  readonly scan: () => Promise<readonly string[]>;
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string;
  /**
   * Defaults to a real connect. Injected where a case has to prove that
   * nothing asked, which no answer can be made to show.
   */
  readonly probe?: (address: string) => Promise<SocketAnswer>;
  /**
   * Whether a failed removal is one this caller steps over rather than fails
   * on. A caller that names none fails on every removal that fails, which is
   * the default and the right answer for a command whose whole job is the
   * cleanup: a removal it was refused is its own business to report as a
   * failure. A command doing this as housekeeping on its way to something else
   * names the refusals that were never its mess to clear.
   */
  readonly removalRefused?: (error: unknown) => boolean;
  readonly log?: (message: string) => void;
}

export interface LifelineSocketReport {
  /** Files this pass removed. */
  readonly reclaimed: string[];
  /** Files a live run owns, left exactly as they were. */
  readonly live: string[];
  /** Files no claim accounts for, reported and left standing. */
  readonly unowned: string[];
  /**
   * Files the caller was refused permission to remove, reported and left
   * standing. Empty for a caller that named no refusal it steps over, which is
   * a caller a refusal raises out of rather than reaching here.
   */
  readonly refused: string[];
}

/**
 * Removes one, treating a file that has already gone as the outcome that was
 * wanted.
 *
 * The unlink is made directly rather than through a remove that takes
 * directories too. That one answers an unlink the kernel refused with `EPERM`
 * by trying the path as a directory, and what reaches the caller is the failure
 * of the listing that attempt ends in — so the kernel's own answer about the
 * file never arrives, and a caller deciding what a refusal means decides on an
 * error the kernel never gave. Nothing this enumerates is ever a directory, so
 * the fallback had nothing to offer in the first place.
 */
async function removeSocketFile(address: string): Promise<void> {
  try {
    await unlink(address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Whether a failed socket removal is one the operating system refused this
 * user permission to make.
 *
 * Every code this answers true for comes from the kernel and means the file
 * belongs to a run this user may not clean up after: `EACCES`, where this user
 * may not write the directory holding the file, and `EPERM`, where the
 * directory carries the sticky bit and the file is another user's — which is
 * what a temporary directory shared with the machine's other users gives.
 *
 * They arrive in the kernel's own words because the removal is a bare unlink;
 * {@link removeSocketFile} states why that is what it takes for them to arrive
 * at all.
 *
 * The failure is a removal's and one file's already, because
 * {@link reclaimLifelineSockets} asks this inside the removal of the file it is
 * asking about — so there is nothing left to check but what the kernel said.
 * What a caller does with the answer is its own: this repository's commands
 * step over such a file, for reasons each states.
 */
export function socketRemovalWasRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code } = error as NodeJS.ErrnoException;
  return code === 'EPERM' || code === 'EACCES';
}

/**
 * An answer a file can be left standing on. A refusal is not one of them: it is
 * the answer this pass acts on, so it is spelled out of the type rather than
 * answered in a branch nothing reaches.
 */
type StandingSocketAnswer = Exclude<SocketAnswer, { readonly kind: 'refused' }>;

/**
 * What is left to say about a socket file this pass is leaving standing, given
 * what the kernel answered about it. Each sentence is about the one answer it
 * sits under: the repair for a file something is answering on is not the repair
 * for one nothing established anything about.
 */
function whyItStands(answer: StandingSocketAnswer | undefined): string {
  if (answer === undefined) {
    return (
      'Nothing connected to it: a claim on it may be in the record this pass could not read, ' +
      'so the kernel was asked nothing about it. Deal with that record and run this again.'
    );
  }
  if (answer.kind === 'answered') {
    return (
      'A connect to it was accepted, so a process that spawned while holding no run claim is ' +
      'answering on it. End that process: one that gets to close its own socket takes the file ' +
      'with it, and one killed too hard to close it leaves a file the next pass reclaims.'
    );
  }
  return (
    `A connect to it failed with ${answer.reason} rather than being refused, and a refusal is ` +
    'the only answer that says nothing is behind it — so whether a process is there is ' +
    'unestablished. Clear what stopped the connect and run this again.'
  );
}

/** The line naming a socket file this caller was refused permission to remove. */
function describeRefusedSocket(address: string): string {
  return (
    `socket ${address} is not this user's to remove: the operating system refused it, so it was ` +
    'left standing and the pass went on past it.'
  );
}

/** The line naming a socket file no claim accounts for, and the repair for it. */
function describeUnownedSocket(
  address: string,
  ownership: Ownership,
  answer: StandingSocketAnswer | undefined
): string {
  return `socket ${address} is ${unownedFinding(ownership)}. ${whyItStands(answer)}`;
}

/**
 * Removes the socket files of runs that have gone, and reports the ones nothing
 * accounts for.
 *
 * The runtime unlinks a POSIX socket only for a process whose event loop runs
 * dry, and this repository's commands end by naming an exit code instead —
 * which {@link LifelineHost.close} answers for every process that gets to run
 * one. A process killed by a signal it cannot catch runs nothing at all, and
 * its file is what this reclaims: reaping-on-death is unattainable, so the next
 * run is the mechanism.
 *
 * Ownership is decided first, by claim lookup and nothing else, exactly as it
 * is for a port: a file whose claim is still held is never touched even when
 * nothing answers on it, and no connect is attempted on one — the claim is the
 * kernel's answer about the run, and erring toward keeping a file costs a file.
 *
 * What the claims leave open is then put to the kernel, and no answer settles
 * it alone: a refused connect says nothing is accepting at that name, and
 * joined with a claim lookup that named nothing it says there is no process
 * behind the file. The join is sound only because of the order
 * {@link openProcessLifeline} works in: the address is claimed before the file
 * exists, so a file no claim names is never one a live spawner is about to
 * answer on — the moment between a spawner's own bind and its listen included,
 * which is the one moment a live spawner's file refuses. Every other answer
 * establishes nothing and leaves the file standing.
 *
 * A live run whose record would not read leaves every claim it holds unknown,
 * so nothing this pass could hear would license removing a file: those are left
 * standing without being asked about at all.
 *
 * A removal the operating system refuses is the one outcome the caller decides:
 * a caller naming such refusals has the file reported, left standing, and the
 * pass carries on to the files behind it, and a caller naming none has it
 * raised. Nothing here reads a refusal as the file having gone.
 */
export async function reclaimLifelineSockets(
  options: LifelineSocketReclaimOptions
): Promise<LifelineSocketReport> {
  const log =
    options.log ??
    ((message: string): void => {
      console.warn(message);
    });

  const report = await reapPass({
    what: 'lifeline sockets',
    registryDir: options.registryDir,
    scan: options.scan,
    reap: async (present, ownership) => {
      const probe = options.probe ?? probeLifelineSocket;
      // Whether `unowned` means what it says. A live run whose record would not
      // read may hold a claim on any of these, and the kernel answers about the
      // file rather than about that record — so where this is false the probe
      // is not asked, and no answer it could give would be acted on.
      const attributable = ownership.unreadLiveRuns.length === 0;
      const found: LifelineSocketReport = { reclaimed: [], live: [], unowned: [], refused: [] };
      // One file a caller may not remove costs exactly itself. Raising instead
      // would leave every file behind it in this pass unexamined and stop the
      // next pass in the same place, so a single such file would degrade the
      // reclaim to nothing for good.
      const reclaim = async (address: string): Promise<void> => {
        try {
          await removeSocketFile(address);
          found.reclaimed.push(address);
        } catch (error) {
          if (options.removalRefused?.(error) !== true) throw error;
          found.refused.push(address);
          log(describeRefusedSocket(address));
        }
      };
      for (const address of present) {
        const state = ownership.stateOfResource('socket', address);
        if (state === 'owned-expired') {
          await reclaim(address);
          continue;
        }
        if (state === 'owned-live') {
          found.live.push(address);
          continue;
        }
        const answer = attributable ? await probe(address) : undefined;
        if (answer?.kind === 'refused') {
          await reclaim(address);
          continue;
        }
        found.unowned.push(address);
        log(describeUnownedSocket(address, ownership, answer));
      }
      return found;
    },
  });

  // A skipped pass reclaimed nothing, which is the empty report: the skip is
  // already printed where it was decided.
  return report ?? { reclaimed: [], live: [], unowned: [], refused: [] };
}

/** A tree this process started, and the exit it can be observed to have reached. */
interface StartedTree {
  readonly pid: number;
  readonly exit: Promise<number>;
}

/**
 * How long a tree is given to stop itself once it has been asked to.
 *
 * This bounds a teardown already under way; it decides nothing about whether
 * anything is alive, which is the group read with signal zero
 * ({@link treeIsStanding}). What the budget buys is the chance for the ask to
 * be acted on: a process relaying a stop to what it supervises takes a moment,
 * and the group it sits in empties only once the last of that has gone. So a
 * longer budget changes which trees the escalation reaches and not only when it
 * happens — a group still draining when the budget ends is one the escalation
 * lands on, and a budget of zero would escalate onto every tree in the same
 * tick it asked them. A supervisor that stops its tasks properly takes far less
 * than this; one that has wedged would otherwise hold the tree open forever.
 */
const TEARDOWN_GRACE_MS = 5000;

interface EndTreesDeps {
  /** Asks the child itself to stop, which is where a supervisor's own teardown lives. */
  readonly ask?: (pid: number) => void;
  /** Ends the whole group, for a tree that did not stop when it was asked. */
  readonly force?: (pid: number) => void;
  readonly grace?: () => Promise<void>;
}

/**
 * How long a group is left alone between two readings of whether it has
 * emptied.
 *
 * It prices nothing and decides nothing — the grace is what bounds the waiting,
 * and the group itself is what answers — so this is only how finely that answer
 * is sampled. Short enough that a teardown is not the slow part of a stop, long
 * enough that the sampling is not the load. The timer is unreferenced, so a
 * reading still outstanding never holds a process open.
 */
const DRAIN_POLL_MS = 25;

function afterDrainTick(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, DRAIN_POLL_MS).unref();
  });
}

/* v8 ignore start -- the real budget runs only where the lifeline fires, which
   is a leader in another process; a case that waited it out here would be
   asserting over a timer, so every case injects its own instead. */
function afterGrace(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, TEARDOWN_GRACE_MS).unref();
  });
}
/* v8 ignore stop */

/**
 * How many readings of a group an exiting process takes while it waits for that
 * group to empty. The grace divided by the interval between readings rather
 * than a figure of its own, so the wait an exit spends and the wait a teardown
 * spends are the same budget spelled once.
 *
 * A count rather than a deadline because nothing asynchronous runs again once a
 * process is on its way out: the wait is a sequence of blocking reads, and how
 * many there are is all there is to bound it with.
 */
const DRAIN_READS_IN_GRACE = Math.ceil(TEARDOWN_GRACE_MS / DRAIN_POLL_MS);

/**
 * Blocks this thread for `ms`, which is the only way to wait inside an exit
 * handler at all: no timer fires and no promise settles once a process is on
 * its way out, so a teardown that asked and then yielded would have yielded to
 * nothing and its escalation would leave with it.
 */
function blockFor(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Reads `standing` until it answers false or the grace is spent, blocking
 * between readings. What it prices is the chance for an ask to be acted on; it
 * decides nothing, because the reading is what answers.
 */
function untilDrained(standing: () => boolean, pause: (ms: number) => void): void {
  for (let read = 0; read < DRAIN_READS_IN_GRACE; read += 1) {
    if (!standing()) return;
    pause(DRAIN_POLL_MS);
  }
}

/**
 * Ends every tree given, asking first and insisting second.
 *
 * The ask goes to the child alone rather than to its group, because a
 * supervisor's own shutdown is the only thing that reaches the tasks it moved
 * into groups of their own — signalling the group would reach the tasks this
 * process can see and leave the ones it cannot. The group signal is the
 * fallback for a tree that did not take the hint, and it is `SIGKILL` because a
 * tree that ignored a terminating signal will ignore another one.
 *
 * A tree stops being pending when its group empties, never when its child
 * exits: the ask reaches one process, and what a chain here puts in that
 * group alongside it is the fork doing the work. Reading the child's exit as
 * the tree's would retire exactly the tree nothing has reached yet
 * ({@link treeIsStanding}).
 */
export async function endTrees(
  trees: Iterable<StartedTree>,
  deps: EndTreesDeps = {}
): Promise<void> {
  const targets = [...trees];
  if (targets.length === 0) return;

  const ask =
    deps.ask ??
    ((pid: number): void => {
      // The group is asked before the process is, because what is being read
      // here is a record and a record outlives what it named: an id whose group
      // has emptied is the kernel's to hand to unrelated work, so a process
      // answering to it is evidence of nothing. Reading the process first is
      // what would signal whatever took the number.
      if (!treeIsStanding(pid, process.platform)) return;
      // The leader, while there is a leader: it is what relays the ask to
      // whatever it supervises, including the tasks it moved out of this group
      // and out of reach of every signal aimed here. Once it has gone there is
      // nothing to relay through, and the group it led is the only thing a
      // courtesy can still reach — which is what gives the fork left in that
      // group the chance to end what it escaped with.
      if (leaderIsStanding(pid)) signalTolerantly(pid, 'SIGTERM', sendSignal);
      else killTree(pid, 'SIGTERM');
    });
  const force =
    deps.force ??
    ((pid: number): void => {
      killTree(pid, 'SIGKILL');
    });

  const pending = new Set(targets);
  const stopped = targets.map(async (tree) => {
    await tree.exit;
    // The child's exit answers for the child; what the ask has to empty is the
    // group, and a process acting on a courtesy signal takes a moment to do it.
    // Read once here and the answer is always "still there", so the escalation
    // would land before the ask it is supposed to be escalating from.
    //
    // Polled because a group's emptying is not an event anything can wait on,
    // and bounded by the grace the race below applies to all of this — never by
    // a count of reads. A loop still running when that grace ends keeps no
    // timer the process must wait for, and the escalation is what ends it.
    while (treeIsStanding(tree.pid, process.platform)) await afterDrainTick();
    pending.delete(tree);
  });
  for (const tree of targets) ask(tree.pid);

  await Promise.race([Promise.all(stopped), (deps.grace ?? afterGrace)()]);
  for (const tree of pending) force(tree.pid);
}

/** One tree a forwarder watches: how to end it, and whether it is still there. */
interface WatchedTree {
  /** Ends it with whatever the parent was asked to take. */
  readonly end: (signal: KillSignal) => void;
  /**
   * Whether it still holds processes. The forwarder reads it rather than
   * deciding for itself, because what a recorded id addresses is the spawn's to
   * answer and the answer changes under the forwarder's feet.
   */
  readonly standing: () => boolean;
}

interface TreeForwarderDeps {
  readonly on: (signal: TreeSignal, handler: (signal: TreeSignal) => void) => void;
  readonly off: (signal: TreeSignal, handler: (signal: TreeSignal) => void) => void;
  readonly onExit: (handler: () => void) => void;
  readonly offExit: (handler: () => void) => void;
  /** Lets a repeated signal reach the default action it was suppressing. */
  readonly reraise: (signal: TreeSignal) => void;
  /** Injected so a case asserting over the way out never pays the real budget. */
  readonly pause?: (ms: number) => void;
}

export interface TreeForwarder {
  /** Watches a tree until the returned function is called. */
  add(tree: WatchedTree): () => void;
}

/**
 * Passes on what the parent is asked to do, to every tree it started.
 *
 * A detached child is not in the terminal's foreground group, so Ctrl+C reaches
 * the parent alone; forwarding is what puts the child back on the same footing
 * a non-detached one had. Listening for a signal also suppresses its default
 * action, which would leave a parent whose child ignores the signal
 * unstoppable — so the second occurrence of a signal ends every tree outright
 * and then re-raises, giving the operator back the escalation they expect from
 * pressing Ctrl+C twice.
 *
 * ENDING THE TREES IS PART OF THE ESCALATION, NOT A COURTESY BEFORE IT. What
 * re-raising hands the process to is the default action, which runs no handler
 * of any kind — so a tree still standing at that moment is one nothing will
 * ever end, and the operator gets their prompt back beside a live tree holding
 * claims, addresses and directories. It is `SIGKILL` for the same reason the
 * teardown's own second attempt is: this tree has already been asked once, with
 * the signal it was asked with, and did not go. Being uncatchable is also what
 * keeps the escalation immediate — a second ask could be ignored exactly as the
 * first one was, and waiting for the tree to act on it would be the hang the
 * operator pressed Ctrl+C twice to escape.
 *
 * The exit handler stands in for execa's `cleanup`, which `detached` disables.
 * It is not a second reaping mechanism: reaping-on-next-run answers a killed
 * parent, and this answers one that returned.
 */
export function createTreeForwarder(deps: TreeForwarderDeps): TreeForwarder {
  const targets = new Set<WatchedTree>();
  const forwarded = new Set<TreeSignal>();
  let attached = false;

  function endEveryTree(): void {
    for (const tree of targets) tree.end('SIGKILL');
  }

  function onSignal(signal: TreeSignal): void {
    if (forwarded.has(signal)) {
      endEveryTree();
      detach();
      deps.reraise(signal);
      return;
    }
    forwarded.add(signal);
    for (const tree of targets) tree.end(signal);
  }

  /**
   * ASKING IS NOT A COURTESY HERE, IT IS THE ONLY THING THAT REACHES THE NEXT
   * HOP. A tree still standing when this process returns is a tree nothing ever
   * signalled: a stage whose child died out from under it is one the wrapper
   * calls finished, so it is reported and exited rather than stopped. A group
   * signal reaches the processes in that group and nothing those processes put
   * in groups of their own, and `SIGKILL` cannot be caught — so insisting
   * straight away ends the one process that could have passed the stop on, and
   * leaves what it supervised running under nobody, which is a killed run
   * finishing its work. The ask is what each member relays, the wait is what
   * gives it time to, and the escalation is for a tree that did not take it.
   *
   * The escalation {@link createTreeForwarder} runs on a repeated signal keeps
   * `SIGKILL` outright, and the difference is that a first signal was already
   * forwarded there: the ask has been made, and waiting for it to be acted on
   * is the hang the operator pressed Ctrl+C twice to escape.
   *
   * Read before it is signalled and again before it is insisted on, because an
   * id whose group has emptied names nothing this process started any more.
   */
  function onExit(): void {
    const asked = [...targets].filter((tree) => tree.standing());
    if (asked.length === 0) return;
    for (const tree of asked) tree.end('SIGTERM');
    untilDrained(() => asked.some((tree) => tree.standing()), deps.pause ?? blockFor);
    for (const tree of asked) if (tree.standing()) tree.end('SIGKILL');
  }

  function attach(): void {
    if (attached) return;
    attached = true;
    for (const signal of FORWARDED_SIGNALS) deps.on(signal, onSignal);
    deps.onExit(onExit);
  }

  function detach(): void {
    if (!attached) return;
    attached = false;
    for (const signal of FORWARDED_SIGNALS) deps.off(signal, onSignal);
    deps.offExit(onExit);
  }

  return {
    add(tree: WatchedTree): () => void {
      targets.add(tree);
      attach();
      return (): void => {
        targets.delete(tree);
        if (targets.size === 0) detach();
      };
    },
  };
}

/** Binds the forwarder to this process, which is what it watches in production. */
function processForwarderDeps(): TreeForwarderDeps {
  return {
    on: (signal, handler) => {
      process.on(signal, handler);
    },
    off: (signal, handler) => {
      process.off(signal, handler);
    },
    onExit: (handler) => {
      process.on('exit', handler);
    },
    offExit: (handler) => {
      process.off('exit', handler);
    },
    /* v8 ignore next 3 -- re-raising ends the process, which inside a test run
       is the vitest worker; `createTreeForwarder` covers the decision to
       re-raise against an injected host. */
    reraise: (signal) => {
      process.kill(process.pid, signal);
    },
  };
}

let sharedForwarder: TreeForwarder | undefined;

/** Trees this process started that have not been observed to end. */
const startedTrees = new Map<number, StartedTree>();

/**
 * What a leader exits with once it has ended its tree because its spawner
 * died. Nothing is left above to read it — the process it would report to is
 * the one that went — and it is a failure code because the work the leader was
 * started for did not finish.
 */
const SPAWNER_GONE_EXIT_CODE = 1;

/* v8 ignore next 4 -- ending this process is what it does, and the process
   measuring coverage is a vitest worker; `spawner-death.test.ts` drives it in a
   real leader, whose lines are nobody's coverage. */
async function endTreesAndExit(): Promise<void> {
  await endTrees(startedTrees.values());
  process.exit(SPAWNER_GONE_EXIT_CODE);
}

/** The socket a process answers its children on, for as long as it lives. */
export interface LifelineHost {
  readonly address: string;
  /**
   * Stops answering, removing a POSIX socket's file with it. A process does
   * this for itself on the way out, so it is here for a case that has to end
   * the answer without ending the process running it.
   *
   * A process killed too hard to run it at all leaves its socket file behind,
   * and what becomes of that file is {@link reclaimLifelineSockets}'s, on the
   * terms stated there. Until then the file is inert: a connect to it is
   * refused, which is the same answer the connection itself would have given.
   */
  close(): void;
}

/**
 * Starts answering at `address`, and resolves once the socket is accepting: the
 * children this process is about to start may connect before it is scheduled
 * again, so nothing may be spawned until this has resolved.
 *
 * A connection is accepted and then left entirely alone. Nothing is ever
 * written to it and nothing is ever read from it, because the connection says
 * one thing and says it by ending when this process does. Both the listener and
 * every connection are unrefed, so a child holding one can never be the reason
 * this process stays alive.
 */
export async function hostLifeline(address: string): Promise<LifelineHost> {
  const server = createServer((connection) => {
    connection.unref();
  });
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(address, () => {
      server.off('error', reject);
      resolve();
    });
  });

  // Closed on the way out, and not left to the runtime, which does this only
  // for a process whose loop runs dry. Every command here ends by naming its
  // exit code instead, and that path closes nothing — so without this a socket
  // file would be left behind by every run rather than only by a process killed
  // too hard to run anything.
  /* v8 ignore next 3 -- it runs as this process ends, which a case inside one
     cannot arrange without ending the vitest worker; what it does is
     {@link LifelineHost.close}, which cases drive directly. */
  const closeOnExit = (): void => {
    server.close();
  };
  process.on('exit', closeOnExit);

  return {
    address,
    close: () => {
      process.off('exit', closeOnExit);
      server.close();
    },
  };
}

/** A connection to the spawner's socket, which reports the one thing it can say. */
interface Lifeline {
  onEnded(handle: () => void): void;
}

/**
 * What a connect answers for a spawner that is not there. The address names
 * nothing because the socket went with its process; it names a socket nobody
 * answers on because that process was killed too hard to remove it; or the
 * answer is withdrawn mid-connect because the process went in that instant.
 * All three are the spawner having gone, which is what the connection itself
 * would have said by ending a moment later.
 *
 * Every other failure is something else entirely — a descriptor limit, a
 * permission — and treating one of those as a death would tear down a live
 * tree, so they are raised instead.
 */
const SPAWNER_GONE_CODES = new Set(['ENOENT', 'ECONNREFUSED', 'ECONNRESET']);

/**
 * Whether a failed connection is the spawner having gone rather than something
 * else. A failure after the connection was made is that connection breaking,
 * which is exactly the death this watches for; a failure before it is only that
 * death when the address answered with one of {@link SPAWNER_GONE_CODES}.
 *
 * An error carrying no code at all is not one of them, and is raised like any
 * other unrecognised failure.
 */
export function isSpawnerGone(connected: boolean, code?: string): boolean {
  return connected || SPAWNER_GONE_CODES.has(String(code));
}

/**
 * Connects to the spawner's socket and reports its end.
 *
 * Nothing here is asked for, polled or timed: while the spawner lives the
 * connection simply stays open, and the moment its last handle closes — an
 * ordinary exit, a crash, a `SIGKILL` nothing can catch — this end sees
 * end-of-file. That is a kernel fact arriving as an event, which is why no part
 * of this consults a clock.
 *
 * A connection that was refused is the same fact arriving at once, for a
 * spawner that had already gone before this process looked.
 */
export function connectLifeline(address: string): Lifeline {
  const socket = createConnection(address);
  socket.unref();
  let connected = false;
  socket.on('connect', () => {
    connected = true;
  });
  return {
    onEnded: (handle) => {
      socket.on('error', (error: NodeJS.ErrnoException) => {
        /* v8 ignore next 2 -- raising here ends the process, which inside a
           test run is the vitest worker; the decision that reaches it is
           {@link isSpawnerGone}, driven directly against every answer a
           connect can give. */
        if (!isSpawnerGone(connected, error.code)) throw error;
      });
      // Reached from every one of them: an end-of-file, a refusal and a broken
      // connection all close this end, and a close is what the answer hangs off.
      socket.on('close', handle);
    },
  };
}

/**
 * Arranges for `onGone` to run when the process that started this one goes,
 * whatever took it — including a signal it could not catch, which is the case
 * no handler in this file can answer. Says whether it found a spawner to watch.
 *
 * A process the spawner started always carries the address, so the variable
 * being absent means one thing only: nothing above this process runs this
 * module, and it is the head of its chain. That case has no watcher-shaped
 * answer — the process above holds no socket to close — and is reached only by
 * not having that process at all.
 *
 * A variable that is present and names nothing is the failure this whole
 * mechanism exists to make impossible: a spawner started this process and it
 * cannot watch what started it. Running on unarmed is what the descriptor this
 * replaced did, silently, in every production chain, so this raises instead.
 *
 * The residual this cannot close, and neither can anything else here: a leader
 * killed with `SIGKILL` runs no code, so its own tree is orphaned exactly as
 * before, and a supervisor's tasks are only reached because the supervisor is
 * asked to stop rather than because they can be signalled.
 */
export function watchSpawner(
  env: NodeJS.ProcessEnv,
  connect: (address: string) => Lifeline,
  onGone: () => void
): boolean {
  const address = env[LIFELINE_ENV];
  if (address === undefined) return false;
  if (address.length === 0) {
    throw new Error(
      `${LIFELINE_ENV} is set and names no address, so this process was started by a spawner ` +
        `and cannot watch what started it. A lifeline that is silently absent is the defect ` +
        `this mechanism exists to remove, so it fails here rather than running on unarmed.`
    );
  }
  connect(address).onEnded(onGone);
  return true;
}

/**
 * Everything a process arms for the trees it starts: forwarding what it is
 * asked, and watching what started it.
 *
 * Armed at the first spawn rather than at import, because a leader is a process
 * holding a tree and there is nothing to tear down before it holds one. The
 * window that leaves is a process killed between its own start and its first
 * spawn, which owns nothing and is the claim registry's case rather than this
 * one's.
 */
function armProcessTeardown(): TreeForwarder {
  watchSpawner(
    process.env,
    connectLifeline,
    /* v8 ignore next 3 -- what it does is end this process, which inside a test
       run is the vitest worker; the real-chain cases drive it in processes of
       their own, whose lines are nobody's coverage. */
    () => {
      void endTreesAndExit();
    }
  );
  return createTreeForwarder(processForwarderDeps());
}

function thisProcessTeardown(): TreeForwarder {
  sharedForwarder ??= armProcessTeardown();
  return sharedForwarder;
}

export interface LongLivedOptions {
  /**
   * The host ports this tree is expected to bind, recorded against the run's
   * claim before the child starts. Named at every call site, never defaulted:
   * a spawn that binds nothing says so, and a spawn whose ports nobody stated
   * would be reclaimable only through its process group.
   */
  readonly ports: readonly number[];
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** Where the child's output goes. Named at every call site, never defaulted. */
  readonly stdio: 'inherit' | 'ignore';
  /** Resolve the executable from the package at {@link LongLivedOptions.localDir} first. */
  readonly preferLocal?: boolean | undefined;
  readonly localDir?: string | undefined;
  /** Injected so the platform branch is testable off that platform. */
  readonly platform?: NodeJS.Platform | undefined;
  /** Injected so a test can drive forwarding without arming this process. */
  readonly forwarder?: TreeForwarder | undefined;
  /**
   * Injected so a case can hold the record open while the child it names ends,
   * which is the window the exit handle has to be built before rather than
   * after. A real write takes a fraction of a millisecond, so racing one is not
   * something a case can arrange.
   */
  readonly record?: typeof addSpawnedProcess | undefined;
}

export interface LongLivedChild {
  readonly pid: number;
  /**
   * What a reclaimer addresses the tree by. It equals the pid on both
   * platforms — on POSIX because a detached child leads its own group, on
   * Windows because `taskkill /T` walks down from the pid itself.
   */
  readonly pgid: number;
  /** The exit code once the child has gone. Never rejects. */
  readonly exit: Promise<number>;
  /**
   * Signals the whole tree and resolves with the child's own exit code, at the
   * child's own exit — which is not the moment the tree is gone. A grandchild
   * can be alive past it, reparented away and running rather than awaiting a
   * reap; on POSIX one that put itself in a session of its own is outside the
   * group the signal addresses and is never reached.
   */
  kill(signal?: KillSignal): Promise<number>;
}

type StdioEntry = 'inherit' | 'ignore';

/** The three standard streams, and nothing past them. */
type StdioLayout = readonly [StdioEntry, StdioEntry, StdioEntry];

interface SpawnOptions {
  readonly stdio: StdioLayout;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly localDir?: string;
  readonly preferLocal: boolean;
  readonly detached: boolean;
  readonly reject: false;
}

/** An optional key is omitted rather than passed as `undefined`, which execa refuses. */
function spawnOptions(
  options: LongLivedOptions,
  platform: NodeJS.Platform,
  address: string
): SpawnOptions {
  const stream = options.stdio;
  return {
    stdio: [stream, stream, stream],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    // Always stated, never merely omitted. The address this process inherited
    // is in the environment the child extends, and leaving it there would have
    // the child watch a process further up while this one — the process that
    // actually started it — went unwatched.
    env: { ...options.env, [LIFELINE_ENV]: address },
    ...(options.localDir === undefined ? {} : { localDir: options.localDir }),
    preferLocal: options.preferLocal ?? false,
    detached: platform !== 'win32',
    reject: false,
  };
}

let processLifeline: Promise<LifelineHost> | undefined;

/**
 * The socket this process answers on, opened at its first spawn and held for
 * the rest of its life.
 *
 * One socket serves every child, however many it starts and however deep their
 * own trees go: what a watcher learns is that the process which started it has
 * gone, and that is one process. The real platform decides the address form,
 * never an injected one — a case naming the other platform would otherwise have
 * this host try to bind an address it cannot, and what such a case is for is
 * proving which form was chosen, which {@link lifelineAddress} answers on its
 * own.
 */
function thisProcessLifeline(): Promise<LifelineHost> {
  processLifeline ??= openProcessLifeline();
  return processLifeline;
}

/**
 * Opens this process's socket, having first claimed the file it is about to
 * make, and hands the run a way to let go of it before the claim goes.
 *
 * Claim before create: a claim naming a socket that was never made is
 * harmless, and a file made before anything claimed it is debris no reclaimer
 * may attribute to a run — what becomes of one is then
 * {@link reclaimLifelineSockets}'s decision, on the terms stated there, and
 * this order is what makes that decision sound. A process holding no run claim
 * records nothing and leaves exactly that.
 *
 * Drop before release is the same rule read backwards, and the exit handler
 * alone cannot keep it: the run removes its record while the process that made
 * the socket is still running, so a file only that handler removes stands for a
 * window in which nothing names it. Registering the close against the record is
 * what closes that window, and it is registered only where the record exists to
 * be raced.
 *
 * Windows names a pipe rather than a file, and a pipe goes with the process
 * that held it, so there is nothing there to claim and nothing to reclaim.
 */
async function openProcessLifeline(): Promise<LifelineHost> {
  const { platform } = process;
  const address = lifelineAddress(
    randomBytes(LIFELINE_NONCE_BYTES).toString('hex'),
    platform,
    lifelineSocketDir()
  );
  if (platform !== 'win32' && (await recordOwnedResourceIfClaimed('socket', address))) {
    releaseBeforeRecordDrops(closeProcessLifeline);
  }
  return hostLifeline(address);
}

/**
 * Stops answering on this process's socket, takes its file with it, and lets
 * the next spawn open one of its own.
 *
 * Called by the run that recorded the socket, before that run's record goes,
 * and by anything that has to end the answer without ending the process running
 * it — a test runner signalling the worker it is finished with reaches no
 * handler here. The handler {@link hostLifeline} installs on the way out
 * answers neither: it runs after the record has gone, and a process something
 * else ends never reaches it at all. It ends the answer, never the process, and
 * a child already holding a connection keeps it: closing a listener stops it
 * accepting and leaves every connection it accepted alone.
 */
export async function closeProcessLifeline(): Promise<void> {
  const opened = processLifeline;
  processLifeline = undefined;
  if (opened === undefined) return;
  const host = await opened;
  host.close();
}

/** What a child says about having ended: the state it carries, and the event it fires. */
export interface ChildExitReport {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: 'exit', listener: (code: number | null) => void): void;
}

/**
 * The status a child ended with, taken from the state it already carries when
 * it has one and from its own event otherwise.
 *
 * State first, notification second, and never the notification alone: the
 * event fires once, at the moment it happens, so a child already reaped fired
 * it at nobody and a listener arriving afterwards waits for a second one that
 * never comes. Both halves of the state answer that question, because a child
 * a signal ended carries no exit code at all — asking only for the code would
 * leave exactly that child unanswered.
 *
 * A `null` status is what a signal leaves behind, and is the caller's to
 * translate.
 */
export function untilChildExit(child: ChildExitReport): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve(code);
    });
  });
}

/**
 * Starts a long-lived child, records its tree against the enclosing run's claim
 * before returning, and hands back a handle that ends the tree rather than its
 * root.
 *
 * WHAT THE RECORD BUYS, AND WHAT IT DOES NOT. It makes the tree *nameable*,
 * and everything done with a recorded group is done by reading the record back
 * through {@link readRecordedProcessGroups} and asking the claim beside it
 * whether the run that started the tree is still there — the world audit
 * classifies one that way, {@link reclaimProcessGroups} ends the ones an
 * expired claim names, and anything added later reaches a group the same way or
 * not at all. On what evidence one may be signalled, and the cost of a reusable
 * id, that reclaim is where it is stated.
 *
 * What the record does not buy is reach. A recorded id names the group its
 * leader was put in, so a descendant a supervisor moved into a group of its own
 * is outside everything built on this record; the ports the tree bound are the
 * handle that survives that difference, being read off the machine rather than
 * out of a record.
 *
 * A process holding no run claim still gets its child, and records nothing.
 * What it started is then outside all of it — a group nothing recorded is one
 * no reading enumerates, so no line reports it and no pass ends it, and the
 * *unowned* verdict spelled for the kind is unreachable. The ports such a child
 * binds are reported, being scanned rather than read out of a record. Nothing
 * here can invent an owner for what such a child leaves behind, and inventing
 * one would license exactly the destruction the claim design exists to
 * prevent.
 */
export async function spawnLongLived(
  file: string,
  args: readonly string[],
  options: LongLivedOptions
): Promise<LongLivedChild> {
  const platform = options.platform ?? process.platform;
  const owned = currentRunId() !== null;

  // Claimed before the child that binds them exists. A claim naming a port
  // nothing ever bound is harmless; a port bound before anything claimed it is
  // an orphan by construction.
  if (owned) {
    for (const port of options.ports) await addResource({ kind: 'port', id: String(port) });
  }

  // Answering before the child exists, never after: a child fast enough to
  // connect before this process is scheduled again must find something there.
  const { address } = await thisProcessLifeline();

  const child = execa(file, [...args], spawnOptions(options, platform, address));

  const { pid } = child;
  if (pid === undefined) {
    // The runtime's own name for the failure, read off the result rather than
    // composed here. Rejection is off, so a spawn that never produced a process
    // reports itself as the result's code and nothing raises on its own;
    // dropping it left a message that named the file and no reason, which reads
    // as a process-supervision fault to anyone who has one in mind.
    const { code } = await child;
    /* v8 ignore next -- a subprocess with no pid failed at the spawn itself, and
       every such failure the runtime reports names a code; the alternative is
       here because the result type admits a result without one. */
    const failure = code ?? 'no code';
    throw new Error(
      `\`${file}\` did not start: the spawn failed with ${failure}, so there is no tree to record or to reap.`
    );
  }

  const stopWatching = (options.forwarder ?? thisProcessTeardown()).add({
    // Only while the group still has members. A tree is kept here past its
    // leader's exit, and the id it is kept under is the kernel's to reissue the
    // moment the group empties — so asking first is what keeps an escalation
    // from reaching whatever took the number next.
    end: (signal) => {
      if (treeIsStanding(pid, platform)) killTree(pid, signal, { platform });
    },
    standing: () => treeIsStanding(pid, platform),
  });

  // An arrow rather than a declaration, so that what the checker knows about
  // `pid` on the line above still holds inside it.
  //
  // The child's own exit, never the process library's result: that result
  // arrives once every stream the child was given has ended too, which makes it
  // an answer about the streams as much as about the process. A code of `null`
  // means a signal ended the child, which is a failure to whoever asked for the
  // work.
  //
  // Reached through the runtime process the library wraps, which is where the
  // exit state lives: the library's own handle exposes no such state, and
  // reading it off that handle answers `undefined` for a child still running —
  // a value nothing downstream can tell from a real one.
  const untilExit = async (): Promise<number> => {
    const status = await untilChildExit(child.nodeChildProcess);
    // Let go of the tree only once the group it leads has emptied. The child
    // exiting answers what the caller asked for and says nothing about what is
    // still in the group beside it ({@link treeIsStanding}); letting go here
    // regardless is what left a killed run's work running under nothing.
    if (!treeIsStanding(pid, platform)) {
      stopWatching();
      startedTrees.delete(pid);
    }
    return status ?? 1;
  };
  // Built here, with nothing awaited between it and the spawn: a child that
  // ends while this function is still on its way to returning must have
  // somewhere to report that to. Everything downstream — the handle a caller
  // waits on, the teardown entry, the watcher's removal — hangs off it.
  const exit = untilExit();
  // What this process ends if its own spawner goes. The removal above sits
  // behind an await, so it cannot run before this line puts the tree in.
  startedTrees.set(pid, { pid, exit });

  // Recorded before the caller waits for readiness, never after: a run killed
  // during that wait must still leave a record naming what it started.
  if (owned) await (options.record ?? addSpawnedProcess)({ pid, pgid: pid });

  return {
    pid,
    pgid: pid,
    exit,
    async kill(signal: KillSignal = 'SIGTERM'): Promise<number> {
      killTree(pid, signal, { platform });
      return exit;
    },
  };
}
