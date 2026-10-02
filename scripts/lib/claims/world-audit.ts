import {
  databaseClaim,
  runIdFromToken,
  scratchBucketPrefix,
  scratchBucketRunToken,
} from '@hushbox/db/test-db';
import { probeLifelineSocket } from '../spawn/long-lived.js';
import { describePort } from '../stack/port-plan.js';
import {
  NO_LOCAL_STORE_WRITER,
  NO_RAM_ROOT_WRITER,
  STORE_BARRIER,
  verdictOf,
} from './world-verdicts.js';
import {
  claimName,
  isRamRootStore,
  isStrandedStore,
  scanWorld,
  storeQuestion,
  sweepStores,
} from './world-scan.js';
import { DEFAULT_OUTPUT_DIR, asideOwner } from '../../e2e-clean.js';
import { triageProjects } from '../../docker-cleanup.js';
import { stateOfScratchBucket } from '../test-run/scratch-bucket-reclaim.js';
import { stateOfDatabase } from '../test-run/test-db-provision.js';
import { readOwnership } from './ownership.js';

import type { Ownership, OwnershipState } from './ownership.js';
import type { ResourceAge } from './resource-age.js';
import type { SocketAnswer } from '../spawn/long-lived.js';
import type { DockerComposeProject } from '../../docker-cleanup.js';
import type {
  AuditKind,
  AuditLine,
  AuditState,
  DaemonIdentity,
  GroupOrigin,
  LifelineSocketReading,
  ProjectStanding,
  RunStanding,
  StoreAnswer,
  StrayGroupReading,
  WorldReading,
} from './world-reading.js';
import type { WorldScanDeps } from './world-scan.js';

/**
 * What a pass found and what it means are published from here as well as from
 * their own modules, because this is the door their callers already come
 * through.
 */
export type * from './world-reading.js';
export { removeWranglerStore, readComposeProjectWorld, scanWorld } from './world-scan.js';
export type { ProcessCensus, WorldScanDeps } from './world-scan.js';
/**
 * The read-only auditor: it enumerates the claims, enumerates the world, and
 * says which of the three states every resource it found is in. It changes
 * nothing. Auditors detect and humans repair, and that division is what makes
 * the sweep's residual gap safe — a spawner nobody has found yet leaks a
 * resource that surfaces here as *unowned*, so knowing every spawner stops
 * being a precondition for the design being correct.
 *
 * Every state comes from an advisory lock a kernel releases when its holder
 * dies: no clock, no TTL and no heartbeat enters any classification. Nor does
 * the presence of a file — a released claim leaves its lock file on disk
 * carrying the last holder's name, so reporting those as owned would make every
 * finished run look live.
 *
 * Each class is attributed by whatever is readable from the instant the
 * resource exists. A database and a bucket carry their run's token in their own
 * names; a container and a port are recorded against the claim of the run that
 * started them; a purge aside carries its run in its directory name; and a dist
 * snapshot holds its own claim rather than riding a run's, because it outlives
 * the build that produced it and is released when its serve ends.
 */

function line(found: {
  kind: AuditKind;
  id: string;
  state: AuditState;
  owner?: string | undefined;
  detail?: string | undefined;
  daemonIdentity?: DaemonIdentity | undefined;
  projectStanding?: ProjectStanding | undefined;
  socketAnswer?: SocketAnswer | undefined;
  storeAnswer?: StoreAnswer | undefined;
  unreclaimed?: string | undefined;
  namedRun?: string | undefined;
  runStanding?: RunStanding | undefined;
  groupOrigin?: GroupOrigin | undefined;
  age?: ResourceAge | undefined;
}): AuditLine {
  return {
    kind: found.kind,
    id: found.id,
    state: found.state,
    owner: found.owner,
    detail: found.detail,
    daemonIdentity: found.daemonIdentity,
    projectStanding: found.projectStanding,
    socketAnswer: found.socketAnswer,
    storeAnswer: found.storeAnswer,
    unreclaimed: found.unreclaimed,
    namedRun: found.namedRun,
    runStanding: found.runStanding,
    groupOrigin: found.groupOrigin,
    age: found.age,
  };
}

