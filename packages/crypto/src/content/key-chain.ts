import { fromBase64 } from '@hushbox/shared';
import { openChainLink, openEpochWrap } from './epoch-lifecycle.js';
import type { KeyChainEpoch, KeyChainResponse, KeyChainWrap } from '@hushbox/shared';
import type { EpochCommitment, EpochKeyFailure, OpenedEpochKey } from './epoch-lifecycle.js';

/**
 * Whether a key for the epoch itself was obtained and checked, through a
 * direct wrap or through a verified chain link from a newer epoch.
 */
type EpochKeyVerdict =
  | { readonly status: 'ok' }
  | { readonly status: 'bad'; readonly reason: EpochKeyFailure }
  | { readonly status: 'unreachable' };

/**
 * Whether the chain link this epoch carries opens to a key matching its
 * predecessor's published record. A bad link is a verdict on the link, never
 * on the carrying epoch's own key. `absent`: the record carries no link.
 * `unopened`: the carrying epoch's key was not obtained.
 */
type ChainLinkVerdict = 'ok' | 'bad' | 'absent' | 'unopened';

interface EpochVerdict {
  readonly key: EpochKeyVerdict;
  readonly link: ChainLinkVerdict;
}

export interface KeyChainVerdict {
  readonly epochs: ReadonlyMap<number, EpochVerdict>;
  /**
   * `bad` when the current epoch's key is bad, or any link on the path from
   * the current epoch down to the principal's floor is bad.
   */
  readonly rotation: 'ok' | 'bad';
  /**
   * The highest epoch whose key verified and whose every link down to the
   * floor verified or ends there; null when no epoch qualifies.
   */
  readonly lastGoodEpoch: number | null;
  /** Every key whose own verdict is ok, whatever its link verdict. */
  readonly keys: ReadonlyMap<number, Uint8Array>;
}

/**
 * Every field here comes from the server, which the verifier does not trust:
 * a value that does not decode becomes empty bytes, which open nothing and
 * match no key, so it fails the check it feeds rather than aborting the walk.
 */
function decode(value: string): Uint8Array {
  try {
    return fromBase64(value);
  } catch {
    return new Uint8Array(0);
  }
}

function groupByEpoch<T extends { epochNumber: number }>(items: readonly T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) {
    const group = groups.get(item.epochNumber);
    if (group === undefined) groups.set(item.epochNumber, [item]);
    else group.push(item);
  }
  return groups;
}

function commitmentOf(record: KeyChainEpoch, conversationId: string): EpochCommitment {
  return {
    conversationId,
    epochNumber: record.epochNumber,
    epochPublicKey: decode(record.epochPublicKey),
    confirmationHash: decode(record.confirmationHash),
  };
}

/**
 * An epoch number served more than once has no single published record, so a
 * wrap is trusted only when it verifies against every record served for it.
 */
function openAgainstEvery(
  principalPrivateKey: Uint8Array,
  wrap: KeyChainWrap,
  records: readonly KeyChainEpoch[],
  conversationId: string
): OpenedEpochKey {
  const bytes = decode(wrap.wrap);
  let opened: OpenedEpochKey = { ok: false, reason: 'unwrap-failed' };
  for (const record of records) {
    opened = openEpochWrap(principalPrivateKey, bytes, commitmentOf(record, conversationId));
    if (!opened.ok) return opened;
  }
  return opened;
}

function openDirect(
  principalPrivateKey: Uint8Array,
  wraps: readonly KeyChainWrap[],
  records: readonly KeyChainEpoch[],
  conversationId: string
): OpenedEpochKey | undefined {
  let firstFailure: OpenedEpochKey | undefined;
  for (const wrap of wraps) {
    const opened = openAgainstEvery(principalPrivateKey, wrap, records, conversationId);
    if (opened.ok) return opened;
    firstFailure ??= opened;
  }
  return firstFailure;
}

type LinkTarget =
  | { readonly verdict: 'bad' | 'absent' }
  | { readonly verdict: 'follow'; readonly chainLink: string; readonly predecessor: KeyChainEpoch };

/**
 * The predecessor record a link may be followed into: exactly one record,
 * strictly below the carrier. Anything else is a malformed chain, and the
 * strict descent is what makes every walk over predecessors terminate — which
 * is why the test is `<`: a number that does not compare (NaN) is below
 * nothing, where a `>=` refusal would let it through.
 */
function linkTarget(
  carrier: readonly KeyChainEpoch[],
  recordsByEpoch: ReadonlyMap<number, KeyChainEpoch[]>
): LinkTarget {
  const [record, ...duplicates] = carrier;
  if (record === undefined || duplicates.length > 0) return { verdict: 'bad' };
  const previous = record.previousEpochNumber;
  const descends = previous === null || previous < record.epochNumber;
  if (!descends) return { verdict: 'bad' };
  if (record.chainLink === null) return { verdict: 'absent' };
  if (previous === null) return { verdict: 'bad' };
  const [predecessor, ...predecessorDuplicates] = recordsByEpoch.get(previous) ?? [];
  if (predecessor === undefined || predecessorDuplicates.length > 0) return { verdict: 'bad' };
  return { verdict: 'follow', chainLink: record.chainLink, predecessor };
}

