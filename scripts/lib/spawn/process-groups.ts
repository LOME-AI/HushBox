/**
 * The process groups a run recorded: whether one still stands, whose it is, and
 * ending the ones this run is answerable for.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  RUN_CLAIM_ENV,
  claimsDir,
  enumerateClaims,
  retireRecordedGroup,
} from '../claims/registry.js';
import { GROUP_FIELD, STATE_FIELD, parseProcStatRecord } from '../proc-stat.js';
import { killTree } from './kill-tree.js';
import type { KillTreeDeps } from './kill-tree.js';

/** The run record a recorded group is read out of, as the registry hands it over. */
type RecordedRunClaim = Awaited<ReturnType<typeof enumerateClaims>>[number]['claim'];

/**
 * A process group a run recorded, and the record of the run that recorded it.
 *
 * The registry is the only enumerator this class has — a group is found by
 * reading the record of the run that started it, never by scanning the machine
 * — so a descendant a third-party supervisor moved into a group of its own is
 * outside every reading here, outside every line built from one, and outside
 * what {@link reclaimProcessGroups} ends. The ports such a tree bound are the
 * handle that survives the difference, and the port reclaim is what uses them.
 */
interface RecordedProcessGroup {
  readonly pgid: number;
  /** Whether the run that recorded it still holds its claim. */
  readonly runLive: boolean;
  /** That run's own record, so a caller can say what the tree was. */
  readonly claim: RecordedRunClaim;
}

/**
 * Whether anything is still in process group `pgid`, asked with signal zero:
 * the probe that delivers no signal at all. A reusable id is not licence to end
 * anything, and it is not a clock either — the group either has members or it
 * does not, and nothing here waits to find out.
 *
 * A group nobody may signal answers that it exists, which is the honest reading
 * of a tree that is still there; one with no members answers that it is gone.
 */
export function groupIsAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether negating `pgid` addresses one tree. Zero and one negate into every
 * process this user may signal, so a record carrying either names nothing a
 * pass can answer for — and acting on one would reach whatever else happened to
 * answer.
 */
export function addressesOneTree(pgid: number): boolean {
  return Number.isInteger(pgid) && pgid > 1;
}

/**
 * Where a kernel reports what every process on the machine is doing. Absent
 * wherever there is no process filesystem, which is what {@link
 * groupHoldsLiveProcess} answers by declining rather than by guessing.
 */
const PROC_ROOT = '/proc';

/** The state a process wears between exiting and being collected by its parent. */
const CORPSE_STATE = 'Z';

/** What one `/proc/<pid>/stat` line says about the process it describes. */
interface ProcGroupState {
  readonly pgrp: number;
  /** One letter, of which only {@link CORPSE_STATE} means the process no longer runs. */
  readonly state: string;
}

/**
 * Reads the group and the run state out of one `/proc/<pid>/stat` line.
 *
 * Where those fields stand is {@link parseProcStatRecord}'s; what this adds is
 * this caller's notion of readable. A line carrying no state or no numeric
 * group is one it declines rather than one it guesses at: the caller treats an
 * unreadable process as nothing, and a misread group would be a live process
 * counted into a stranger's tree.
 */
export function parseProcStatGroupState(content: string): ProcGroupState | undefined {
  const record = parseProcStatRecord(content);
  if (record === undefined) return undefined;
  const state = record.fields[STATE_FIELD];
  const pgrp = Number(record.fields[GROUP_FIELD]);
  if (state === undefined || state.length === 0 || !Number.isInteger(pgrp)) return undefined;
  return { pgrp, state };
}

/**
 * Content of a `/proc` file, empty where the read failed — which is what an
 * absent file means here anyway: the process went between the listing and the
 * read, and a process that is gone is in no group.
 */
function readProcFile(pathname: string): string {
  try {
    return readFileSync(pathname, 'utf8');
  } catch {
    /* v8 ignore next -- the process exited between the listing and the read; normal churn */
    return '';
  }
}

