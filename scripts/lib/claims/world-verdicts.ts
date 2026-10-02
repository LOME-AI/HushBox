/**
 * What a found resource means: which command reclaims its class, who stands
 * where its owning run's name would, and what the reader is told to do.
 */

import { RECLAIM_BOUNDARY_PHRASE, pastReclaimBoundary, unreadAgeClause } from './resource-age.js';

import type { DaemonIdentityRecord } from '../stack/idle-killer-daemon.js';
import type {
  AuditKind,
  AuditLine,
  AuditState,
  GroupOrigin,
  ProjectStanding,
  StoreAnswer,
  WorldReading,
} from './world-reading.js';
import type { ResourceAge } from './resource-age.js';
import type { SocketAnswer } from '../spawn/long-lived.js';

/**
 * Everything one report line says about one resource — who stands where the
 * owning run's name would, what the reader should do about it, and whether that
 * is something a human must still act on. Three statements about one resource,
 * so one decision yields all three: deciding them apart is what let a line
 * blame a file for a missing claim and, in the same line, tell the reader the
 * resource is right as it stands — and then count a resource with nothing to
 * apply among the ones nothing reclaims.
 */
interface LineVerdict {
  readonly owner: string;
  readonly repair: string;
  /**
   * Whether this resource is a page. A repair the reader is told not to apply
   * is not one, so a resource whose repair is to leave it alone never counts:
   * paging on one the design deliberately reclaims would leave the auditor
   * permanently red on something no mechanism can clear, and an auditor that is
   * permanently red is one nobody reads.
   */
  readonly pages: boolean;
}

/**
 * What a line says to do about a resource whose owning run has gone, and
 * whether a human must still act on it. The owner half of such a line is the
 * claim's own name, so it is the one half a class never supplies.
 */
interface ExpiredVerdict {
  readonly repair: string;
  readonly pages: boolean;
}

interface ResourceClass {
  /** The verdict on one of these whose owning run has gone. */
  readonly expired: ExpiredVerdict;
  /** The whole verdict an unclaimed one of this kind gets. */
  readonly unowned: LineVerdict;
}

/** A kind something reclaims unasked, which is why nobody is paged about one. */
function reclaimedBy(command: string): ExpiredVerdict {
  return { repair: `reclaimed by \`${command}\``, pages: false };
}

/** The fate of an unclaimed one of a kind no pass goes near unasked. */
const NOTHING_RECLAIMS_UNCLAIMED = 'nothing reclaims one no claim names';

/**
 * A kind whose resources are recorded against the claim of the run that creates
 * one. No file creates one and then silently fails to record it: a recorder
 * given no claim to record against refuses before anything is created, and the
 * callers whose resource is accounted for without a claim say so at their own
 * call site. So a line here is either one of those deliberate silences or an
 * origin no recorder here saw, and it accounts for the silence rather than
 * attributing it, because nothing here can say what created it — the repair is
 * a human's.
 *
 * `unclaimedFate` is per kind rather than one sentence here, because there is
 * no repository-wide truth to state: a port has a flag that ends an unclaimed
 * one, and a database has a migration that still drops one on its creation
 * stamp.
 */
function recordedByItsRun(reclaimer: string, unclaimedFate: string): ResourceClass {
  return {
    expired: reclaimedBy(reclaimer),
    unowned: {
      owner: UNRECORDED_RESOURCE,
      repair:
        'remove it by hand once you have confirmed it is yours — ' +
        `\`${reclaimer}\` reclaims one whose run recorded it, and ${unclaimedFate}`,
      pages: true,
    },
  };
}

/**
 * What stands where the owning run would on a resource of a kind recorded
 * against its run's claim, when no claim names it. Shared by every such kind,
 * the socket included, because the sentence is about the recording and not
 * about the resource.
 */
const UNRECORDED_RESOURCE =
  'no claim — nothing recorded it, which is what a process that held no run claim leaves ' +
  'behind, so nothing here can say what created it';

/**
 * The command a line names as the one that goes after what a finished run left:
 * its socket file, and the tree it started. What becomes of either is the
 * line's own to say — each states what the command attempts and what answer
 * stops it. It is not the only thing that goes after them either — a bring-up
 * does both on its way in, which is what keeps them from accumulating on a
 * machine where nobody runs a cleaning command by hand — but it is the one a
 * reader of the line can run, which is what a line offering a repair is for.
 */
const EXPIRED_CLAIM_RECLAIMER = 'pnpm dev:clean';

/** What reclaims a purge aside, in every place a line names it. */
const ASIDE_RECLAIMER = 'pnpm e2e';

/**
 * What reclaims a container no compose project owns, in every place a line
 * names it. The stack bring-up runs the same pass, which is what the lines
 * about one past the boundary say: a reader who runs nothing by hand still has
 * it taken.
 */
const CONTAINER_RECLAIMER = 'pnpm docker:cleanup';

/**
 * What every line about a resource the boundary has released says about why.
 * One spelling, because the two classes that reclaim themselves both print it
 * and a reader comparing the two must not meet two sentences.
 */
const PAST_THE_BOUNDARY =
  'nothing recorded it and it has stood longer than the ' +
  `${RECLAIM_BOUNDARY_PHRASE} a resource nothing accounts for is left standing for`;

/**
 * What reclaims a stranded store, a wrangler store or an E2E RAM root, in every
 * place a line names it. It is a phrase rather than a command because there is
 * no command to offer: the removal is not something a reader runs, it is
 * something the next bring-up does on its way in.
 */
