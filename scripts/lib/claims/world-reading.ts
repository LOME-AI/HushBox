/**
 * What one pass over the machine found: the classes of resource the auditor
 * knows, the shape of each reading, and the one line a reading becomes.
 */

import type { OwnershipState } from './ownership.js';
import type { ResourceAge } from './resource-age.js';
import type { SocketAnswer } from '../spawn/long-lived.js';
import type { LabelledContainer } from '../../docker-cleanup.js';
import type { DaemonIdentityRecord } from '../stack/idle-killer-daemon.js';
import type { ProjectTriageRequest } from '../../docker-cleanup.js';

export type AuditKind =
  | 'compose-project'
  | 'container'
  | 'stuck-container'
  | 'database'
  | 'stage-database'
  | 'bucket'
  | 'port'
  | 'process-group'
  | 'stray-group'
  | 'snapshot'
  | 'aside'
  | 'socket'
  | 'wrangler-state'
  | 'ram-root';

/**
 * The stack a pass is auditing for, as far as the one resource that has to say
 * which stack it belongs to is concerned. Every other resource is attributed by
 * the claim of the run that made it, and a run's claim records this already.
 *
 * The compose project may be absent, because a command can audit without having
 * loaded the generated environment. That is not agreement: a daemon whose
 * project nothing could be compared with is reported, never trusted.
 */
export interface AuditedStack {
  /** The compose project a teardown of this stack would name. */
  readonly composeProject: string | undefined;
  /** The checkout a teardown of this stack would run in. */
  readonly checkout: string;
}

/**
 * What the holder of a sentinel port proved about itself.
 *
 * Holding the claim proves only that the holder is a daemon of this repository:
 * it says nothing about which stack that daemon believes it owns, and a daemon
 * outlives every run, so what it captured at spawn can be a project, a checkout
 * or a slot the stack has since moved off. `other-stack` is the state that has
 * already destroyed a shared stack — a daemon whose captured compose project
 * the environment has since regenerated tears down whatever that project now
 * names, and nothing else here would have said a word about it.
 *
 * `uncompared` is where the pass established nothing either way: given no
 * project of its own, it can neither exempt a daemon nor say whose it is. It is
 * separate from `other-stack` because a line saying "another stack's" on the
 * strength of a comparison that never happened asserts more than the pass knows.
 *
 * `publishing` is a daemon whose record the claim was still writing as the pass
 * read it, and it is separate from `unstated` for the same reason: a daemon that
 * has not said which stack it belongs to *yet* is a live one a further read
 * places, while `unstated` is one that never will. Reading the fragment as
 * `unstated` is what asked a human to investigate a daemon that was working.
 */
export type DaemonIdentity =
  | { readonly kind: 'this-stack' }
  | {
      readonly kind: 'other-stack';
      readonly stated: DaemonIdentityRecord;
      /** What it disagrees with this stack about, in the words the line prints. */
      readonly differences: readonly string[];
    }
  | {
      readonly kind: 'uncompared';
      readonly stated: DaemonIdentityRecord;
      /** Why the pass could not place it, in the words the line prints. */
      readonly reason: string;
    }
  | { readonly kind: 'publishing' }
  | { readonly kind: 'unstated' }
  | { readonly kind: 'unidentified' };

/**
 * Everything one pass places its running compose projects against, in the
 * shape the teardown's own triage takes it: the projects, the checkouts git
 * lists, this clone, and which slot each checkout holds. The ownership half is
 * what the audit supplies from its own reading of the registry.
 *
 * The triage is imported rather than restated because the dry run and the
 * teardown must not be able to disagree about which project is reclaimable: a
 * report that classifies a project one way while the command that reads the
 * same world removes it another is worse than no report.
 */
export type ComposeProjectWorld = Omit<ProjectTriageRequest, 'ownership'>;

/**
 * Where one running compose project stands, in the verdicts the teardown
 * decides it in. `current` is the one the triage returns no bucket for: it is
 * the project the checkout runs its stack under, which the teardown says
 * nothing about because it is the ordinary state of a stack in use.
 */