/** A run's own record, as the registry hands it to whoever enumerates it. */ /** The kinds a run records against its claim, as the registry indexes them. */
type RecordedKind = 'compose-project' | 'container' | 'database' | 'bucket' | 'port' | 'socket';

/** What a line says about the claim that recorded a resource. */
interface ClaimAttribution {
  readonly owner: string | undefined;
  readonly runStanding: RunStanding | undefined;
}

/**
 * The run that recorded a resource, and where that run's own process stands.
 *
 * Read together rather than apart, because they are two halves of one sentence
 * about one claim: a line naming a live owner and a line saying that owner has
 * lost the process that started it are the same line, and deciding them apart
 * is how a resource forty-seven orphaned processes were holding came to read
 * *nothing to do*.
 */
function attributedTo(
  world: WorldReading,
  ownership: Ownership,
  kind: RecordedKind,
  id: string
): ClaimAttribution {
  const claim = ownership.resourceOwner(kind, id);
  if (claim === undefined) return { owner: undefined, runStanding: undefined };
  return {
    owner: claimName(claim),
    runStanding: world.runRoots.find((root) => root.runId === claim.runId)?.standing,
  };
}

/**
 * The state a claim-attributed resource is reported in, given what this pass
 * was able to read of the registry.
 *
 * `unowned` is a claim about every record there is, and a pass that could not
 * read one of them has not established it. The three owned answers stand as
 * they are: they came from a record that WAS read, and a record nobody could
 * read takes nothing away from one that could.
 */
function attributed(ownership: Ownership, state: OwnershipState): AuditState {
  return state === 'unowned' && ownership.unreadLiveRuns.length > 0 ? 'unknown' : state;
}

/**
 * Where the triage put each project. Keyed by the project the pass read rather
 * than by its name: the triage sorts the very objects it was handed, and two
 * running projects can carry one name — the same name recorded against two
 * directories — which a name would merge into whichever the pass sorted last.
 *
 * A project the triage returns in no bucket is the one the checkout runs its
 * stack under: the teardown reports nothing about that one, because it is the
 * ordinary state of a stack in use, and the audit is the surface that says so
 * out loud. The record below is what makes a bucket added later a compile error
 * here rather than a project silently reported as one in use.
 */
function standingsOf(
  triage: ReturnType<typeof triageProjects>
): Map<DockerComposeProject, ProjectStanding> {
  const covered: Record<keyof typeof triage, ProjectStanding> = {
    held: 'held',
    orphaned: 'reclaimable',
    blocked: 'blocked',
    unaccounted: 'unaccounted',
    unresolved: 'unresolved',
    otherClone: 'other-clone',
  };
  const standings = new Map<DockerComposeProject, ProjectStanding>();
  const place = (projects: readonly DockerComposeProject[], standing: ProjectStanding): void => {
    for (const project of projects) standings.set(project, standing);
  };
  place(triage.held, covered.held);
  place(triage.orphaned, covered.orphaned);
  place(triage.blocked, covered.blocked);
  place(triage.unaccounted, covered.unaccounted);
  place(triage.unresolved, covered.unresolved);
  place(triage.otherClone, covered.otherClone);
  return standings;
}

/**
 * Every running compose project, in the state the registry puts it in and with
 * the standing the teardown's own triage gives it.
 *
 * The state column is the claim reading every other kind reports, so the report
 * says one thing by one word throughout. What a reader is told to DO comes from
 * the standing instead, because at this one site the claim only ever spares and
 * never licenses: a stack outlives the run that brings it up — the idle daemon
 * exists because it does — so a claim whose run has ended is evidence about the
 * run, not about the stack. Read as licence, it would have this pass page about
 * every healthy stack on the machine.
 */
function auditComposeProjects(world: WorldReading, ownership: Ownership): AuditLine[] {
  const standings = standingsOf(triageProjects({ ...world.composeProjects, ownership }));
  return world.composeProjects.ownerships.map(({ project }) =>
    line({
      kind: 'compose-project',
      id: project.projectName,
      state: attributed(
        ownership,
        ownership.stateOfResource('compose-project', project.projectName)
      ),
      ...attributedTo(world, ownership, 'compose-project', project.projectName),
      detail: `started in ${project.workingDir}`,
      projectStanding: standings.get(project) ?? 'current',
    })
  );
}