const WRANGLER_STORE_RECLAIMER = 'the next stack bring-up';

/**
 * The claim every line about a stranded wrangler store makes, in the one
 * spelling all of them print. It is a value rather than a sentence each line
 * spells for itself, because two spellings of one claim drift and these two
 * had.
 *
 * Why it holds is stated once in `scripts/lib/wrangler/store-writers.ts`, whose
 * header says what enforces the property and what its own scan can and cannot
 * see, and it is named here rather than summarised. A summary of it in prose
 * can go narrower or wider than the code without either of them changing, which
 * is what happened to the sentence this replaced: it claimed that module
 * enumerates every door, and that module's own text says it judges neither door
 * completely and is fast feedback rather than a guarantee.
 */
export const NO_LOCAL_STORE_WRITER = 'no invocation this repository makes writes to it';

/**
 * What a reclaim leaves standing where the store's contents were, in the one
 * spelling every line about it prints.
 *
 * Emptying alone leaves the path free, and the next local write that names no
 * persist target fills it again. Which writes those are cannot be enumerated
 * here — a spelling is a program token, a module option or a shell line nobody
 * has thought of — so what holds the property is the directory itself: kept in
 * place, emptied, and stripped of every write permission, so a write that
 * reaches it fails at the moment it runs whatever its spelling.
 *
 * The barrier is a permission, and a permission is the platform's to enforce.
 * The refusal is established on Linux by the case that attempts a write in the
 * directory a reclaim left; nothing here establishes it anywhere else, which is
 * why the line says where it holds rather than that it holds everywhere.
 */
export const STORE_BARRIER =
  'the emptied directory is left standing with no write permission, so a later write that ' +
  'names no persist target fails there wherever the platform enforces one';

/** The permission bits that let something be written into a directory. */
export const WRITE_PERMISSIONS = 0o222;

/**
 * The permission a reclaim leaves a store's directory carrying: readable and
 * traversable, so an ordinary listing, an ordinary recursive removal and a
 * version-control walk all still cross it, and writable by nobody. Derived from
 * the bits `isStoreBarrier` in `scripts/lib/claims/world-scan.ts` reads it back by rather than written out
 * beside them, so the two cannot come to disagree.
 */
export const BARRIER_MODE = 0o777 & ~WRITE_PERMISSIONS;

/**
 * What stands where the owning run would on a wrangler store. No file takes a
 * claim on one, so none is at fault for a store standing unclaimed: a store
 * belongs to the stack mode its directory names rather than to any run.
 */
const UNNAMED_STORE =
  'no claim — a store belongs to the stack mode its directory names, and this one names none';

/**
 * The whole verdict on a stranded store, which is the one unowned resource here
 * that is dealt with rather than reported.
 *
 * The reasoning that separates it from an unowned port, which is reported and
 * never ended: a port leaves open what is behind it, possibly another
 * developer's server, and nothing about the number says whose it is. A store is
 * a directory inside this checkout at a path this repository's own tooling
 * chooses, so it can belong to no other clone and no other user; and the one
 * question left — whether a process is inside it — is put to the operating
 * system store by store ({@link StoreAnswer}). This is the verdict on one
 * nothing was holding open.
 */
const RECLAIMED_STORE: LineVerdict = {
  owner: UNNAMED_STORE,
  repair:
    `emptied by ${WRANGLER_STORE_RECLAIMER} — it sits inside this checkout at a path this ` +
    "repository's own tooling chooses, so no other clone and no other user can hold it, and " +
    `${NO_LOCAL_STORE_WRITER}; ${STORE_BARRIER}`,
  pages: false,
};

/**
 * The verdict on a store a process is inside. It is spared for the same kind of
 * reason a socket file that answers is: the operating system says something is
 * behind it, so removing it would destroy state something is using.
 *
 * It asks nobody for anything, and that is the point rather than an omission.
 * Nothing is wrong with a store a process is using — the next pass finds it
 * free and takes it — so a line sending a reader to investigate one would be
 * asking for a repair where there is nothing to repair.
 */
function occupiedStore(owner: string): LineVerdict {
  return {
    owner,
    repair:
      'left standing — a process holds a file open inside it, so something is using it, and ' +
      `${WRANGLER_STORE_RECLAIMER} takes it once nothing does`,
    pages: false,
  };
}

/**
 * The claim every line about a stranded E2E RAM root makes, in the one spelling
 * the line and the reclaim's own report both print. Only the E2E RAM-root
 * resolver names a root's path, and it names it for the checkout the root's
 * owner file records.
 */
export const NO_RAM_ROOT_WRITER =
  'only an E2E run of the checkout its owner file names writes to it, and no directory ' +
  'stands at that path now';

/** What stands where the owning run would on a stranded E2E RAM root. */
const UNNAMED_RAM_ROOT =
  'no claim — an E2E RAM root belongs to the checkout its owner file names, and that ' +
  'checkout is gone';

/**
 * The whole verdict on a stranded E2E RAM root nothing was holding open. It is
 * removed whole rather than emptied behind a barrier, because the reason a
 * wrangler store keeps one does not reach it: no write that names no persist
 * target lands on a path only the resolver names, and a barrier there would
 * refuse the fresh root a checkout made again at that path claims.
 */
const RECLAIMED_RAM_ROOT: LineVerdict = {
  owner: UNNAMED_RAM_ROOT,
  repair: `removed by ${WRANGLER_STORE_RECLAIMER} — ${NO_RAM_ROOT_WRITER}`,
  pages: false,
};