export type ProjectStanding =
  | 'held'
  | 'reclaimable'
  | 'blocked'
  | 'unaccounted'
  | 'unresolved'
  | 'other-clone'
  | 'current';

/**
 * What every class here is read as: the identity of one resource, and beside it
 * whatever else that resource's own source answered about it.
 *
 * WHY A RECORD RATHER THAN A SECOND LIST. Each source answers more than an
 * identity — a container listing carries a creation time, a bucket listing a
 * creation date, a database comment a creation instant — and a model that types
 * a class as a list of identities makes every caller narrow that answer away at
 * the moment it is read. The first class that needed one of those answers back
 * carried it in a second list keyed by the identity, which every reader then had
 * to join; a join whose miss is indistinguishable from a question nothing asked
 * cannot be checked by anything. So the join happens once, where both facts are
 * in hand, and what the reading publishes is the record.
 *
 * An age is optional on every one of them, and an absent one is a question
 * nothing asked rather than a young resource: only an established age carries a
 * resource past the boundary.
 */
export interface ContainerReading {
  readonly name: string;
  readonly age: ResourceAge | undefined;
}

/**
 * A listening port and how long whatever holds it has stood, which is what
 * decides the fate of one no claim accounts for: past the boundary a run
 * reclaims it, below the boundary it is reported exactly as it always was, and
 * an age nothing could establish is neither.
 */
export interface ListenerReading {
  readonly port: number;
  readonly age: ResourceAge | undefined;
}

/** A listening sentinel port, and what its holder proved about itself. */
export interface SentinelReading {
  readonly port: number;
  readonly identity: DaemonIdentity;
}

/**
 * The state one report line puts a resource in. `unknown` is the answer that
 * cannot collapse into `unowned`: a live run whose record could not be read
 * may hold anything, so a resource no readable claim accounts for is one whose
 * ownership this pass failed to establish rather than one nothing owns. Saying
 * `unowned` there is a confident wrong answer, and the repair attached to it
 * sends a reader to remove what a live run is using.
 */
export type AuditState = OwnershipState | 'unknown';

/**
 * Where the process that took a live claim stands.
 *
 * `decapitated` is the state a killed run leaves: the claim is still held, by
 * the descendants the kill reparented rather than by anything that will let go.
 * The discriminator is the claim process's own process group, and it is a
 * kernel fact rather than a clock — an id in use as a process group is never
 * reissued as a pid, so a group whose leader has no entry has genuinely lost
 * the process that made it. Neither liveness nor lock-holding separates the two
 * states: both were driven, and a decapitated run reads exactly like a healthy
 * one on each.
 *
 * `unestablished` is where nothing could be asked — a platform publishing no
 * process groups, or a process the kernel would not describe. It is separate
 * from `rooted` because a standing nothing established must not read as a
 * finding, and it pages about nothing for the same reason a class this pass has
 * no mechanism to read pages about nothing.
 */
export type RunStanding = 'rooted' | 'decapitated' | 'unestablished';

/** One live run's claim, and where the process that took it stands. */
export interface RunRootReading {
  readonly runId: string;
  readonly standing: RunStanding;
}