function auditContainers(world: WorldReading, ownership: Ownership): AuditLine[] {
  return world.containers.map(({ name, age }) =>
    line({
      kind: 'container',
      id: name,
      state: attributed(ownership, ownership.stateOfResource('container', name)),
      ...attributedTo(world, ownership, 'container', name),
      age,
    })
  );
}

/**
 * A container of a compose project this clone started that docker is not
 * running.
 *
 * It is a kind of its own rather than a container line, because the sentence
 * the container class writes about an unclaimed one is false here: a container
 * a project owns was not left by a process holding no run claim, and the
 * reclaim that class names passes over it by construction. Nothing counts one
 * today, which is the one shape this design rules out, so the whole of what
 * this does is name it.
 */
function auditStuckContainers(world: WorldReading, ownership: Ownership): AuditLine[] {
  return world.stuckContainers.map((found) =>
    line({
      kind: 'stuck-container',
      id: found.name,
      state: attributed(ownership, ownership.stateOfResource('container', found.name)),
      detail: `docker has it ${found.state}`,
      ...attributedTo(world, ownership, 'container', found.name),
    })
  );
}

/**
 * The two database families take their claim under different ids and get
 * different verdicts when nothing claims one, and {@link databaseClaim} is
 * where the name decides both — one branch, so the id this looks a claim up
 * under can never disagree with the id the claim was written under.
 *
 * Both families are recorded as the registry's one `database` kind, which is
 * what the lookup passes; the audit kind is what the reader is told, and the
 * two families need to be told different things.
 *
 * The state comes from {@link stateOfDatabase}, the derivation the sweeps in
 * `scripts/lib/test-run/` drop on, rather than from a second spelling of it: a
 * state this pass reports and the next sweep does not produce is a state
 * nobody can act on, and that is the one direction a wrong answer here is
 * invisible in. {@link auditBuckets} takes the reclaim pass's derivation for
 * the same reason.
 */
function auditDatabases(world: WorldReading, ownership: Ownership): AuditLine[] {
  return world.databases.map((datname) => {
    const { family, id, runId } = databaseClaim(datname);
    return line({
      kind: family === 'staging' ? 'stage-database' : 'database',
      id: datname,
      state: attributed(ownership, stateOfDatabase(datname, ownership)),
      ...attributedTo(world, ownership, 'database', id),
      namedRun: runId,
    });
  });
}

/**
 * A bucket, on the state {@link stateOfScratchBucket} puts it in — the reclaim
 * pass's own derivation, for the reason {@link auditDatabases} states.
 *
 * The token-less answer is the one line in this file that skips
 * {@link attributed}, and the asymmetry is between the two families rather than
 * an oversight. Such a bucket has no claim id to look a record up under, so
 * *unowned* was established without consulting a record and an unread one takes
 * nothing away from it. A staging database carries its claim id in its own
 * whole name, which is why that family answers *unknown* in the same registry
 * state.
 */
function auditBuckets(world: WorldReading, ownership: Ownership): AuditLine[] {
  return world.buckets.map((bucket) => {
    const state = stateOfScratchBucket(bucket, ownership);
    const runToken = scratchBucketRunToken(bucket);
    if (runToken === undefined) return line({ kind: 'bucket', id: bucket, state });
    return line({
      kind: 'bucket',
      id: bucket,
      state: attributed(ownership, state),
      ...attributedTo(world, ownership, 'bucket', scratchBucketPrefix(runToken)),
      namedRun: runIdFromToken(runToken),
    });
  });
}

/** What a port is for, so a report line is readable without the allocator open. */
function describeListener(port: number): string | undefined {
  const described = describePort(port);
  if (described === undefined) return undefined;
  const lane = described.lane === 0 ? '' : `, lane ${String(described.lane)}`;
  return `${described.service}, ${described.modes.join(' and ')} band, slot ${String(described.slot)}${lane}`;
}