/**
 * The verdict on a store nothing could be established about. Unknown is spared,
 * on the same rule the socket verdict follows: only a definite answer that
 * nothing is there licenses a removal.
 *
 * It pages about none of it, for the reason {@link WorldReading.uncovered}
 * gives.
 */
function unaskedStore(owner: string, reason: string): LineVerdict {
  return {
    owner,
    repair:
      'left standing — whether a process holds a file open inside it could not be asked ' +
      `(${reason}), and a store that may be in use is left alone; ` +
      `${WRANGLER_STORE_RECLAIMER} takes it once the question can be answered and nothing is ` +
      'inside it',
    pages: false,
  };
}

/**
 * The verdict on a store the pass tried to empty and could not. It is the only
 * line of this kind that asks a human for anything, and it names what stopped
 * the removal: a store that cannot be emptied reported as reclaimed would leave
 * the count at zero while the disk kept filling, which is the failure the
 * reclaim exists to end rather than to move.
 */
function unreclaimedStore(owner: string, reason: string): LineVerdict {
  return {
    owner,
    repair: `remove the directory by hand — ${WRANGLER_STORE_RECLAIMER} could not (${reason})`,
    pages: true,
  };
}

/**
 * What stands where a compose project's owning run would when no claim names
 * it. Two things reach it and nothing readable separates them: a project
 * brought up before the bring-up recorded one, and a project brought up by a
 * command holding no run claim, which records nothing. No file failed to take
 * a claim it is supposed to take — the bring-up records the project before it
 * creates it — so this accounts for the silence instead of attributing it.
 */
const UNRECORDED_PROJECT =
  'no claim names it — a project brought up before the bring-up recorded one, or by a command ' +
  'holding no run claim, carries none, and nothing here can say which of those this is';