function judgeKey(
  direct: OpenedEpochKey | undefined,
  linkedKey: Uint8Array | undefined
): { verdict: EpochKeyVerdict; key: Uint8Array | undefined } {
  if (direct?.ok === true) return { verdict: { status: 'ok' }, key: direct.key };
  if (linkedKey !== undefined) return { verdict: { status: 'ok' }, key: linkedKey };
  if (direct === undefined) return { verdict: { status: 'unreachable' }, key: undefined };
  return { verdict: { status: 'bad', reason: direct.reason }, key: undefined };
}

interface ChainWalk {
  readonly conversationId: string;
  /** Keys yielded by verified links, awaiting their own epoch's turn. */
  readonly linkedKeys: Map<number, Uint8Array>;
  /** Carrier → predecessor, for every link that is structurally followable. */
  readonly predecessorOf: Map<number, number>;
}

function judgeLink(
  walk: ChainWalk,
  epochNumber: number,
  key: Uint8Array | undefined,
  target: LinkTarget
): ChainLinkVerdict {
  if (target.verdict !== 'follow') return target.verdict;
  walk.predecessorOf.set(epochNumber, target.predecessor.epochNumber);
  if (key === undefined) return 'unopened';
  const opened = openChainLink(key, decode(target.chainLink), {
    conversationId: walk.conversationId,
    newerEpochNumber: epochNumber,
    older: commitmentOf(target.predecessor, walk.conversationId),
  });
  if (!opened.ok) return 'bad';
  walk.linkedKeys.set(target.predecessor.epochNumber, opened.key);
  return 'ok';
}

/**
 * Classifies every epoch the principal was served, from the newest down, so a
 * key reached through a link is known before its epoch is judged. Checks each
 * direct wrap against the epoch's published public key (in constant time) and
 * confirmation, and opens every chain link whose carrier key verified —
 * including one whose predecessor is already held directly, so a bad link is
 * seen by every honest member at once. Whatever the server serves, it returns
 * a verdict; only a defective principal key makes it throw.
 */
export function verifyKeyChain(
  keyChain: KeyChainResponse,
  principalPrivateKey: Uint8Array,
  conversationId: string
): KeyChainVerdict {
  const recordsByEpoch = groupByEpoch(keyChain.epochs);
  const wrapsByEpoch = groupByEpoch(keyChain.wraps);
  const walk: ChainWalk = { conversationId, linkedKeys: new Map(), predecessorOf: new Map() };
  const epochs = new Map<number, EpochVerdict>();
  const keys = new Map<number, Uint8Array>();

  const newestFirst = [...recordsByEpoch.entries()].toSorted(([a], [b]) => b - a);
  for (const [epochNumber, records] of newestFirst) {
    const direct = openDirect(
      principalPrivateKey,
      wrapsByEpoch.get(epochNumber) ?? [],
      records,
      conversationId
    );
    const { verdict, key } = judgeKey(direct, walk.linkedKeys.get(epochNumber));
    if (key !== undefined) keys.set(epochNumber, key);
    const link = judgeLink(walk, epochNumber, key, linkTarget(records, recordsByEpoch));
    epochs.set(epochNumber, { key: verdict, link });
  }

  return {
    epochs,
    rotation: rotationVerdict(keyChain.currentEpoch, epochs, walk.predecessorOf),
    lastGoodEpoch: lastGoodEpoch(epochs, walk.predecessorOf),
    keys,
  };
}

function rotationVerdict(
  currentEpoch: number,
  epochs: ReadonlyMap<number, EpochVerdict>,
  predecessorOf: ReadonlyMap<number, number>
): 'ok' | 'bad' {
  if (epochs.get(currentEpoch)?.key.status === 'bad') return 'bad';
  let epochNumber: number | undefined = currentEpoch;
  while (epochNumber !== undefined) {
    if (epochs.get(epochNumber)?.link === 'bad') return 'bad';
    epochNumber = predecessorOf.get(epochNumber);
  }
  return 'ok';
}

function lastGoodEpoch(
  epochs: ReadonlyMap<number, EpochVerdict>,
  predecessorOf: ReadonlyMap<number, number>
): number | null {
  const good = new Map<number, boolean>();
  let highest: number | null = null;
  const oldestFirst = [...epochs.entries()].toSorted(([a], [b]) => a - b);
  for (const [epochNumber, verdict] of oldestFirst) {
    const predecessor = predecessorOf.get(epochNumber);
    const isGood =
      verdict.key.status === 'ok' &&
      (verdict.link === 'absent' ||
        (verdict.link === 'ok' && predecessor !== undefined && good.get(predecessor) === true));
    good.set(epochNumber, isGood);
    if (isGood) highest = epochNumber;
  }
  return highest;
}