function daemonIdentityOf(world: WorldReading, port: number): DaemonIdentity | undefined {
  return world.daemonPorts.find((reading) => reading.port === port)?.identity;
}

function auditPorts(world: WorldReading, ownership: Ownership): AuditLine[] {
  return world.listeningPorts.map(({ port, age }) => {
    const id = String(port);
    return line({
      kind: 'port',
      id,
      state: attributed(ownership, ownership.stateOfResource('port', id)),
      ...attributedTo(world, ownership, 'port', id),
      detail: describeListener(port),
      daemonIdentity: daemonIdentityOf(world, port),
      age,
    });
  });
}

/**
 * A recorded group carries its run in the reading itself, because the registry
 * is what enumerated it. There is no third state to report: a group nothing
 * recorded is a group this pass never saw.
 */
function auditProcessGroups(world: WorldReading): AuditLine[] {
  return world.processGroups.map((found) =>
    line({
      kind: 'process-group',
      id: String(found.pgid),
      state: found.runLive ? 'owned-live' : 'owned-expired',
      owner: found.owner,
    })
  );
}

/**
 * A stray group carries its run in the reading itself, because the registry is
 * half of what enumerated it. There is no unclaimed state to report: a group
 * holding no process of any run is not a stray group, it is somebody else's.
 */
function auditStrayGroups(world: WorldReading): AuditLine[] {
  return world.strayGroups.map((found) =>
    line({
      kind: 'stray-group',
      id: String(found.pgid),
      // A run that still held its claim would not have been read: every line of
      // this kind is about what a finished run left behind.
      state: 'owned-expired',
      owner: found.owner,
      detail: strayGroupDetail(found),
      groupOrigin: found.origin,
    })
  );
}

/**
 * What a stray group's line says it holds: how many of the run's processes are
 * in the group, and for one origin their ids.
 *
 * The ids print for a group made above the run and for no other, because that
 * is the one origin whose repair is an action per process: the group is not the
 * run's to signal, so the members are the whole of what a reader may end, and
 * the route to them through the group is a route through the reader's own
 * session. Every other origin is ended as one tree, addressed by the id the
 * line already carries, and a list of that tree's members beside it would be
 * noise.
 *
 * Nothing is elided from the list, however long it is. This line pages, and
 * {@link renderAudit} states the rule it is an instance of: what a human must
 * act on prints whole, and the volume comes off the lines nobody was going to
 * act on. The length is the size of the work — one id is one process to end —
 * and a truncated list would be an incomplete repair a reader cannot see is
 * incomplete.
 */
function strayGroupDetail(found: StrayGroupReading): string {
  const held = `${String(found.members.length)} ${found.members.length === 1 ? 'process' : 'processes'} of that run`;
  if (found.origin !== 'never-recorded') return held;
  return `${held}: ${found.members.map(String).join(' ')}`;
}

/**
 * A snapshot holds its own claim, so it has two states rather than three: the
 * run serving it holds the lock, and a snapshot no lock holds is debris the
 * next serve drops. There is no third state to report — a snapshot directory
 * cannot exist without the claim that names it.
 */
function auditSnapshots(world: WorldReading): AuditLine[] {
  return world.snapshots.map((probe) =>
    line({
      kind: 'snapshot',
      id: probe.id,
      state: probe.held ? 'owned-live' : 'owned-expired',
      owner: probe.holder ?? undefined,
    })
  );
}

/**
 * An aside's owner is in its directory name: the rename that mints one, in
 * `scripts/e2e-clean.ts`, records no claim resource for it, so
 * `stateOfResource` would answer unowned for every aside including a live
 * run's.
 */
function auditAsides(world: WorldReading, ownership: Ownership): AuditLine[] {
  return world.asides.map((name) => {
    const runId = asideOwner(DEFAULT_OUTPUT_DIR, name);
    const state = attributed(ownership, ownership.stateOfRun(runId));
    // The run id is the whole owner an aside has: the directory name carries it,
    // so the owner reported is a run rather than a claimed resource.
    return line({
      kind: 'aside',
      id: name,
      state,
      owner: state === 'unowned' ? undefined : `run ${String(runId)}`,
    });
  });
}