const CLASSES: Record<AuditKind, ResourceClass> = {
  // Every line of this kind is decided from the standing its triage gave it,
  // never from the claim alone: a stack outlives the run that brought it up, so
  // an expired claim here is evidence about the run and not about the stack.
  // Neither of these is reached, because a compose line always carries a
  // standing; they are spelled out because the union admits no kind that leaves
  // an answer unsupplied, and both say the only thing true of a compose project
  // whatever its standing — that nothing about its claim alone licenses ending
  // one.
  'compose-project': {
    expired: {
      repair: 'leave it — a run ending is no evidence the stack it brought up is dead',
      pages: false,
    },
    unowned: {
      owner: UNRECORDED_PROJECT,
      repair: 'leave it — nothing about a claim alone says whether a stack is in use',
      pages: false,
    },
  },
  container: recordedByItsRun(CONTAINER_RECLAIMER, NOTHING_RECLAIMS_UNCLAIMED),
  'stuck-container': {
    // A compose project's containers are not recorded one by one — the project
    // is — so a claim never names one of these and this verdict is unreachable.
    // It is spelled out because the union admits no kind that leaves an answer
    // unsupplied, and it says the only true thing there is to say.
    expired: {
      repair: 'removed with the compose project a claim on one would name',
      pages: false,
    },
    unowned: {
      owner:
        'no claim — a compose project’s containers are not recorded one by one, so nothing ' +
        'here can say which bring-up left this one behind',
      repair:
        'remove it by hand once you have confirmed the project it belongs to is not using it — ' +
        `\`pnpm docker:cleanup\` reclaims only a container no compose project owns, and a ` +
        'teardown reaches this one only by taking the whole project down',
      pages: true,
    },
  },
  // The one kind recorded against its run whose unclaimed line asks for
  // nothing, because a sweep takes every one of them rather than some. Two
  // readings do it and they answer at different moments, so the line names
  // both: a database whose creation stamp cannot be read is debris nothing
  // else could ever select, and goes on the pass that finds it; one carrying a
  // readable stamp goes to the pre-registry path on that stamp. No file failed
  // to claim it either way — provisioning records the prefix before it creates
  // anything — so the line accounts for the silence exactly as the other
  // recorded kinds do.
  database: {
    expired: reclaimedBy('pnpm test'),
    unowned: {
      owner: UNRECORDED_RESOURCE,
      repair:
        'reclaimed by `pnpm test` — one whose creation stamp cannot be read goes on the pass ' +
        'that finds it, and one carrying a readable stamp goes to the pre-registry path on ' +
        'that stamp',
      pages: false,
    },
  },
  'stage-database': {
    expired: reclaimedBy('pnpm test'),
    unowned: {
      // No file failed to claim this one. A build records its staging name
      // against its run before any statement creates a database under it, and a
      // build holding no run claim is refused before it stages anything — so
      // what reaches this line was staged outside that path, the databases from
      // before that registration existed being the origin there is a record of.
      // Naming the provisioning file would blame it for a claim it takes and
      // prescribe a repair already applied there.
      //
      // This is the half of the verdict written about a name carrying no run at
      // all; {@link unclaimedStageVerdict} is where one that carries a run gets
      // the other half, and why the two cannot share a sentence.
      owner:
        'no claim — its name carries no run, and nothing recorded it, so nothing here can say which build staged it',
      repair:
        'remove it by hand once you have confirmed no build is filling it — nothing reclaims a ' +
        'staging database no claim names',
      pages: true,
    },
  },
  bucket: recordedByItsRun('pnpm test', NOTHING_RECLAIMS_UNCLAIMED),
  port: recordedByItsRun(
    'pnpm dev:clean',
    'only `pnpm dev:clean --unowned` ends one no claim names'
  ),
  'process-group': {
    // What ends one, on what evidence, and what it does not reach is stated
    // once at `reclaimProcessGroups` in `scripts/lib/spawn/long-lived.ts`; this
    // line carries the licence the signal is gated on rather than restating the
    // mechanism, because a reader whose tree the pass spared — its id since
    // given to something else, or a platform whose attribution can never answer
    // — would otherwise be reading a promise the pass did not keep, and a
    // reader who has found one line false stops trusting the report. The pass
    // printing this line still signals nothing itself: the reclaim runs in the
    // command the line names, and this one reports.
    expired: {
      repair:
        `\`${EXPIRED_CLAIM_RECLAIMER}\` ends it only where the kernel says the processes in it ` +
        "are that run's and lets the signal through, and every tree it spares instead is named " +
        'on the terminal — an id the kernel has since given to something else, a platform that ' +
        'cannot answer the question at all, a signal it refuses',
      pages: false,
    },
    // A group is read out of the record of the run that started it, so one no
    // claim names is one nothing enumerated and this verdict is unreachable.
    // It is spelled out because the union admits no kind that leaves an answer
    // unsupplied, and it says the only true thing there is to say.
    unowned: {
      owner: 'no claim — nothing recorded this group, so nothing here can say what started it',
      repair: 'find out what it is before ending it by hand',
      pages: true,
    },
  },
  // Every line of this kind is decided from the origin the census gave it,
  // never from the claim alone: the claim names the run and says nothing about
  // a group it never recorded. Neither of these is reached, because a stray
  // line always carries an origin; they are spelled out because the union
  // admits no kind that leaves an answer unsupplied, and both say the only
  // thing true of a group no record names whatever its origin — that no
  // reclaimer here reaches it.
  'stray-group': {
    expired: {
      repair: `end it by hand — no record names it, so \`${EXPIRED_CLAIM_RECLAIMER}\` never asks about it`,
      pages: true,
    },
    unowned: {
      owner: 'no claim — nothing recorded this group, so nothing here can say what started it',
      repair: 'find out what it is before ending it by hand',
      pages: true,
    },
  },
  snapshot: {
    expired: reclaimedBy('pnpm e2e'),
    // A snapshot holds its own claim beside itself rather than being recorded
    // against a run, and `auditSnapshots` in `scripts/lib/claims/world-audit.ts` reads that lock for the state,
    // so a snapshot never reaches an unowned line. It is spelled out because
    // the union admits no kind that leaves an answer unsupplied, and it says
    // the only true thing there is to say.
    unowned: {
      owner: 'no claim — a snapshot is named by the claim beside it, and this one is named by none',
      repair: 'remove the directory by hand once no run is serving from it',
      pages: true,
    },
  },
  socket: {
    // The attempt rather than the outcome, on the ground the unowned refused
    // line states in {@link unclaimedSocketVerdict}: an unlink the operating
    // system refuses is reported by the pass that made it and the file left
    // standing, and a refusal is knowable only by attempting — so a dry run
    // promising the reclaim is contradicted by the pass that makes it.
    expired: {
      repair:
        `\`${EXPIRED_CLAIM_RECLAIMER}\` attempts the removal — an unlink the operating system ` +
        'refuses is reported by the pass that made it, and the file is left standing',
      pages: false,
    },
    // The whole verdict on an unclaimed socket is decided from what a connect
    // to it answered, and this is the one case where nothing asked: a pass that
    // classified the file without putting the question to the kernel. Every
    // answer there is has a verdict of its own in {@link unclaimedSocketVerdict}.
    unowned: {
      owner: UNRECORDED_RESOURCE,
      repair:
        'nothing connected to it, so whether a process is behind it is unestablished — ' +
        `\`${EXPIRED_CLAIM_RECLAIMER}\` connects, and removes the file only where the connect is refused`,
      pages: true,
    },
  },
  aside: {
    expired: reclaimedBy(ASIDE_RECLAIMER),
    unowned: {
      // No file failed to claim one: the rename that mints an aside takes no
      // claim, by design — the run is in the directory name, which is what
      // `asideOwner` in `scripts/e2e-clean.ts` reads back out, and an aside its own run did not
      // remove is reclaimed by the next run of the command that made it.
      owner: "unclaimed by design — a finished run's discarded output",
      repair:
        `removed by \`${ASIDE_RECLAIMER}\` — an aside has no live consumer, so it is ` +
        'reclaimed rather than reported',
      // An aside has no live consumer by construction — it is the previous
      // run's discarded output, read by nothing — so the next run removes it
      // and nobody is asked to.
      pages: false,
    },
  },
  'wrangler-state': {
    // A store takes no claim, so it never reaches an expired line. It is spelled
    // out because the union admits no kind that leaves an answer unsupplied, and
    // it says the only true thing there is to say.
    expired: { repair: `removed by ${WRANGLER_STORE_RECLAIMER}`, pages: false },
    // The answer for a store nothing is inside, which is the only one the class
    // decides: a store something is inside, and one nothing could be
    // established about, are spared on the line's own answer rather than on
    // anything true of every store. {@link strandedStoreVerdict} is where the
    // three meet.
    unowned: RECLAIMED_STORE,
  },
  'ram-root': {
    // A root takes no claim, so its expired line is unreached for the reason a
    // wrangler store's is, and the class decides the one answer a store's
    // does: the answer for a root nothing is inside.
    expired: { repair: `removed by ${WRANGLER_STORE_RECLAIMER}`, pages: false },
    unowned: RECLAIMED_RAM_ROOT,
  },
};