/**
 * Whether process group `pgid` holds a process that still runs, as against
 * corpses — processes that have exited and whose parent has not collected them.
 *
 * THE DISTINCTION IS WHAT AN EXIT PATH DEPENDS ON, AND A SIGNAL CANNOT MAKE IT.
 * A parent collects a dead child in its event loop, so a child that dies while
 * its parent is on the way out is never collected: it keeps its place in its
 * group for as long as that parent is there, and {@link groupIsAlive} — which
 * counts members, because membership is all a signal can ask about — answers
 * that the tree is standing. A stop that waits for the group to empty would
 * then spend its entire budget on a tree that went the moment it was asked, and
 * escalate onto a corpse.
 *
 * Read rather than signalled, and read of the kernel's own record of which
 * group each process is in — nothing here is matched by name, and nothing here
 * ends anything. The recorded group id stays the only thing a signal is ever
 * aimed at.
 *
 * Undefined where there is no process filesystem to read, which is every
 * platform but Linux. A caller with no answer keeps the group's own, which is
 * the reading this refines rather than replaces.
 */
function groupHoldsLiveProcess(pgid: number): boolean | undefined {
  let entries: string[];
  try {
    entries = readdirSync(PROC_ROOT);
  } catch {
    /* v8 ignore next -- every platform this runs on has a process filesystem */
    return undefined;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    const found = parseProcStatGroupState(readProcFile(path.join(PROC_ROOT, entry, 'stat')));
    if (found?.pgrp === pgid && found.state !== CORPSE_STATE) return true;
  }
  return false;
}

/**
 * Whether the tree a spawn recorded still holds a process that runs.
 *
 * **A leader exiting is not the tree ending, and treating it as one is how a
 * killed run came to finish its work.** The runner's command line does not
 * become the script it was handed: it forks the process that does the work into
 * the group the spawn recorded and waits on it. Lose that one process — killed
 * on its own, or exiting first — and the group is still populated while the
 * process that recorded it has already been told its child is gone. Everything
 * hung off that notification then lets go at once: the teardown stops naming
 * the group, the wrapper above calls the stage finished, and the run releases
 * the claim whose record was the group's only name. What is left runs to
 * completion under no owner at all.
 *
 * Asked of the group rather than of the leader, which is the one handle that
 * survives the difference, and asked rather than remembered — a recorded id
 * stops meaning anything the moment nothing is in the group, because the kernel
 * is then free to hand the number to unrelated work.
 *
 * Membership is not the whole answer, and the half it misses is the ordinary
 * stop rather than the wedged one: a child that dies while the process that
 * started it is on its way out is never collected, and a corpse holds its place
 * in the group ({@link groupHoldsLiveProcess}).
 *
 * Windows has no process group to ask and needs none: the recorded id is a pid
 * that `taskkill /T` walks down from, and the job object is what bounds the
 * child. Answered `true` there so no caller skips a kill on the strength of a
 * question that platform cannot answer.
 */
export function treeIsStanding(pgid: number, platform: NodeJS.Platform): boolean {
  if (!recordedGroupAddressesATree(platform)) return true;
  // The signal first, because it is the cheap answer and the common one: a
  // group with no members at all is answered without reading anything. What the
  // read adds is the case that answer cannot reach, a group whose remaining
  // members are corpses ({@link groupHoldsLiveProcess}).
  if (!groupIsAlive(pgid)) return false;
  return groupHoldsLiveProcess(pgid) ?? true;
}

/**
 * Whether the one process a record names is still there, asked with signal
 * zero — the probe that delivers no signal at all.
 *
 * The group's own question is {@link treeIsStanding}, and the two differ in
 * exactly the case this file exists to answer: a leader that has gone out from
 * under a group that has not. A process this user may not signal answers that
 * it is there, which is the honest reading of one that is.
 */
