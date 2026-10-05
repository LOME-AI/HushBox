import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  unwrapContentKeyFromEpoch,
  decryptContentEnvelope,
  asEpochPrivateKey,
  type WrappedSecret,
} from '@hushbox/crypto';
import { fromBase64, nanoUSD, parseNanoUSD, serializeNanoUSD } from '@hushbox/shared';
import { useAuthStore } from '@/lib/auth/auth';
import {
  getEpochKey,
  processKeyChain,
  subscribe as subscribeEpochCache,
  getSnapshot as getEpochCacheSnapshot,
} from '@/lib/crypto/epoch-key-cache';
import { keyChainQueryOptions, keyKeys } from '@/hooks/crypto/keys';
import { decryptedCache, decryptedCacheKey } from '@/lib/crypto/decrypted-message-cache';
import { joinTextParts, pickModelName, replyDisplayFields } from '@/hooks/crypto/reply-merge';
import type { MessageResponse, HistoryContentItemResponse } from '@hushbox/shared';
import type { Message, MessageMediaItem } from '@/lib/api/api';

// Re-exported so existing consumers keep importing the cache clear from here.
// The cache itself lives in a leaf module so auth teardown can drop it without
// an import cycle (that module imports nothing that reaches back to auth).
export { clearDecryptedMessageCache } from '@/lib/crypto/decrypted-message-cache';

const textDecoder = new TextDecoder();

// Content substituted for a message whose ciphertext cannot be opened. Both
// markers are built from one prefix, and `isDecryptionFailure` is the only way
// to read them back, so a reader (the message list's decrypted count) cannot
// disagree with the writer about what an undecryptable message looks like.
const DECRYPTION_FAILURE_PREFIX = '[decryption failed';

/** Substituted when no epoch key is available to unwrap the content key. */
export const DECRYPTION_FAILED_MISSING_EPOCH_KEY = `${DECRYPTION_FAILURE_PREFIX}: missing epoch key]`;

/** Substituted when unwrapping or envelope decryption throws. */
export const DECRYPTION_FAILED = `${DECRYPTION_FAILURE_PREFIX}]`;

/** True iff `content` is one of the decryption-failure markers above. */
export function isDecryptionFailure(content: string): boolean {
  return content.startsWith(DECRYPTION_FAILURE_PREFIX);
}

/**
 * Collapses the wire's sender types to the display roles. No code path in the
 * product writes a system message, so the `system` arm exists because the
 * database enum and the history wire admit the value, not because one is
 * produced.
 */
function mapSenderTypeToRole(senderType: MessageResponse['senderType']): 'user' | 'assistant' {
  return senderType === 'user' ? 'user' : 'assistant';
}

/**
 * Sums per-item billed costs as NanoUSD `bigint` (never float — money stays a
 * canonical NanoUSD string end-to-end on the client). Returns null when no item
 * carries a cost, NOT the string "0": a cost-less message must leave the
 * message cost null so the `MessageItem` truthiness gate stays correct (no
 * spurious "$0.00" badge) and the throwing `formatNanoUsdCost` is never invoked.
 */
function sumCost(contentItems: HistoryContentItemResponse[]): string | null {
  let total = 0n;
  let seen = false;
  for (const item of contentItems) {
    if (item.cost != null) {
      total += parseNanoUSD(item.cost);
      seen = true;
    }
  }
  return seen ? serializeNanoUSD(nanoUSD(total)) : null;
}

/**
 * Sums one persisted per-item token count. Undefined when no item recorded one,
 * which keeps a count the read withheld apart from a recorded zero.
 */
function sumTokenCount(
  contentItems: HistoryContentItemResponse[],
  field: 'inputTokens' | 'outputTokens'
): number | undefined {
  let total: number | undefined;
  for (const item of contentItems) {
    const count = item[field];
    if (count !== null) total = (total ?? 0) + count;
  }
  return total;
}

function extractMediaItems(contentItems: HistoryContentItemResponse[]): MessageMediaItem[] {
  const media: MessageMediaItem[] = [];
  for (const item of contentItems) {
    if (item.contentType === 'text') continue;
    if (item.mimeType == null || item.byteLength == null) {
      // Reachable only at the type level: the wire schema declares both nullable,
      // while the content_items type-consistency CHECK forces both non-null for
      // every stored media row.
      continue;
    }
    media.push({
      id: item.id,
      contentType: item.contentType,
      position: item.position,
      mimeType: item.mimeType,
      sizeBytes: item.byteLength,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
    });
  }
  return media;
}

