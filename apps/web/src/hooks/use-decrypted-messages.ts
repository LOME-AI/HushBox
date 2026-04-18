import { useEffect, useMemo, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { openMessageEnvelope, decryptTextWithContentKey } from '@hushbox/crypto';
import { useAuthStore } from '@/lib/auth';
import type { Message, MessageMediaItem } from '@/lib/api';
import { fromBase64 } from '@hushbox/shared';
import type { MessageResponse, ContentItemResponse } from '@hushbox/shared';
import { getEpochKey, processKeyChain } from '@/lib/epoch-key-cache';
import { useDecryptionActivityStore } from '@/stores/decryption-activity';
import { keyChainQueryOptions } from '@/hooks/keys';

function mapSenderTypeToRole(senderType: 'user' | 'ai'): 'user' | 'assistant' {
  return senderType === 'ai' ? 'assistant' : 'user';
}

function sumCost(contentItems: ContentItemResponse[]): string | null {
  let total = 0;
  let seen = false;
  for (const item of contentItems) {
    if (item.cost != null) {
      total += Number.parseFloat(item.cost);
      seen = true;
    }
  }
  return seen ? total.toFixed(8) : null;
}

function pickModelName(contentItems: ContentItemResponse[]): string | null {
  for (const item of contentItems) {
    if (item.modelName != null) return item.modelName;
  }
  return null;
}

function extractMediaItems(contentItems: ContentItemResponse[]): MessageMediaItem[] {
  const media: MessageMediaItem[] = [];
  for (const item of contentItems) {
    if (item.contentType === 'text') continue;
    if (item.mimeType == null || item.sizeBytes == null) {
      // Server CHECK constraint should prevent this; log to catch regressions.
      console.warn(
        `Skipping malformed media content item ${item.id}: missing mimeType or sizeBytes`
      );
      continue;
    }
    media.push({
      id: item.id,
      contentType: item.contentType,
      position: item.position,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
      width: item.width,
      height: item.height,
      durationMs: item.durationMs,
    });
  }
  return media;
}

function buildDecryptedMessage(msg: MessageResponse, content: string): Message {
  const cost = sumCost(msg.contentItems);
  const modelName = pickModelName(msg.contentItems);
  const mediaItems = extractMediaItems(msg.contentItems);
  return {
    id: msg.id,
    conversationId: msg.conversationId,
    role: mapSenderTypeToRole(msg.senderType),
    content,
    createdAt: msg.createdAt,
    ...(cost != null && { cost }),
    ...(msg.senderId != null && { senderId: msg.senderId }),
    modelName,
    parentMessageId: msg.parentMessageId,
    wrappedContentKey: msg.wrappedContentKey,
    epochNumber: msg.epochNumber,
    ...(mediaItems.length > 0 && { mediaItems }),
  };
}

/**
 * Decrypts MessageResponse[] into display Message[] under the wrap-once
 * envelope model.
 *
 * 1. Fetches key chain from /api/keys/:conversationId.
 * 2. Unwraps epoch keys using the account private key (cached via processKeyChain).
 * 3. Traverses chain links for older epochs.
 * 4. For each message, calls openMessageEnvelope once with the epoch key to
 *    recover the message's content key.
 * 5. For each text content item on the message, calls decryptTextWithContentKey
 *    with the same content key. Results are joined into a single `content`
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

    // Populate epoch key cache from key chain.
    // Safe to call in useMemo because epoch-key-cache defers listener
    // notifications via queueMicrotask — no "setState during render" errors.
    processKeyChain(conversationId, keyChain, effectivePrivateKey);

    return messages.map((msg): Message => {
      const epochKey = getEpochKey(conversationId, msg.epochNumber);
      if (!epochKey) {
        return buildDecryptedMessage(msg, '[decryption failed: missing epoch key]');
      }

      try {
        const contentKey = openMessageEnvelope(epochKey, fromBase64(msg.wrappedContentKey));
        const parts: string[] = [];
        for (const item of msg.contentItems) {
          if (item.contentType === 'text' && item.encryptedBlob != null) {
            parts.push(decryptTextWithContentKey(contentKey, fromBase64(item.encryptedBlob)));
          }
        }
        return buildDecryptedMessage(msg, parts.join(''));
      } catch {
        return buildDecryptedMessage(msg, '[decryption failed]');
      }
    });
  }, [conversationId, messages, effectivePrivateKey, keyChain]);

  // Refetch key chain when messages reference epochs beyond the cached currentEpoch.
  // This handles the race where WebSocket rotation:complete hasn't arrived yet.
  useEffect(() => {
    if (!conversationId || !keyChain || !messages || messages.length === 0) return;

    const hasNewerEpoch = messages.some((msg) => msg.epochNumber > keyChain.currentEpoch);
    if (!hasNewerEpoch) return;

    // Prevent infinite loop: only refetch once per stale currentEpoch value.
    if (refetchedForEpochRef.current === keyChain.currentEpoch) return;
    refetchedForEpochRef.current = keyChain.currentEpoch;

    void queryClient.invalidateQueries({ queryKey: ['keys', conversationId] });
  }, [conversationId, keyChain, messages, queryClient]);

  const isPending =
    !!conversationId &&
    !!effectivePrivateKey &&
    (messages?.length ?? 0) > 0 &&
    decrypted.length === 0;

  const { markPending, markComplete } = useDecryptionActivityStore.getState();

  useEffect(() => {
    if (!isPending) return;
    markPending();
    return () => {
      markComplete();
    };
  }, [isPending, markPending, markComplete]);

  return decrypted;
}