/**
 * The socket a spawning process answers its children on is a file, and one it
 * is killed too hard to close is a file that outlives it. It is claimed by the
 * process that opens it, so it is attributed exactly as a port is: by the claim
 * of the run that took it.
 *
 * A file no claim names is a process that spawned while holding none — which is
 * every command run outside the wrapper that registers one — and the claim is
 * then the whole of what this pass knows about the run. What it does not answer
 * is whether anything is behind the file, which the reading carries: a file no
 * claim names whose connect was refused has nothing behind it, and that pair is
 * the one state here a command reclaims without being asked.
 */
function auditLifelineSockets(world: WorldReading, ownership: Ownership): AuditLine[] {
  return world.lifelineSockets.map((found) =>
    line({
      kind: 'socket',
      id: found.address,
      state: attributed(ownership, ownership.stateOfResource('socket', found.address)),
      ...attributedTo(world, ownership, 'socket', found.address),
      detail: 'the socket a spawning process answers its children on',
      socketAnswer: found.answer,
    })
  );
}

/**
 * Asks the kernel about the socket files ownership left open, and about no
 * others.
 *
 * Ownership is decided first and this runs on its answer, so a file a claim
 * places is never connected to at all — which is what keeps a read-only pass
 * away from a live spawner's address. A pass that could not read a live run's
 * record has established nothing about any unclaimed file either, and
 * {@link attributed} is what says so: it turns those into `unknown`, and
 * nothing here asks about one.
 */
async function probeUnclaimedSockets(
  sockets: readonly LifelineSocketReading[],
  ownership: Ownership,
  probe: (address: string) => Promise<SocketAnswer>
): Promise<LifelineSocketReading[]> {
  const asked: LifelineSocketReading[] = [];
  for (const found of sockets) {
    const state = attributed(ownership, ownership.stateOfResource('socket', found.address));
    asked.push(state === 'unowned' ? { ...found, answer: await probe(found.address) } : found);
  }
  return asked;
}

/**
 * A wrangler store is owned by the stack mode its directory is named for, not
 * by any run: the store is what that stack keeps between runs, so it has no run
 * claim and reporting it every pass would print a line whose only verdict could
 * be that there is nothing to do. A store outside the stack modes is owned by
 * nothing, which is what this class exists to surface; what that says about the
 * store, and what becomes of it, is `strandedStoreVerdict` in `scripts/lib/claims/world-verdicts.ts`.
 *
 * An E2E RAM root whose checkout is gone is the same class under its own kind:
 * it belongs to a checkout rather than to a stack mode, so its line says so.
 */
function auditWranglerStores(world: WorldReading): AuditLine[] {
  const unreclaimed = new Map(world.unreclaimedStores.map((found) => [found.store, found.reason]));
  const answers = new Map(world.storeAnswers.map((found) => [found.store, found.answer]));
  return world.wranglerStores
    .filter((store) => isStrandedStore(store))
    .map((store) =>
      line({
        kind: isRamRootStore(store) ? 'ram-root' : 'wrangler-state',
        id: store,
        state: 'unowned',
        storeAnswer: answers.get(store),
        unreclaimed: unreclaimed.get(store),
      })
    );
}
/** Every resource found in the world, in the state its claim puts it in. */
export function auditWorld(world: WorldReading, ownership: Ownership): AuditLine[] {
  return [
    ...auditComposeProjects(world, ownership),
    ...auditContainers(world, ownership),
    ...auditStuckContainers(world, ownership),
    ...auditDatabases(world, ownership),
    ...auditBuckets(world, ownership),
    ...auditPorts(world, ownership),
    ...auditProcessGroups(world),
    ...auditStrayGroups(world),
    ...auditSnapshots(world),
    ...auditAsides(world, ownership),
    ...auditLifelineSockets(world, ownership),
    ...auditWranglerStores(world),
  ];
}

/**
 * The resources a human must act on. Read out of the same verdict that renders
 * the line, so a resource cannot be counted here under a repair the line above
 * tells the reader not to apply.
 */