/**
 * The idle-killer's daemon binds a host port, so the audit finds it, and no run
 * claims it: the daemon reclaims on behalf of every run, so a run holding its
 * port would have the next reclaimer kill it. It reports unowned every pass,
 * and its whole verdict says so — the claim the generic line asks for is the
 * one repair that must never be applied here, so there is nothing left for the
 * exit code to ask a human to do.
 *
 * This is the verdict on a daemon that has proved it is the process on that
 * port, never on the port number: an exemption handed out by address would be
 * silence on an allocated port, which is the one thing a squatter there would
 * most want.
 */
const IDLE_DAEMON: LineVerdict = {
  owner: 'unclaimed by design — the idle-killer reclaims for every run',
  repair: 'leave it — claiming it would have the next reclaimer kill the daemon',
  pages: false,
};

/**
 * Something holds the daemon's port and did not prove it is the daemon, so it
 * is reported like any other listener nothing accounts for. A daemon that
 * started before it could prove anything lands here too, and that is the honest
 * answer rather than a gap: nothing readable tells one apart from a squatter.
 * So the repair asks the reader to find out what it is, and names the one
 * outcome that needs nothing done — a daemon too old to identify itself still
 * ends itself when its slot goes idle, so nobody has to go and kill one.
 */
const UNIDENTIFIED_ON_SENTINEL: LineVerdict = {
  owner: 'no claim, and nothing there identified itself as the idle daemon',
  repair:
    'find out what it is before ending it — a daemon from before identity existed still ' +
    'exits on its own once its slot goes idle, and anything else is squatting on an ' +
    'allocated port',
  pages: true,
};

/**
 * A daemon of this repository whose identity record was still going into its
 * claim as the pass read it. Nothing is wrong and nothing is unknown: the
 * holder is alive, its record is being written, and the next read has it whole.
 * There is no repair, so there is nothing to page about — and paging here is
 * the false alarm this state was separated out to stop.
 */
const PUBLISHING_ON_SENTINEL: LineVerdict = {
  owner: 'an idle daemon caught while its record was still going in',
  repair: 'nothing to do — the next pass reads the record whole',
  pages: false,
};

/**
 * A daemon of this repository that says nothing about the stack it belongs to.
 * Every daemon built before one stated its stack is here, so this is the state
 * the rollout walks through rather than an anomaly — and it is reported, because
 * a daemon whose project cannot be read is a daemon whose teardown cannot be
 * predicted.
 */
const UNSTATED_ON_SENTINEL: LineVerdict = {
  owner: 'an idle daemon that says nothing about which stack it belongs to',
  repair:
    'find out which stack it belongs to before ending it — a daemon from before a daemon ' +
    'stated its stack still exits on its own once its slot goes idle',
  pages: true,
};

/**
 * The whole verdict on a daemon that named something this stack is not. The
 * differences are printed because the reader's next question is which of the
 * three disagreed, and because they are not equally urgent: a stale compose
 * project is the one that destroys another stack's data plane.
 */
function foreignDaemon(identity: {
  readonly stated: DaemonIdentityRecord;
  readonly differences: readonly string[];
}): LineVerdict {
  return {
    owner:
      `an idle daemon of another stack (pid ${String(identity.stated.pid)}) — ` +
      identity.differences.join('; '),
    repair:
      'find out which stack it belongs to before ending it — it tears down the compose ' +
      'project it names, wherever that project now lives',
    pages: true,
  };
}

/**
 * The whole verdict on a daemon this pass could not place. It agreed on
 * everything the pass was able to check, so nothing here says it belongs to
 * another stack — and nothing says it belongs to this one either, which is why
 * it is reported rather than exempted. The repair is to give the pass the one
 * thing it lacked, never to end a process nothing has identified.
 */
function uncomparedDaemon(identity: {
  readonly stated: DaemonIdentityRecord;
  readonly reason: string;
}): LineVerdict {
  return {
    owner:
      `a daemon whose stack this pass could not compare (pid ${String(identity.stated.pid)}) — ` +
      identity.reason,
    repair:
      'run this pass with the generated environment loaded — a pass that knows its own ' +
      'compose project is the one that can say whether this daemon is ours',
    pages: true,
  };
}

/**
 * The whole verdict on a resource this pass could not attribute either way. It
 * is not the unowned verdict with softer words: there is no file to blame,
 * because a claim on this may exist in the record nobody could read, and the
 * repair is that record rather than the resource. It pages, because an
 * unreadable record is exactly the thing a human has to go and resolve.
 */
const OWNERSHIP_UNESTABLISHED: LineVerdict = {
  owner:
    "ownership unestablished — a live run's record could not be read, so a claim on this may exist and be unreadable",
  repair:
    'leave it and deal with the unreadable run record this pass names, then run this again — ' +
    "nothing here can tell this from a live run's",
  pages: true,
};

/**
 * What a line says about a resource a claim still holds whose run has lost the
 * process that started it.
 *
 * It pages, which is the whole point: the claim is correct — a lock is held, so
 * the resource is genuinely owned-live — and there is nothing on the machine
 * that will ever release it, because what holds it is what a kill reparented.
 * Every reclaimer goes on sparing it, and the repair says so: this pass ends
 * nothing it did not start, and a tree like this is a person's to end.
 */