export function leaderIsStanding(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Whether a recorded id addresses a process tree on `platform`. This is the
 * canonical statement of that fact, linked from wherever it decides something:
 * the reclaim below, and the world audit's note about the class it cannot cover.
 *
 * On Windows the platform has no process group at all — the spawner in
 * `scripts/lib/spawn/long-lived.ts` records the pid a job object stands in for
 * — so a recorded id there names
 * nothing this mechanism may signal or ask after, and both the reclaim and the
 * report say so rather than acting on the number.
 *
 * What this stands on, since nothing observes it: the premise is reasoned from
 * that platform's documentation and from the runtime's own source, never
 * observed. Falsifying it would take a real Windows kernel and a real group,
 * and neither this function nor either caller's branch reaches one — they
 * return a boolean and a sentence. A case pinning the platform proves the
 * branch is chosen and nothing about the platform, on any machine it runs on.
 */
export function recordedGroupAddressesATree(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

/**
 * Every process group the registry records, with the record of the run that
 * recorded each.
 *
 * Live wins where two runs recorded the same id, on the same rule and for the
 * same reason as the resource index: an id is reissued once its first holder
 * dies, and the run that reissued it is the one still able to be harmed.
 *
 * One enumeration, imported by both readers of it, because they decide the same
 * thing at two moments — the report says a tree is an orphan and the reclaim
 * ends it — and two spellings of "which claim owns this, live wins" would be
 * free to disagree about a destruction.
 */
export async function readRecordedProcessGroups(
  registryDir?: string
): Promise<RecordedProcessGroup[]> {
  const recorded: RecordedProcessGroup[] = [];
  for (const found of await enumerateClaims(registryDir)) {
    for (const spawned of found.claim.spawned) {
      recorded.push({
        pgid: spawned.pgid,
        runLive: found.state === 'owned-live',
        claim: found.claim,
      });
    }
  }
  const byGroup = new Map<number, RecordedProcessGroup>();
  for (const group of recorded) if (!group.runLive) byGroup.set(group.pgid, group);
  for (const group of recorded) if (group.runLive) byGroup.set(group.pgid, group);
  return [...byGroup.values()];
}

/**
 * Whether a failed signal is one the operating system refused this user
 * permission to send.
 *
 * One code reaches this and it comes from the kernel: `EPERM`, where the group
 * the record names now holds a process this user may not signal. A group that
 * has already gone never reaches here at all — {@link killTree} treats `ESRCH`
 * as the outcome that was wanted — so every other failure is this pass having
 * gone wrong rather than a tree it may not touch.
 *
 * What a caller does with the answer is its own, and it is the same choice a
 * refused socket removal offers: both of this repository's commands step over
 * such a tree, for the reason {@link reclaimProcessGroups} states.
 */
export function groupSignalWasRefused(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  return (error as NodeJS.ErrnoException).code === 'EPERM';
}

/**
 * What the processes now in a group say about who started them: every one of
 * them carrying the record of the run whose claim names the group, one of them
 * carrying something else, or a group this pass could not read at all.
 */
type GroupAttribution = 'this-run' | 'not-this-run' | 'unanswerable';

/** A group left running, in the two answers that leave one running. */
type SparedAttribution = Exclude<GroupAttribution, 'this-run'>;

/** Where the kernel publishes what it knows about a live process. */
const PROC_DIR = '/proc';

/** Every process the kernel has an entry for, or nothing where it cannot be asked. */
async function livePids(): Promise<number[] | null> {
  try {
    const entries = await readdir(PROC_DIR);
    return entries.filter((name) => /^\d+$/.test(name)).map(Number);
  } catch {
    return null;
  }
}

/**
 * The group `pid` is in, out of the kernel's own line about it, or nothing
 * where that line could not be read — ordinarily the process having gone
 * between being listed and being asked about, and on a `/proc` mounted to hide
 * other users' processes, one of theirs. Either way it is no member of a tree
 * this repository started, and a caller counting members leaves it out.
 */
export async function processGroupOf(pid: number): Promise<number | null> {
  let line: string;
  try {
    line = await readFile(path.join(PROC_DIR, String(pid), 'stat'), 'utf8');
  } catch {
    return null;
  }
  const record = parseProcStatRecord(line);
  if (record === undefined) return null;
  const pgid = Number(record.fields[GROUP_FIELD]);
  return Number.isInteger(pgid) ? pgid : null;
}

/** Every process now in `pgid`, or nothing where the kernel cannot be asked. */
export async function groupMembers(pgid: number): Promise<number[] | null> {
  const pids = await livePids();
  if (pids === null) return null;
  const members: number[] = [];
  for (const pid of pids) if ((await processGroupOf(pid)) === pgid) members.push(pid);
  return members;
}

/**
 * The environment `pid` holds, as the kernel hands it over, or nothing where it
 * could not be read — a process belonging to another user, or one that has gone.
 */
async function environmentOf(pid: number): Promise<string[] | null> {
  try {
    const held = await readFile(path.join(PROC_DIR, String(pid), 'environ'), 'utf8');
    return held.split('\0');
  } catch {
    return null;
  }
}

/**
 * Whether the processes now in `pgid` are the ones the run whose record is at
 * `runDir` started, asked of the kernel at the moment the answer decides
 * something.
 *
 * WHY THE RECORDED ID IS NOT EVIDENCE ON ITS OWN. A process id belongs to the
 * machine rather than to this checkout: the kernel reissues one as soon as its
 * holder is gone, and on a host whose id space wraps it reissues every number
 * eventually. So a record naming a group names a number, and a pass acting on
 * the number alone ends whatever now answers to it — an editor, an unrelated
 * build, someone else's suite. Every other reclaimer here rests on a kernel
 * fact only this checkout can produce: a connection refused on a claimed
 * address, a bind refused, a descriptor open on a store. This is that fact for
 * a tree, and it is why the port pass is safe where a bare id would not be.
 *
 * WHAT THE FACT IS. A run publishes the path of its own record in the
 * environment under {@link RUN_CLAIM_ENV}, and every child it starts inherits
 * it, so each process of a tree that run started carries the record's path —
 * which ends in an identifier nothing else was given — in the environment the
 * kernel keeps for it. That is read off the live process, never out of the
 * record: the record says which id to ask about, and the kernel says whose the
 * processes answering to it are. Nothing here compares an age or a start, and
 * the answer does not move with how long anything has been running.
 *
 * ONE PROCESS IS THE WHOLE ANSWER. A group holding one process this run
 * started holds nothing else: joining a group that already exists takes a
 * `setpgid` a process may make only for itself or its own child, and the one
 * regrouping here — the detached spawn — makes a new group rather than joining
 * one. So a member carrying the record is the tree, and an id the kernel has
 * reissued carries it nowhere.
 *
 * Asking it of every member instead would spare the orphans this pass exists
 * for, which is measured rather than supposed: a live run's own group here
 * holds helpers its tests started with the run identity deliberately removed,
 * so that run's tree fails an every-member reading while it is plainly its.
 *
 * A group nothing is in, and one holding a process whose environment could not
 * be read where no other member answered for it, are both left running: neither
 * is an answer, and sparing an orphan costs the next run another pass where
 * ending a stranger costs a person work nothing can restore.
 *
 * WHERE IT CANNOT BE ASKED. Linux publishes a live process's environment as a
 * file and the platforms this also runs on do not, so everywhere else the
 * question has no answer here and every recorded group is left running — the
 * reclaim ends nothing there until an attribution those platforms can answer
 * exists. A case pinning the platform proves which branch is chosen and
 * nothing about any platform itself.
 */
export async function attributeLiveGroup(
  pgid: number,
  runDir: string,
  platform: NodeJS.Platform = process.platform
): Promise<GroupAttribution> {
  if (platform !== 'linux') return 'unanswerable';
  const members = await groupMembers(pgid);
  if (members === null) return 'unanswerable';
  const record = `${RUN_CLAIM_ENV}=${runDir}`;
  let unreadable = 0;
  for (const pid of members) {
    const environment = await environmentOf(pid);
    if (environment === null) unreadable += 1;
    else if (environment.includes(record)) return 'this-run';
  }
  return members.length === 0 || unreadable > 0 ? 'unanswerable' : 'not-this-run';
}

export interface ProcessGroupReclaimOptions {
  /** Defaults to the machine-wide registry; a test points it elsewhere. */
  readonly registryDir?: string;
  /**
   * Defaults to a real signal-zero probe. Injected where a case has to drive a
   * group the machine it runs on does not have.
   */
  readonly groupIsAlive?: (pgid: number) => boolean;
  /**
   * How a tree is ended, injected so both platform branches are testable off
   * the platform that takes them and so a case can watch what would be
   * signalled rather than signal it.
   */
  readonly killer?: KillTreeDeps;
  /**
   * Whether a failed signal is one this caller steps over rather than fails on.
   * A caller that names none fails on every signal that fails, which is the
   * default; {@link groupSignalWasRefused} is what both commands here pass.
   */
  readonly signalRefused?: (error: unknown) => boolean;
  readonly log?: (message: string) => void;
}

export interface ProcessGroupReclaimReport {
  /** Groups this pass ended. */
  readonly reclaimed: number[];
  /** Groups a live run owns, left exactly as they were. */
  readonly live: number[];
  /** Groups this user was refused permission to end, reported and left running. */
  readonly refused: number[];
}

/**
 * What one recorded group meets on this pass, decided before anything is
 * signalled: `skip` is a record naming nothing this pass can answer for — an id
 * that negates into more than one tree — `live` is a tree its own run is still
 * working with, `gone` is a group the kernel says nothing is in, `end` is the
 * orphan, and the two remaining answers are {@link attributeLiveGroup}'s
 * reasons for leaving a tree exactly where it is.
 *
 * `gone` and `end` are the two the entry is retired on, which is why an empty
 * group is one of these rather than a skip: they are the answers a later pass
 * could never improve on, since the id names no tree of this checkout's again.
 */
type GroupDisposition = 'skip' | 'live' | 'gone' | 'end' | SparedAttribution;

async function dispositionOf(
  group: RecordedProcessGroup,
  isAlive: (pgid: number) => boolean,
  attribute: (group: RecordedProcessGroup) => Promise<GroupAttribution>
): Promise<GroupDisposition> {
  if (!addressesOneTree(group.pgid)) return 'skip';
  // A live run's record is that run's to write and nobody else's, so its
  // entries are answered before the kernel is asked anything that would retire
  // one.
  if (group.runLive) return isAlive(group.pgid) ? 'live' : 'skip';
  if (!isAlive(group.pgid)) return 'gone';
  const whose = await attribute(group);
  return whose === 'this-run' ? 'end' : whose;
}

/** The line naming a tree this pass ended, which is a record rather than a repair. */
function describeReclaimedGroup(group: RecordedProcessGroup): string {
  return (
    `process group ${String(group.pgid)}, started by \`${group.claim.command}\` and outliving ` +
    'it, was ended: the run that started it has let go of its claim.'
  );
}

/** The line naming a tree this pass left running, and what stopped it ending it. */
function describeSparedGroup(group: RecordedProcessGroup, whose: SparedAttribution): string {
  const because =
    whose === 'not-this-run'
      ? 'nothing running in it was started by that run, so the id now names something else'
      : 'this platform cannot say what started the processes in it';
  return (
    `process group ${String(group.pgid)}, recorded by \`${group.claim.command}\` and outliving ` +
    `it, was left running: ${because}.`
  );
}

/** The line naming a tree this user was refused permission to end. */
function describeRefusedGroup(group: RecordedProcessGroup): string {
  return (
    `process group ${String(group.pgid)}, started by \`${group.claim.command}\`, is not this ` +
    "user's to end: the operating system refused the signal, so it was left running and the " +
    'pass went on past it.'
  );
}

/**
 * Ends the trees of runs that have gone, and leaves every other tree alone.
 *
 * This is the process class's half of what the port pass does for an address,
 * and it rests on the same three facts: the record says which run started the
 * tree, the claim says that run is gone, and the kernel says the group still
 * has members. No age, stamp or heartbeat enters any of it.
 *
 * **A tree a live run started is never touched.** A run records its children
 * against its own claim, which is held for as long as the run is, so the tree
 * of a run still working takes the live branch and nothing is signalled at it —
 * including the tree the pass's own invocation started, which is named by its
 * own live claim.
 *
 * **What licences the signal.** Not the recorded id, which is reusable: the
 * kernel hands the number to an unrelated process once the tree that held it is
 * gone, and no record can tell the two apart. The claim says which id to ask
 * about and {@link attributeLiveGroup} asks the kernel whose the processes
 * answering to it are, so a number reissued to someone else's work fails the
 * question and is left running. That is the same shape as the port pass, which
 * resolves a pid from the claimed address at the moment of the signal rather
 * than trusting what was written down.
 *
 * A signal the operating system refuses is the one outcome the caller decides:
 * a caller naming such refusals has the tree reported, left running, and the
 * pass carries on to the trees behind it, and a caller naming none has it
 * raised. Raising at the first refusal would leave every tree behind it
 * unexamined and stop the next run in the same place.
 *
 * Where {@link recordedGroupAddressesATree} says a recorded id names no tree,
 * nothing is signalled and nothing is asked: an id that addresses nothing is
 * not evidence about anything.
 *
 * **What this pass resolves, it also retires.** A group it ended and a group
 * the kernel says nothing is in are the two answers no later pass could
 * improve on, and their entries go through {@link retireRecordedGroup} — never
 * the record that names the run's other resources. Every other answer leaves
 * the entry exactly where it is, because every other answer is one the next
 * pass asks again of a world that has moved.
 */
export async function reclaimProcessGroups(
  options: ProcessGroupReclaimOptions = {}
): Promise<ProcessGroupReclaimReport> {
  const found: ProcessGroupReclaimReport = { reclaimed: [], live: [], refused: [] };
  const platform = options.killer?.platform ?? process.platform;
  if (!recordedGroupAddressesATree(platform)) return found;

  const log =
    options.log ??
    ((message: string): void => {
      console.warn(message);
    });
  const isAlive = options.groupIsAlive ?? groupIsAlive;
  const registryDir = options.registryDir ?? claimsDir();
  const retire = (group: RecordedProcessGroup): Promise<void> =>
    retireRecordedGroup(group.claim.runId, group.pgid, registryDir);

  // One tree a caller may not end costs exactly itself. Raising instead would
  // leave every tree behind it in this pass unexamined and stop the next pass
  // in the same place, so a single such tree would degrade the reclaim to
  // nothing for good.
  const end = async (group: RecordedProcessGroup): Promise<void> => {
    try {
      killTree(group.pgid, 'SIGKILL', options.killer);
    } catch (error) {
      if (options.signalRefused?.(error) !== true) throw error;
      found.refused.push(group.pgid);
      log(describeRefusedGroup(group));
      return;
    }
    found.reclaimed.push(group.pgid);
    log(describeReclaimedGroup(group));
    await retire(group);
  };

  const attribute = async (group: RecordedProcessGroup): Promise<GroupAttribution> =>
    attributeLiveGroup(group.pgid, path.join(registryDir, group.claim.runId), platform);

  // What a disposition costs the report, kept out of the walk below it so that
  // reading either one is reading one thing.
  const dispose = async (group: RecordedProcessGroup): Promise<void> => {
    const disposition = await dispositionOf(group, isAlive, attribute);
    switch (disposition) {
      case 'skip': {
        return;
      }
      case 'live': {
        found.live.push(group.pgid);
        return;
      }
      case 'gone': {
        await retire(group);
        return;
      }
      case 'end': {
        await end(group);
        return;
      }
      default: {
        log(describeSparedGroup(group, disposition));
      }
    }
  };

  for (const group of await readRecordedProcessGroups(options.registryDir)) await dispose(group);
  return found;
}
