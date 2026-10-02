import { useQuery } from '@tanstack/react-query';
import {
  asShareSecret,
  decryptContentEnvelope,
  openShare,
  type ContentKey,
  type SealedSecret,
  type WrappedSecret,
} from '@hushbox/crypto';
import {
  fromBase64,
  type ResolvedReasoningEffort,
  type SharedContentItemResponse,
} from '@hushbox/shared';
import { client, fetchJson } from '@/lib/api-client.js';

export const sharedMessageKeys = {
  all: ['shared-message'] as const,
  detail: (shareId: string | null) => [...sharedMessageKeys.all, shareId] as const,
};

const textDecoder = new TextDecoder();

/**
 * The message-level half of every item's envelope AAD, carried on the share
 * response. Combined with an item's own id and position it reconstructs the
 * `ContentLocation` the server bound at write.
 */
interface MessageEnvelopeInputs {
  /**
   * Held in React Query state for the page lifetime; the view is read-only and
   * ephemeral, the same risk profile as the epoch-key cache on the member side.
   */
  contentKey: ContentKey;
  wrappedContentKey: WrappedSecret;
  conversationId: string;
  messageId: string;
  epochNumber: number;
  senderId: string;
}

/**
 * One content item returned by `useSharedMessage`. Text items carry their
 * already-decrypted plaintext; media items carry a presigned GET URL plus
 * metadata. Media bytes decrypt separately under the same envelope inputs the
 * message carries, completed with the item's own `position`.
 */
export type SharedContentItem =
  | {
      type: 'text';
      position: number;
      content: string;
      /**
       * The reasoning facts the share read carries for this item, null where
       * the turn recorded no completion row. They reach a public visitor by
       * ruling, so that a shared message's reasoning row reads exactly as its
       * author's does; null is the absence of a value, distinct from `off`.
       */
      reasoningTokens: number | null;
      reasoningEffort: ResolvedReasoningEffort | null;
    }
  | {
      type: 'media';
      position: number;
      contentItemId: string;
      contentType: 'image' | 'audio' | 'video';
      mimeType: string;
      sizeBytes: number;
      width: number | null;
      height: number | null;
      durationMs: number | null;
      /** Short-lived presigned R2 GET URL. */
      downloadUrl: string;
      /** ISO-8601 expiry of `downloadUrl`. */
      expiresAt: string;
    };

/** What the share page renders: a live message, or one its sender's account deletion erased. */
export type SharedMessageData = LiveSharedMessage | DeletedSharedMessage;

interface LiveSharedMessage extends MessageEnvelopeInputs {
  deleted: false;
  createdAt: string;
  contentItems: SharedContentItem[];
}

/**
 * The sender deleted their account and the server erased the content. It
 * carries no envelope inputs: nothing is left to decrypt, so the share secret
 * is never used.
 */
interface DeletedSharedMessage {
  deleted: true;
  createdAt: string;
}

async function buildSharedContentItem(
  item: SharedContentItemResponse,
  envelope: MessageEnvelopeInputs,
  shareId: string
): Promise<SharedContentItem | null> {
  if (item.contentType === 'text') {
    if (item.encryptedBlob == null) return null;
    // The same primitive the member path uses: the AAD binds this item's full
    // location plus the epoch wrap, so the bytes only open where they were
    // written. A share re-wraps the key, never the content.
    const plaintext = decryptContentEnvelope(
      envelope.contentKey,
      envelope.wrappedContentKey,
      {
        conversationId: envelope.conversationId,
        messageId: envelope.messageId,
        contentItemId: item.id,
        position: item.position,
        epochNumber: envelope.epochNumber,
        senderId: envelope.senderId,
      },
      fromBase64(item.encryptedBlob)
    );
    return {
      type: 'text',
      position: item.position,
      content: textDecoder.decode(plaintext),
      reasoningTokens: item.reasoningTokens,
      reasoningEffort: item.reasoningEffort,
    };
  }
  // Media item — the standalone read carries no inline presigned URL, so mint
  // one per item against the share row: `GET /media/shared/:shareId/:contentItemId/download-url`
  // is unauthenticated by design (a valid shareId is the capability) and scoped
  // to exactly this share's content items server-side.
  const grant = await fetchJson(
    client.media.shared[':shareId'][':contentItemId']['download-url'].$get({
      param: { shareId, contentItemId: item.id },
    })
  );
  return {
    type: 'media',
    position: item.position,
    contentItemId: item.id,
    contentType: item.contentType,
    mimeType: item.mimeType ?? '',
    sizeBytes: item.byteLength ?? 0,
    width: item.width,
    height: item.height,
    durationMs: item.durationMs,
    downloadUrl: grant.downloadUrl,
    expiresAt: grant.expiresAt,
  };
}

/**
 * Loads a public standalone shared message under the wrap-once envelope model.
 *
 * 1. GET /conversations/shared/message/:shareId → the flat single message
 *    { shareId, messageId, wrappedContentKey, contentItems, createdAt } plus
 *    the envelope AAD inputs (conversationId, epochNumber, senderId, the epoch
 *    wrap).
 * 2. Extract shareSecret from the URL fragment (passed as `keyBase64`).
 * 3. openShare(shareSecret, wrappedContentKey) → contentKey (same key held by
 *    conversation members).
 * 4. Text items are decrypted inline with `decryptContentEnvelope`; media items
 *    presign a per-item download URL against the share row, returned with
 *    metadata so the renderer can fetch + decrypt the ciphertext under the same
 *    envelope inputs.
 * 5. Items are returned sorted by `position`.
 */
export function useSharedMessage(
  shareId: string | null,
  keyBase64: string | null
): ReturnType<typeof useQuery<SharedMessageData>> {
  return useQuery({
    queryKey: sharedMessageKeys.detail(shareId),
    queryFn: async (): Promise<SharedMessageData> => {
      /* v8 ignore next 3 -- `enabled: !!shareId && !!keyBase64` gates the queryFn, so both are always present here; this throw only narrows the type and is unreachable */
      if (!shareId || !keyBase64) {
        throw new Error('Missing share ID or key');
      }

      const view = await fetchJson(
        client.conversations.shared.message[':shareId'].$get({ param: { shareId } })
      );

      if (view.deleted) return { deleted: true, createdAt: view.createdAt };

      const shareSecret = asShareSecret(fromBase64(keyBase64));
      const wrappedShareKey = fromBase64(view.wrappedContentKey) as SealedSecret;
      const contentKey = openShare(shareSecret, wrappedShareKey);
      const envelope: MessageEnvelopeInputs = {
        contentKey,
        wrappedContentKey: fromBase64(view.epochWrappedContentKey) as WrappedSecret,
        conversationId: view.conversationId,
        messageId: view.messageId,
        epochNumber: view.epochNumber,
        // A scrubbed sender can never match the bound AAD, so such a message
        // fails to decrypt rather than rendering — same rule as the member read.
        senderId: view.senderId ?? '',
      };

      const sorted = view.contentItems.toSorted((a, b) => a.position - b.position);
      const items: SharedContentItem[] = [];
      for (const item of sorted) {
        const built = await buildSharedContentItem(item, envelope, shareId);
        if (built !== null) items.push(built);
      }

      return { ...envelope, deleted: false, createdAt: view.createdAt, contentItems: items };
    },
    enabled: !!shareId && !!keyBase64,
  });
}