function decapitatedRun(owner: string): LineVerdict {
  return {
    owner,
    repair:
      'end the tree by hand and run this again — the process that started the run holding this ' +
      'is gone and the claim is held only by what that run left behind, so nothing will release ' +
      'it, and nothing here ends what it did not start',
    pages: true,
  };
}

/**
 * What a line says about a process group holding a finished run's processes
 * that the run's own record does not name.
 *
 * The origin decides it, because the two origins are two different defects with
 * two different repairs and the reader acts on which one this is: a departure
 * asks what below the run regroups without recording, and a group made above
 * the run asks why the run's own tree goes unrecorded.
 *
 * Every one of them pages. The run has gone, so nothing is going to come back
 * for these processes, and no reclaimer here enumerates them: the
 * process-group pass reads the record, and the record is what does not name
 * this group. That is the whole point of the class — an unowned resource is a
 * named cost a human can rule on, and one no reading reaches is a cost whose
 * absence from every count reads as success.
 *
 * Nothing here ends anything, on the division `docs/ARCHITECTURE.md`
 * §Observability draws: this detects and names, and a human repairs. A reclaim
 * keyed off a group no record names would be a mechanism acting on an id
 * nothing claimed, which is the one thing every other pass here refuses to do.
 */
function strayGroupVerdict(found: AuditLine, origin: GroupOrigin): LineVerdict {
  const owner = found.owner ?? 'the claim names no holder';
  if (origin === 'departed') {
    return {
      owner,
      repair:
        'end the tree by hand, then find the spawn that makes this group and record it — one of ' +
        "the run's own processes left the group its run recorded and made this one, which no " +
        'record names, so nothing here enumerates it and no reclaimer reaches it',
      pages: true,
    };
  }
  // The one branch here that asks for nothing to be signalled: this group's
  // leader is above the run, and in the canonical case — a run started from a
  // shell, whose plain non-detached child outlives it — the group is the
  // reader's own shell's, so a signal to it would end the session reading this.
  if (origin === 'never-recorded') {
    return {
      owner,
      repair:
        'look at this group rather than ending it — it was made above the run rather than left ' +
        'by anything, so its leader is not the run’s but whatever started it, routinely the ' +
        'shell this audit is running in, and a signal to the group would end that too; the ' +
        'processes this line counts are the run’s own and are the whole of what is left, so end ' +
        'those by their own ids, which this line carries — until they go, no reclaimer here ' +
        'touches them and this line returns on every later pass',
      pages: true,
    };
  }
  return {
    owner,
    repair:
      'end the tree by hand — no record names this group, and whether one of the run’s own ' +
      'processes left its recorded group to make it could not be established, because the ' +
      'process that made the group is gone',
    pages: true,
  };
}

function claimedVerdict(found: AuditLine): LineVerdict {
  const owner = found.owner ?? 'the claim names no holder';
  if (found.state === 'owned-live') {
    if (found.runStanding === 'decapitated') return decapitatedRun(owner);
    return { owner, repair: 'nothing to do — a live run owns it', pages: false };
  }
  const { repair, pages } = CLASSES[found.kind].expired;
  return { owner, repair, pages };
}

/**
 * The verdict on a socket file no claim accounts for, which is the one kind
 * here whose fate a second fact settles. The claim says nothing recorded the
 * file; what a connect to it answered says whether anything is behind it, and
 * only one answer licenses a removal.
 */
function unclaimedSocketVerdict(answer: SocketAnswer | undefined): LineVerdict {
  if (answer === undefined) return CLASSES.socket.unowned;
  switch (answer.kind) {
    case 'refused': {
      return {
        owner: UNRECORDED_RESOURCE,
        repair:
          `\`${EXPIRED_CLAIM_RECLAIMER}\` attempts the removal — no claim names it and a connect to ` +
          'it was refused, so there is nothing behind the file to strand, and an unlink the ' +
          'operating system refuses is reported by the pass that made it',
        // The attempt rather than the outcome, because this line is written by
        // a pass that may be making no removal at all: a dry run cannot know an
        // unlink the operating system will refuse, since a refusal is knowable
        // only by attempting, and the command that does attempt it ends
        // non-zero on one. Promising the reclaim here is a dry run its own real
        // pass contradicts, which teaches a reader to stop trusting the dry
        // run — the erosion this report exists to avoid.
        //
        // It still asks nobody to act, which is the other half of the sentence:
        // nothing is behind the file, the next pass attempts it again, and it
        // is why the dry run comes back clean on a temporary directory full of
        // these.
        pages: false,
      };
    }
    case 'answered': {
      return {
        owner: UNRECORDED_RESOURCE,
        repair:
          'end the process answering on it — a connect to it was accepted, so one that spawned ' +
          `while holding no run claim is behind it, and \`${EXPIRED_CLAIM_RECLAIMER}\` removes the ` +
          'file only where nothing answers',
        pages: true,
      };
    }
    case 'unknown': {
      // The one answer here that is not a failure to establish anything: it establishes that
      // there is no file. `removeSocketFile` in `scripts/lib/spawn/long-lived.ts` treats the
      // same answer as a no-op on that ground, and a line that paged would ask a human to act
      // on a file that went between this pass reading the directory and asking about it.
      if (answer.reason === 'ENOENT') {
        return {
          owner: UNRECORDED_RESOURCE,
          repair:
            'nothing to do — the connect found no file there, so the file this line names has ' +
            'gone since the directory was read',
          pages: false,
        };
      }
      return {
        owner: UNRECORDED_RESOURCE,
        repair:
          `clear what stopped the connect (${answer.reason}) and run this again — a refusal is ` +
          'the only answer that says nothing is behind it, so this one establishes neither that ' +
          'a process is there nor that none is',
        pages: true,
      };
    }
  }
}