export interface AuditLine {
  readonly kind: AuditKind;
  readonly id: string;
  readonly state: AuditState;
  /** How the owning run named itself, or undefined when nothing owns this. */
  readonly owner: string | undefined;
  /** What the resource is, where its id alone does not say. */
  readonly detail: string | undefined;
  /**
   * Set on a listener on the idle daemon's sentinel port and nowhere else.
   * Every other resource is attributed by the claim of the run that made it,
   * and the daemon is the one thing here that outlives every run, so it is the
   * one thing that has to identify itself.
   */
  readonly daemonIdentity: DaemonIdentity | undefined;
  /**
   * Set on a running compose project and nowhere else: where the teardown's
   * triage placed it. A compose project is the one resource here whose claim
   * cannot decide its fate on its own — a stack outlives the run that brought
   * it up — so what may be done about one is carried beside its state rather
   * than read out of it.
   */
  readonly projectStanding: ProjectStanding | undefined;
  /**
   * Set on a socket file and nowhere else: what a connect to it answered.
   * Absent where nothing asked, which is every socket a claim placed and every
   * one a pass could establish nothing about — the question is only ever put
   * to the kernel about the files ownership leaves open.
   */
  readonly socketAnswer: SocketAnswer | undefined;
  /**
   * Set on a stranded store — a wrangler store or an E2E RAM root — and nowhere
   * else: what the kernel said about whether any process holds a file open
   * inside it. Absent where nothing asked, which is a line assembled from a
   * reading that carries no answer — every pass that reads the world puts the
   * question to the stores it found.
   */
  readonly storeAnswer: StoreAnswer | undefined;
  /**
   * Set on a stranded store this pass tried to remove and could not, and
   * nowhere else: what stopped it, in the words the line prints. It is the
   * one thing that turns a reclaimed kind back into a human's, so it is carried
   * on the line rather than inferred — a store reported as reclaimed while what
   * it held is still on disk is the silence the reclaim was introduced to end.
   */
  readonly unreclaimed: string | undefined;
  /**
   * Set on a database or a bucket: the run its own name says made it, which is
   * undefined for a name minted before names in its family carried one. Carried
   * from the classification rather than read out of the id a second time, so
   * what a line says about a name and what it was classified on cannot differ.
   */
  readonly namedRun: string | undefined;
  /**
   * Set on a process group holding a run's processes that the run's record does
   * not name, and nowhere else: how the group came to exist. It is carried
   * beside the state rather than read out of it for the reason
   * {@link AuditLine.projectStanding} is — the claim names the run and says
   * nothing about the group, so what may be done about one is not in the claim.
   */
  readonly groupOrigin: GroupOrigin | undefined;
  /**
   * Set on a line some run's claim recorded: where that run's own process
   * stands. Absent where nothing claims the resource, and absent wherever the
   * standing could not be established.
   *
   * A compose project reads this exactly like every other kind, and the reason
   * `auditComposeProjects` in `scripts/lib/claims/world-audit.ts` gives for deciding a project from its triage
   * standing does not reach the case: that reason is about an *expired* claim,
   * which is evidence about the run and not about the stack, while a live claim
   * is the whole answer wherever there is one and `projectVerdict` in `scripts/lib/claims/world-verdicts.ts` hands
   * one straight to `claimedVerdict` in `scripts/lib/claims/world-verdicts.ts`. So a stack a decapitated run holds
   * pages, and what it asks for is that tree — never a teardown, which no
   * standing of a claim ever licenses here.
   */
  readonly runStanding: RunStanding | undefined;
  /**
   * Set on a resource whose age this pass asked about, which is the classes it
   * reclaims itself. Absent where nothing asked, and an absent age is not a
   * young one: only an established age carries a resource past the boundary.
   */
  readonly age: ResourceAge | undefined;
}

/**
 * A process group a run recorded, in the shape a line is built from. In a
 * {@link WorldReading} it is one the pass found still running: the run's own
 * state is then the whole of what separates an ordinary child from an orphan.
 *
 * What enumerates this class, and what that leaves outside every line built
 * from one, is stated at `RecordedProcessGroup` in
 * `scripts/lib/spawn/long-lived.ts` — the reading this is a projection of.
 */
export interface ProcessGroupReading {
  readonly pgid: number;
  /** Whether the run that recorded it still holds its claim. */
  readonly runLive: boolean;
  /** How that run named itself, so a reader knows what the tree was. */
  readonly owner: string;
}

/**
 * How a process group came to hold a run's processes while that run's record
 * names no such group.
 *
 * `departed` is the failure this class exists for: one of the run's own
 * processes made the group, below the tree the run recorded, so the recorded id
 * reaches the tree everywhere except here. `never-recorded` is the different
 * failure it must not be confused with: the group was made above the run and
 * the run's processes merely inherited it, so nothing left anything — nothing
 * ever recorded it. The repairs differ, which is why the two are separated: a
 * departed group is led by one of the run's own and is the run's to end, while
 * a never-recorded one is led by whatever started the run — routinely the
 * reader's own shell — and is a group to look at rather than signal.
 *
 * `unestablished` is where the discriminator itself is gone. The group's leader
 * is what says which of the two this is — a leader carrying the run's identity
 * is one of the run's own processes and made the group — and a group whose
 * leader the kernel no longer describes answers neither way. It is separate
 * from both because naming one of them there would be a confident wrong answer
 * about which defect a reader should go and look for.
 */