function pageableLines(lines: readonly AuditLine[]): AuditLine[] {
  return lines.filter((found) => verdictOf(found).pages);
}

/**
 * Whether this pass left the resource standing on what it was told about it,
 * rather than because nobody asked it to do anything. Nobody must act on one of
 * these, and it still prints on the pass that prints only what happened: a
 * decision not to remove something is as much a thing that happened as a
 * removal, and it is the one that explains why a store the last pass promised
 * to reclaim is still on disk.
 */
function wasSpared(found: AuditLine): boolean {
  return found.storeAnswer !== undefined && found.storeAnswer.kind !== 'vacant';
}

/**
 * Non-zero on every resource a human must act on, and on a class that could not
 * be read: a class the pass could not reach is a class it has certified
 * nothing about.
 *
 * {@link WorldReading.uncovered} is deliberately not an argument. A class
 * nothing offered the pass a way to read is not a failure a human can clear, so
 * counting it would leave the auditor permanently red wherever that limit
 * stands, and an auditor that is permanently red is one nobody reads.
 */
export function auditExitCode(lines: readonly AuditLine[], unreadable: readonly string[]): number {
  return pageableLines(lines).length > 0 || unreadable.length > 0 ? 1 : 0;
}

export function formatAuditLine(found: AuditLine): string {
  const what = found.detail === undefined ? found.id : `${found.id} (${found.detail})`;
  const { owner, repair } = verdictOf(found);
  return `${found.kind} ${what} — ${found.state} — ${owner} — ${repair}`;
}

/**
 * How much of the classification a pass prints. The two readers of this report
 * want different volumes, and this is the decision rather than an oversight:
 *
 * `every-line` is `pnpm dev:clean --dry-run`, whose whole purpose is the
 * classification — someone who runs it has asked to be told where every
 * resource stands, and a line saying a live run owns something is the answer
 * they asked for.
 *
 * `what-must-be-done` is the pass every bring-up runs as housekeeping, where
 * nobody asked for anything. Its output is proportional to what the reader must
 * do: a line exists because someone must act on it, because something was acted
 * on, or because the pass decided to leave something alone, and the resources a
 * live run holds collapse into one line per run.
 * A machine where nothing needs doing prints almost nothing, which is what keeps
 * the lines that do print worth reading.
 */
export type AuditShape = 'every-line' | 'what-must-be-done';

/**
 * One line per run that owns something, in place of one line per resource it
 * owns. What a reader of a bring-up gets from those lines is that their own run
 * holds what it should; the identity of each database and socket is the dry
 * run's business.
 */
function heldByLiveRuns(lines: readonly AuditLine[]): string[] {
  const byRun = new Map<string, Map<AuditKind, number>>();
  for (const found of lines) {
    // The owner half of the line this stands in for, rather than the claim's
    // name: a lock whose holder could not be read has a sentence of its own
    // there, and one spelling of it is what keeps the two shapes agreeing about
    // whose the resource is.
    const owner = verdictOf(found).owner;
    const kinds = byRun.get(owner) ?? new Map<AuditKind, number>();
    kinds.set(found.kind, (kinds.get(found.kind) ?? 0) + 1);
    byRun.set(owner, kinds);
  }
  return [...byRun].map(([owner, kinds]) => {
    const total = [...kinds.values()].reduce((sum, count) => sum + count, 0);
    // Commonest kind first, ties by name, so two passes over one world print
    // the same line and a reader can diff them.
    const held = [...kinds]
      .toSorted(([aKind, a], [bKind, b]) => b - a || aKind.localeCompare(bKind))
      .map(([kind, count]) => `${kind} ×${String(count)}`)
      .join(', ');
    return `${owner} holds ${String(total)}: ${held}`;
  });
}

/**
 * The lines one pass prints, in its own shape. Anything a human must act on is
 * printed whole in both, repair included: the volume comes off the lines nobody
 * was going to act on, and quieting an actionable one would be the opposite of
 * what the shorter shape is for.
 */