/**
 * The whole verdict on a stranded store, which the line's own two facts settle
 * before its class is read. A removal that was attempted and failed comes
 * first: it is the one outcome that leaves the store on disk with nothing left
 * to try. Otherwise what the operating system said decides it, and the class
 * answers for a line built from a reading that carries no answer. Whichever
 * decides, the owner half is the class's: a wrangler store and a RAM root
 * belong to different things.
 */
function strandedStoreVerdict(found: AuditLine): LineVerdict {
  const reclaimed = CLASSES[found.kind].unowned;
  if (found.unreclaimed !== undefined) return unreclaimedStore(reclaimed.owner, found.unreclaimed);
  const answer = found.storeAnswer;
  if (answer === undefined || answer.kind === 'vacant') return reclaimed;
  return answer.kind === 'occupied'
    ? occupiedStore(reclaimed.owner)
    : unaskedStore(reclaimed.owner, answer.reason);
}

/**
 * The owner half of a staging database no claim accounts for, which two
 * different facts can produce and which needs two different sentences.
 *
 * A name minted before staging names carried a run really does carry none, and
 * the class says so. A name in the newer spelling carries one, and saying it
 * carries none would be a false reason rather than a stale one — a reader acts
 * on the reason, and the run this line names is the thing they would go and
 * look for. What is true of both is the repair, which the class supplies to
 * each.
 */
function unclaimedStageVerdict(namedRun: string | undefined): LineVerdict {
  const unclaimed = CLASSES['stage-database'].unowned;
  if (namedRun === undefined) return unclaimed;
  return {
    ...unclaimed,
    owner:
      `no claim — its name names run ${namedRun}, and no claim of that run was ever held, so ` +
      'nothing here can say which build staged it',
  };
}

/**
 * The verdict on an unclaimed resource nothing identified itself on, from what
 * the line carries before what its class says: a socket is settled by what a
 * connect answered, and a stranded store by what the operating system said
 * about it and by whether a removal was attempted and failed. None of those
 * facts is in the class, and all of them outrank it.
 */
function unclaimedByKind(found: AuditLine): LineVerdict {
  if (found.state === 'unknown') return OWNERSHIP_UNESTABLISHED;
  if (found.kind === 'socket') return unclaimedSocketVerdict(found.socketAnswer);
  if (found.kind === 'wrangler-state' || found.kind === 'ram-root') {
    return strandedStoreVerdict(found);
  }
  if (found.kind === 'stage-database') return unclaimedStageVerdict(found.namedRun);
  if (found.kind === 'container') return unclaimedContainerVerdict(found.age);
  if (found.kind === 'port') return unclaimedPortVerdict(found.age);
  return CLASSES[found.kind].unowned;
}

/**
 * The verdict on a listener no claim accounts for, which the one further fact
 * this pass asks about settles: how long it has been held.
 *
 * Past the boundary it is the next run's rather than a human's, and the line
 * says so — a resource reported every day for a month is the accumulation
 * nobody clears, which is what the boundary exists to end. Below it the line is
 * the one this printed before any of this existed, because a boundary that
 * changed what is said about young resources would be a boundary nobody could
 * check against what they already knew. An age nothing established is neither
 * of those: it keeps the line it has today and says why, since a line silent
 * about a question it asked and lost reads as one about a fresh resource.
 */
function unclaimedPortVerdict(age: ResourceAge | undefined): LineVerdict {
  const unclaimed = CLASSES.port.unowned;
  if (pastReclaimBoundary(age)) {
    return {
      owner: UNRECORDED_RESOURCE,
      repair:
        `reclaimed by \`${EXPIRED_CLAIM_RECLAIMER}\` — ${PAST_THE_BOUNDARY}, so the next run ` +
        'that sees it ends what is holding it',
      pages: false,
    };
  }
  if (age?.kind !== 'unreadable') return unclaimed;
  return { ...unclaimed, repair: `${unclaimed.repair}; ${unreadAgeClause(age.reason)}` };
}

/**
 * The verdict on a container no claim accounts for, which the boundary settles
 * exactly as it settles a listener's — and which was the one line here that had
 * gone false. The pass that removes an unclaimed container past the boundary is
 * the one every stack bring-up runs on its way in, so a reader was being sent
 * to remove by hand what the next bring-up takes, and the resource was being
 * counted among those nothing reclaims.
 *
 * A live run whose record could not be read never reaches this: that pass has
 * established nothing about ownership, so the line is
 * {@link OWNERSHIP_UNESTABLISHED}'s and the container stands. It is the same
 * gate the removing pass applies, and it is what keeps the two from disagreeing
 * — a reader that cannot tell who is alive cannot tell what is abandoned.
 */
function unclaimedContainerVerdict(age: ResourceAge | undefined): LineVerdict {
  const unclaimed = CLASSES.container.unowned;
  if (pastReclaimBoundary(age)) {
    return {
      owner: UNRECORDED_RESOURCE,
      repair:
        `reclaimed by \`${CONTAINER_RECLAIMER}\`, which every stack bring-up runs — ` +
        `${PAST_THE_BOUNDARY}, so the next pass that sees it removes it`,
      pages: false,
    };
  }
  if (age?.kind !== 'unreadable') return unclaimed;
  return { ...unclaimed, repair: `${unclaimed.repair}; ${unreadAgeClause(age.reason)}` };
}