export type GroupOrigin = 'departed' | 'never-recorded' | 'unestablished';

/**
 * A process group holding a run's processes that the run's own record does not
 * name, and so a tree no reading built from that record reaches.
 *
 * WHY ANYTHING IS HERE AT ALL. The registry records one group per
 * `spawnLongLived` call, and everything below a recorded leader is named by
 * nothing of its own: the recorded id is the whole handle, and it holds only
 * while every descendant stays in that group. A descendant leaves by
 * `detached`, by `setsid`, or by a task runner that groups its own tasks, and
 * once it has, it is named by no record and enumerated by no other reading
 * here — invisible rather than reported as unowned. An unowned resource is a
 * named cost a human can rule on; an invisible one is a resource whose absence
 * from every count reads as success.
 *
 * WHAT FINDS IT. The run publishes its record's path in the environment under
 * `RUN_CLAIM_ENV` in `scripts/lib/claims/registry.ts` and every process it starts inherits it, so the kernel
 * holds, on each process, the name of the run it belongs to. That is the same
 * fact the reclaim's own attribution rests on, read here of every live process
 * rather than of the members of an id a record already named — which is what
 * makes it able to find a process the record cannot reach.
 *
 * ONLY OF A RUN THAT HAS ENDED, AND THAT IS NOT CAUTION. A live run's
 * unrecorded group is indistinguishable from one it is on its way to recording:
 * a detached child exists before its group id can be known, so the spawn helper
 * in `scripts/lib/spawn/long-lived.ts` necessarily records after it, and between
 * the two moments
 * the child is a group leader carrying the run's identity that no record names
 * — the exact signature of a departure. That window was met on the first
 * reading of a real machine this census ever took, on another checkout's run.
 * Reporting it would name a neighbour's ordinary spawn an escape, and a
 * detector that cries wolf about neighbours is worse than none. A run that has
 * ended spawns nothing, so the window cannot be open, and what the census says
 * about one is about what that run left behind.
 */
export interface StrayGroupReading {
  readonly pgid: number;
  /**
   * That run's own processes in it, by id, ascending — which is every process a
   * repair addressing this group one at a time must address. They are carried
   * rather than counted because for one origin the group is not the reader's to
   * enumerate: it was made above the run, routinely by the shell the audit is
   * running in, so enumerating it is sifting one's own session.
   */
  readonly members: readonly number[];
  readonly origin: GroupOrigin;
  /** How the run that no longer holds its claim named itself. */
  readonly owner: string;
}

/**
 * One live process, as the census reads it: the group it is in, and the run
 * record its environment names where it names one.
 *
 * Every process is carried rather than only the ones carrying a run's identity,
 * because the presence of a group's leader is what separates a departure from a
 * group made above the run, and a leader carrying no identity is exactly the
 * case that answers.
 */
export interface ProcessReading {
  readonly pid: number;
  readonly pgid: number;
  /** The run record its environment names, or nothing where it names none. */
  readonly runDir: string | undefined;
}

/**
 * A socket file this pass found, and what a connect to it answered.
 *
 * The answer is absent until something asks, and nothing asks before the
 * registry has been read: a file a claim places is settled by that claim alone,
 * so a read-only pass never connects to a live spawner's address.
 */
export interface LifelineSocketReading {
  readonly address: string;
  readonly answer: SocketAnswer | undefined;
}

/**
 * What the operating system said about whether any process is inside a stranded
 * store: `occupied` where one holds a file open under it, `vacant` where none
 * does, and `unknown` where the question could not be put at all.
 *
 * It is the same kind of evidence a connect gives about a socket file — an
 * answer about what exists right now, not a claim, an age or a stamp — and it
 * is the whole of what separates a store the reclaim removes from one it leaves
 * alone. `unknown` is spared: a store that might be in use is left standing,
 * and the next pass asks again.
 */