function buildDecryptedMessage(
  msg: MessageResponse,
  content: string,
  conversationId: string
): Message {
  const cost = sumCost(msg.contentItems);
  const modelName = pickModelName(msg.contentItems);
  const inputTokens = sumTokenCount(msg.contentItems, 'inputTokens');
  const outputTokens = sumTokenCount(msg.contentItems, 'outputTokens');
  return {
    id: msg.id,
    conversationId,
    role: mapSenderTypeToRole(msg.senderType),
    content,
    createdAt: msg.createdAt,
    ...(cost != null && { cost }),
    ...(msg.senderId != null && { senderId: msg.senderId }),
    modelName,
    parentMessageId: msg.parentMessageId,
    batchId: msg.batchId,
    wrappedContentKey: msg.wrappedContentKey,
    epochNumber: msg.epochNumber,
    ...replyDisplayFields(msg.contentItems, extractMediaItems(msg.contentItems)),
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/**
 * Decrypts MessageResponse[] into display Message[] under the wrap-once
 * envelope model.
 *
 * 1. Fetches key chain from /api/keys/:conversationId.
 * 2. Unwraps epoch keys using the account private key (cached via processKeyChain).
 * 3. Traverses chain links for older epochs.
 * 4. For each message, calls unwrapContentKeyFromEpoch once with the epoch
 *    private key to recover the message's content key.
 * 5. For each text content item on the message, calls decryptContentEnvelope
 *    with the same content key, the message's wrapped content key, and the
 *    item's full location tuple (which the server bound as AAD at persist).
 *    The UTF-8 plaintext bytes are decoded and joined into a single `content`
 *    string for the display Message shape.
 * 6. Maps senderType to role for display, sums per-item costs, and picks the
 *    first model name seen across content items.
 */
export function useDecryptedMessages(
  conversationId: string | null,
  messages: MessageResponse[] | undefined,
  privateKeyOverride?: Uint8Array | null
): Message[] {
  const accountPrivateKey = useAuthStore((s) => s.privateKey);
  const effectivePrivateKey = privateKeyOverride ?? accountPrivateKey;
  const queryClient = useQueryClient();
  const refetchedForEpochRef = useRef(0);

  // Reset refetch guard when conversation changes.
  useEffect(() => {
    refetchedForEpochRef.current = 0;
  }, [conversationId]);

  const { data: keyChain } = useQuery({
    ...keyChainQueryOptions(conversationId ?? ''),
    enabled: !!conversationId && !!effectivePrivateKey,
  });

  // Populate the epoch key cache outside of render. processKeyChain mutates
  // module-level state and notifies subscribers, so running it during render
  // (in a useMemo) double-fires under StrictMode/concurrent and is impure.
  // The epoch-cache snapshot below recomputes `decrypted` once keys land.
  useEffect(() => {
    if (!conversationId || !keyChain || !effectivePrivateKey) return;
    processKeyChain(conversationId, keyChain, effectivePrivateKey);
  }, [conversationId, keyChain, effectivePrivateKey]);

  const epochCacheVersion = useSyncExternalStore(subscribeEpochCache, getEpochCacheSnapshot);

  const decrypted = useMemo(() => {
    if (
      !conversationId ||
      !messages ||
      messages.length === 0 ||
      !effectivePrivateKey ||
      !keyChain
    ) {
      return [];
    }

    return messages.map((msg): Message => {
      // Checked ahead of the cache: this browser may still hold the message's
      // plaintext from before its sender's account deletion erased it.
      if (msg.deleted) {
        return { ...buildDecryptedMessage(msg, '', conversationId), deleted: true };
      }

      // Reuse cached plaintext for unchanged messages so realtime
      // invalidations don't re-decrypt the whole history. A message that
      // rotated to a new epoch is a cache miss (its content key is sealed
      // under a different epoch key now).
      const cacheKey = decryptedCacheKey(conversationId, msg.id);
      const cached = decryptedCache.get(cacheKey);
      if (cached?.epochNumber === msg.epochNumber) {
        return buildDecryptedMessage(msg, cached.content, conversationId);
      }

      const epochKey = getEpochKey(conversationId, msg.epochNumber);
      if (!epochKey) {
        return buildDecryptedMessage(msg, DECRYPTION_FAILED_MISSING_EPOCH_KEY, conversationId);
      }

      try {
        // The server binds each content item's full location tuple (and the
        // wrapped content key) as AAD, so the same wrap bytes reconstructed
        // here must feed both the unwrap and every envelope decrypt. A null
        // senderId (a scrubbed/deleted account) can never match the bound AAD,
        // so such a message intentionally falls through to `DECRYPTION_FAILED`.
        const wrappedContentKey = fromBase64(msg.wrappedContentKey) as WrappedSecret;
        const contentKey = unwrapContentKeyFromEpoch(
          asEpochPrivateKey(epochKey),
          wrappedContentKey
        );
        const senderId = msg.senderId ?? '';
        const parts: string[] = [];
        for (const item of msg.contentItems) {
          if (item.contentType === 'text' && item.encryptedBlob != null) {
            const plaintextBytes = decryptContentEnvelope(
              contentKey,
              wrappedContentKey,
              {
                conversationId,
                messageId: msg.id,
                contentItemId: item.id,
                position: item.position,
                epochNumber: msg.epochNumber,
                senderId,
              },
              fromBase64(item.encryptedBlob)
            );
            parts.push(textDecoder.decode(plaintextBytes));
          }
        }
        const content = joinTextParts(parts);
        decryptedCache.set(cacheKey, { epochNumber: msg.epochNumber, content });
        return buildDecryptedMessage(msg, content, conversationId);
      } catch {
        return buildDecryptedMessage(msg, DECRYPTION_FAILED, conversationId);
      }
    });
    // epochCacheVersion forces recompute when processKeyChain populates keys
    // from the effect above (the memo otherwise has no dependency on it).
  }, [conversationId, messages, effectivePrivateKey, keyChain, epochCacheVersion]);

  // Refetch key chain when messages reference epochs beyond the cached currentEpoch.
  // This handles the race where WebSocket rotation:complete hasn't arrived yet.
  useEffect(() => {
    if (!conversationId || !keyChain || !messages || messages.length === 0) return;

    const hasNewerEpoch = messages.some((msg) => msg.epochNumber > keyChain.currentEpoch);
    if (!hasNewerEpoch) return;

    // Prevent infinite loop: only refetch once per stale currentEpoch value.
    if (refetchedForEpochRef.current === keyChain.currentEpoch) return;
    refetchedForEpochRef.current = keyChain.currentEpoch;

    void queryClient.invalidateQueries({ queryKey: keyKeys.chain(conversationId) });
  }, [conversationId, keyChain, messages, queryClient]);

  return decrypted;
}