/**
 * The verdict on a resource no readable claim accounts for. What a daemon
 * proved about itself on its own port comes first: that is a fact no run's
 * record bears on, so an unreadable record elsewhere neither exempts nor
 * implicates it.
 */
function unclaimedVerdict(found: AuditLine): LineVerdict {
  const identity = found.daemonIdentity;
  if (identity === undefined) return unclaimedByKind(found);
  switch (identity.kind) {
    case 'this-stack': {
      return IDLE_DAEMON;
    }
    case 'other-stack': {
      return foreignDaemon(identity);
    }
    case 'uncompared': {
      return uncomparedDaemon(identity);
    }
    case 'publishing': {
      return PUBLISHING_ON_SENTINEL;
    }
    case 'unstated': {
      return UNSTATED_ON_SENTINEL;
    }
    case 'unidentified': {
      return UNIDENTIFIED_ON_SENTINEL;
    }
  }
}

/**
 * The owner half of a compose line no readable claim names. A pass that could
 * not read a live run's record has established nothing about this project's
 * claim, so the line says that rather than that no claim exists — on the two
 * standings whose repair names a teardown, the unrecorded sentence is what
 * would remove the reader's one signal that a run this pass cannot see may be
 * working against the stack right now.
 */
function unattributedProjectOwner(state: AuditState): string {
  return state === 'unknown' ? OWNERSHIP_UNESTABLISHED.owner : UNRECORDED_PROJECT;
}

/**
 * What to do about one running compose project, from the standing its triage
 * gave it rather than from its claim.
 *
 * The rule this site is the first to need: where a resource's lifetime is
 * deliberately decoupled from its creating run, an expired claim is evidence
 * about the run and not about the resource, so the ownership answer may spare
 * and may not license. A live claim is therefore the whole answer wherever
 * there is one, and expired and unclaimed collapse into a single answer that
 * the worktree listing decides — which is also the only account a project
 * brought up before anything recorded one can ever have.
 */
function projectVerdict(found: AuditLine, standing: ProjectStanding): LineVerdict {
  // A run is working against this project right now, and nothing else here
  // outranks that: a directory that will not resolve does not make a stack in
  // use anyone's to end.
  if (standing === 'held' || found.state === 'owned-live') return claimedVerdict(found);

  const owner = found.owner ?? unattributedProjectOwner(found.state);
  const teardown = `\`docker compose -p ${found.id} down\``;
  switch (standing) {
    case 'current': {
      return {
        owner,
        repair:
          'leave it — the directory it was started from is a checkout this repository still ' +
          'lists, and the slot registry puts that checkout on no other project',
        pages: false,
      };
    }
    case 'reclaimable': {
      return { owner, ...reclaimedBy('pnpm docker:cleanup') };
    }
    case 'unaccounted': {
      return {
        owner,
        repair:
          'the checkout it was started from is still there and now runs a different project, ' +
          `so nothing reclaims this one — end it with ${teardown} once you have established ` +
          'that nothing is using it',
        pages: true,
      };
    }
    case 'unresolved': {
      return {
        owner,
        repair:
          'it carries no label naming its clone and git could not resolve the directory it ' +
          'was started from, so nothing here knows which clone it belongs to: that directory ' +
          'may have been deleted along with its checkout, or may never have been a checkout ' +
          'of this one, a directory that is gone is no evidence the stack it started is dead, ' +
          'and nothing stamps a label on a project already running — end it with ' +
          `${teardown} once you have established that nothing is using it`,
        pages: true,
      };
    }
    case 'other-clone': {
      return {
        owner,
        repair:
          'leave it — it belongs to a different clone of this repository, whose stacks are ' +
          "not this checkout's to end",
        pages: false,
      };
    }
    case 'blocked': {
      return {
        owner,
        repair:
          "leave it and deal with the unreadable run record this pass names — a live run's " +
          'record could not be read, so it counts as a run that may be working against ' +
          'anything and no compose project is torn down on its behalf',
        pages: true,
      };
    }
  }
}

/**
 * The whole verdict on one line, from one reading of one resource. A compose
 * project's is {@link projectVerdict}'s, standing and claim together; every
 * other kind is dispatched on the state of its claim. A resource in either
 * owned state has a claim and only the holder's *name* can be missing — a free
 * lock reports none — so neither of those states reaches an unowned answer,
 * which is written about a resource nothing recorded; and a line in neither
 * owned state is {@link unclaimedVerdict}'s whole answer, which reads what the
 * line itself carries before it reads the class — a reading of the daemon's own
 * sentinel port, a live run's record this pass could not read.
 *
 * A live run's resource is never anyone's to repair. A dead run's usually is
 * not either, because something reclaims it unasked; the kinds where nothing
 * does say so in their own class rather than inheriting a promise that a
 * command will come along and take care of it, which is what
 * {@link claimedVerdict} reads out of {@link CLASSES}.
 */
export function verdictOf(found: AuditLine): LineVerdict {
  const origin = found.groupOrigin;
  if (origin !== undefined) return strayGroupVerdict(found, origin);
  const standing = found.projectStanding;
  if (standing !== undefined) return projectVerdict(found, standing);
  return found.state === 'owned-live' || found.state === 'owned-expired'
    ? claimedVerdict(found)
    : unclaimedVerdict(found);
}