export type StoreAnswer =
  | { readonly kind: 'occupied' }
  | { readonly kind: 'vacant' }
  | {
      readonly kind: 'unknown';
      /** Why the question could not be put, in the words the line prints. */
      readonly reason: string;
    };

/** A stranded store a pass asked about, and what it was told. */
export interface WranglerStoreReading {
  /** The store, as {@link WorldReading.wranglerStores} names it. */
  readonly store: string;
  readonly answer: StoreAnswer;
}

/** A stranded store a pass tried to remove, and what stopped it. */
export interface StoreReclaimFailure {
  /** The store, as {@link WorldReading.wranglerStores} names it. */
  readonly store: string;
  /** Why the removal did not happen, in the words the line prints. */
  readonly reason: string;
}

/** A snapshot directory and the answer its own lock gave. */
export interface SnapshotProbe {
  readonly id: string;
  readonly held: boolean;
  readonly holder: string | null;
}

/**
 * One reading of the world, taken before the registry is consulted for
 * ownership. The process class is the exception that proves the shape: nothing
 * on the machine advertises that a tree was ours, so its reading is taken from
 * the registry itself and carries the run it was read from.
 */
export interface WorldReading {
  readonly containers: readonly ContainerReading[];
  /**
   * Every container of this clone docker is not running, whichever compose
   * project owns it. Disjoint from {@link WorldReading.containers} by what each
   * listing keeps: that one keeps only the containers no compose project owns,
   * and this one is selected by the label the compose file stamps.
   */
  readonly stuckContainers: readonly LabelledContainer[];
  readonly databases: readonly string[];
  readonly buckets: readonly string[];
  readonly listeningPorts: readonly ListenerReading[];
  /**
   * Every process group holding some run's processes that the run's own record
   * does not name. Read from the machine and the registry together, because
   * neither answers it alone: the record says which groups are accounted for,
   * and only the kernel knows which group each process is actually in.
   */
  readonly strayGroups: readonly StrayGroupReading[];
  /** Every sentinel port found listening, with what its holder proved. */
  readonly daemonPorts: readonly SentinelReading[];
  /** Every recorded process group this pass found still running. */
  readonly processGroups: readonly ProcessGroupReading[];
  /**
   * Where each live run's own process stands. Read out of the registry like the
   * process class and for the same reason: nothing on the machine says which
   * run a process belongs to, and the claim is what does.
   */
  readonly runRoots: readonly RunRootReading[];
  readonly snapshots: readonly SnapshotProbe[];
  readonly asides: readonly string[];
  /** Every socket file a spawning process left in the temporary directory. */
  readonly lifelineSockets: readonly LifelineSocketReading[];
  /**
   * Every wrangler local store this checkout holds, as a path relative to it,
   * and every E2E RAM root on the machine whose checkout is gone, as its
   * absolute path: the one store that lives outside every checkout, named the
   * only way that reaches it. A reading is taken before the registry is read,
   * so a store a reclaiming pass goes on to empty or remove is still here;
   * `reportWorldAudit` in `scripts/lib/claims/world-audit.ts` is where one
   * drops out.
   */
  readonly wranglerStores: readonly string[];
  /** Every stranded store this pass tried to remove and could not, with the reason. */
  readonly unreclaimedStores: readonly StoreReclaimFailure[];
  /**
   * What the kernel said about each stranded store this pass asked about. Empty
   * on a reading taken before anything was asked; `reportWorldAudit` in `scripts/lib/claims/world-audit.ts` is
   * where the answers are put in, because the question is only ever put to a
   * store the pass is about to decide the fate of.
   */
  readonly storeAnswers: readonly WranglerStoreReading[];
  /** Every running compose project of this repository, and what places each. */
  readonly composeProjects: ComposeProjectWorld;
  /** Classes this reading tried to cover and could not, each with the reason. */
  readonly unreadable: readonly string[];
  /**
   * Classes this pass has no mechanism to read, whatever put them in that
   * state, each in the words the report prints. Separate from
   * {@link unreadable} because the two ask different things of a reader: a
   * class that failed to read is one a human can go and fix, and a class
   * nothing offered the pass is a limit of the report itself.
   */
  readonly uncovered: readonly string[];
}