function renderAudit(lines: readonly AuditLine[], shape: AuditShape): string[] {
  if (shape === 'every-line') return lines.map((found) => formatAuditLine(found));
  const pageable = pageableLines(lines);
  const held = lines.filter((found) => found.state === 'owned-live' && !verdictOf(found).pages);
  const spared = lines.filter((found) => wasSpared(found));
  return [
    ...heldByLiveRuns(held),
    ...spared.map((found) => formatAuditLine(found)),
    ...pageable.map((found) => formatAuditLine(found)),
  ];
}

/** What a pass prints about one stranded store it removed. */
function reclaimedLine(store: string): string {
  if (isRamRootStore(store)) {
    return `reclaimed the E2E RAM root ${store} — ${NO_RAM_ROOT_WRITER}, so it was removed whole`;
  }
  return (
    `reclaimed the wrangler store ${store} — no stack mode named it, ` +
    `${NO_LOCAL_STORE_WRITER}, and ${STORE_BARRIER}`
  );
}

export interface WorldAuditReport {
  readonly lines: readonly AuditLine[];
  readonly unreadable: readonly string[];
}

/**
 * Scans the world, classifies it against one reading of the registry, and
 * prints a line per resource. The registry is read after the world, so a
 * resource created between the two readings is classified against a registry
 * that predates its claim — harmless here, because this reports and destroys
 * nothing. A process group is the exception that needs no such allowance: its
 * reading carries the run it was read from, so it is classified against the
 * same instant of the registry that produced it.
 *
 * The socket files are the one class asked anything after the registry is read,
 * and the order is the point rather than an ordering convenience: the claims
 * settle every file they name, so the connect is put only to the files they
 * leave open.
 */
export async function reportWorldAudit(
  deps: WorldScanDeps,
  log: (message: string) => void,
  registryDir?: string,
  shape: AuditShape = 'every-line'
): Promise<WorldAuditReport> {
  const world = await scanWorld(deps, registryDir);
  const ownership = await readOwnership(registryDir);
  const sweep = await sweepStores(
    world.wranglerStores,
    deps.reclaimStrandedStores,
    storeQuestion(deps)
  );
  const lines = auditWorld(
    {
      ...world,
      lifelineSockets: await probeUnclaimedSockets(
        world.lifelineSockets,
        ownership,
        deps.probeSocket ?? probeLifelineSocket
      ),
      wranglerStores: sweep.standing,
      unreclaimedStores: sweep.unreclaimed,
      storeAnswers: sweep.answers,
    },
    ownership
  );

  // A record this pass could not read is a class of information it failed to
  // reach, so it is carried where a failed read is carried: printed, and part
  // of the verdict. Silence about one would certify it clean, and what stands
  // on that certification is every `unowned` line below.
  const unreadable = [
    ...world.unreadable,
    ...ownership.unreadLiveRuns.map(
      (found) =>
        `the claims of the live run in ${found.runId}: its record could not be read ` +
        `(${found.reason}), so nothing here can say which resources or process groups are its own`
    ),
  ];

  // The two reasons a class goes unreported, printed together because a reader
  // needs both before reading a line. A limit of the report comes first and is
  // printed as it stands: the pass had no mechanism for that class, whatever
  // put it in that state, and what the reader needs is the limit said out loud
  // rather than coverage inferred from a silence.
  const notSaid = [...world.uncovered, ...unreadable.map((found) => `could not classify ${found}`)];
  for (const note of notSaid) log(note);
  // A reclaim is reported in every shape, because it is something that
  // happened: one line each rather than a count, since a store names where the
  // 600 MB went and there is never a list of them long enough to be noise.
  for (const store of sweep.reclaimed) log(reclaimedLine(store));
  for (const rendered of renderAudit(lines, shape)) log(rendered);
  if (lines.length === 0 && notSaid.length === 0 && sweep.reclaimed.length === 0) {
    log('Nothing of this stack is running or left behind.');
  }

  const pageable = pageableLines(lines);
  if (pageable.length > 0) {
    log(
      `${String(pageable.length)} resource(s) a human must act on. Each line ends with ` +
        'the repair for that one; until it is applied, nothing reclaims it.'
    );
  }

  return { lines, unreadable };
}
