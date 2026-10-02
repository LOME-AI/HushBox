import { toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { resolveCallerPublicKey } from '../shares/caller.js';
import { assembleKeyChain, keyChainFloor } from '../forks/parent-chain.js';
import type { KeyChainResponse } from '@hushbox/shared';
import type { ConversationCaller } from '../shares/caller.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type {
  ConversationsStores,
  EpochChainRecord,
  EpochChainScope,
  EpochWrapRecord,
} from '../../ports/index.js';
import type { KeyChainAssembly } from '../forks/parent-chain.js';
import type { Outcome } from '../outcomes.js';

/**
 * The serialized key-chain response. Aliased to the shared wire contract
 * (`@hushbox/shared`) so this serializer and the client's `processKeyChain`
 * share one source of truth: a field rename in the shared schema is a compile
 * error here.
 */
type KeyChainView = KeyChainResponse;

/**
 * The member's decryption material: their ECIES wraps, and one record per
 * epoch at or above their visibility floor carrying the public key and
 * confirmation hash the client verifies against, with the chain link withheld
 * wherever it opens below the floor (`assembleKeyChain` owns that filter).
 * Answered only to an active member holding at least one wrap; every other
 * caller gets the indistinguishable not-found.
 */
export function getKeyChain(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<KeyChainView>, DomainError> {
  const { conversationId, caller } = params;
  return stores.conversations.get(conversationId).andThen((conversation) => {
    if (conversation === null) return okAsync<Outcome<KeyChainView>>({ refusal: 'not-found' });
    return resolveCallerPublicKey(stores, conversationId, caller).andThen((publicKey) => {
      if (publicKey === null) return okAsync<Outcome<KeyChainView>>({ refusal: 'not-found' });
      return memberKeyChain(stores, conversationId, conversation.currentEpoch, publicKey);
    });
  });
}

/** One conversation the caller may hold keys in, with the epoch to report. */
interface KeyChainScope {
  readonly conversationId: string;
  readonly currentEpoch: number;
}

const NO_EPOCHS: readonly EpochChainRecord[] = [];

/**
 * The read path both answers share: a fixed number of set-based statements,
 * independent of the scope count — every wrap the key holds across the scopes,
 * the epoch records above each conversation's own floor, then which of them is
 * rotation-pending.
 * Scopes the key holds no wrap in are absent from the result, which is what
 * the callers read as "no access".
 *
 * Set-based rather than a per-conversation loop because the Neon driver runs on
 * a single-connection pool: a loop over a hundred ids is a hundred serialized
 * round trips on the app's cold-start path.
 */
function keyChainViews(
  stores: ConversationsStores,
  scopes: readonly KeyChainScope[],
  memberPublicKey: Uint8Array
): ResultAsync<ReadonlyMap<string, KeyChainView>, DomainError> {
  const ids = scopes.map((scope) => scope.conversationId);
  return stores.epochs.wrapsForKey(ids, memberPublicKey).andThen((wraps) => {
    const held = new Map<string, EpochWrapRecord[]>();
    for (const wrap of wraps) {
      const forConversation = held.get(wrap.conversationId);
      if (forConversation === undefined) held.set(wrap.conversationId, [wrap]);
      else forConversation.push(wrap);
    }
    const chainScopes = scopes.flatMap((scope): EpochChainScope[] => {
      const floor = keyChainFloor(held.get(scope.conversationId) ?? []);
      return floor === null ? [] : [{ conversationId: scope.conversationId, fromEpoch: floor }];
    });
    return stores.epochs.epochChains(chainScopes).andThen((chains) =>
      stores.epochs
        .conversationsWithDepartedHolders(chainScopes.map((scope) => scope.conversationId))
        .map((pending) => {
          const views = new Map<string, KeyChainView>();
          for (const scope of scopes) {
            const assembled = assembleKeyChain(
              held.get(scope.conversationId) ?? [],
              chains.get(scope.conversationId) ?? NO_EPOCHS,
              scope.currentEpoch
            );
            if (assembled !== null) {
              views.set(
                scope.conversationId,
                serializeKeyChain(assembled, pending.has(scope.conversationId))
              );
            }
          }
          return views;
        })
    );
  });
}

function memberKeyChain(
  stores: ConversationsStores,
  conversationId: string,
  currentEpoch: number,
  memberPublicKey: Uint8Array
): ResultAsync<Outcome<KeyChainView>, DomainError> {
  return keyChainViews(stores, [{ conversationId, currentEpoch }], memberPublicKey).map(
    (views) => views.get(conversationId) ?? { refusal: 'not-found' }
  );
}

function serializeKeyChain(
  assembled: KeyChainAssembly<EpochWrapRecord, EpochChainRecord>,
  rotationPending: boolean
): KeyChainView {
  return {
    epochs: assembled.epochs.map((epoch) => ({
      epochNumber: epoch.epochNumber,
      epochPublicKey: toBase64(epoch.epochPublicKey),
      confirmationHash: toBase64(epoch.confirmationHash),
      previousEpochNumber: epoch.previousEpochNumber,
      chainLink: epoch.chainLink === null ? null : toBase64(epoch.chainLink),
    })),
    wraps: assembled.wraps.map((wrap) => ({
      epochNumber: wrap.epochNumber,
      wrap: toBase64(wrap.wrap),
    })),
    currentEpoch: assembled.currentEpoch,
    rotationPending,
  };
}

interface KeyChainBatchView {
  /** Per-conversation decryption material for accessible ids only. */
  readonly keys: Record<string, KeyChainView>;
  /** Ids the caller cannot access (non-member or no wraps) — never a 404. */
  readonly missing: string[];
}

/**
 * The caller's own keychain for many conversations at once — the list view's
 * post-membership-change refresh. Partial by design: an inaccessible id (the
 * caller is not an active member, or holds no wraps) is omitted from `keys`
 * and named in `missing`, so a single stale id never fails the whole batch.
 * The caller's public key is read once and reused across every conversation.
 */
export function getKeyChainBatch(
  stores: ConversationsStores,
  params: { readonly conversationIds: readonly string[]; readonly callerUserId: string }
): ResultAsync<KeyChainBatchView, DomainError> {
  const ids = [...new Set(params.conversationIds)];
  return stores.users.byId(params.callerUserId).andThen((user) => {
    if (user === null) {
      throw new Error('conversations: no users row for an authenticated principal');
    }
    return accessibleScopes(stores, ids, params.callerUserId).andThen((scopes) =>
      keyChainViews(stores, scopes, user.publicKey).map((views) => splitBatch(ids, views))
    );
  });
}

/**
 * The membership gate, set-based: the conversations that exist AND the caller
 * still holds an active membership in. Two statements whatever the id count.
 */
function accessibleScopes(
  stores: ConversationsStores,
  ids: readonly string[],
  callerUserId: string
): ResultAsync<KeyChainScope[], DomainError> {
  return stores.conversations.byIds(ids).andThen((conversations) =>
    stores.members.activeIdsForUser(ids, callerUserId).map((activeIds) => {
      const active = new Set(activeIds);
      return conversations
        .filter((conversation) => active.has(conversation.id))
        .map((conversation) => ({
          conversationId: conversation.id,
          currentEpoch: conversation.currentEpoch,
        }));
    })
  );
}

function splitBatch(
  ids: readonly string[],
  views: ReadonlyMap<string, KeyChainView>
): KeyChainBatchView {
  const keys: Record<string, KeyChainView> = {};
  const missing: string[] = [];
  for (const id of ids) {
    const view = views.get(id);
    if (view === undefined) missing.push(id);
    else keys[id] = view;
  }
  return { keys, missing };
}
