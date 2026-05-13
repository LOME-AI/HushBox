import { frontendEnvSchema, type ContentItemResponse } from '@hushbox/shared';

const env = frontendEnvSchema.parse({
  VITE_API_URL: import.meta.env['VITE_API_URL'] as unknown,
});

export function getApiUrl(): string {
  return env.VITE_API_URL;
}

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public data?: unknown
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Display-oriented message type used throughout the frontend UI.
 * Components render messages using role/content fields.
 * The API returns MessageResponse (encrypted blobs); useDecryptedMessages
 * bridges MessageResponse -> Message for display.
 */
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  cost?: string;
  senderId?: string;
  modelName?: string | null;
  parentMessageId?: string | null;
  errorCode?: string;
  /**
   * True when this assistant message was produced via a Smart Model (or
   * future routing) stage. Drives the "Smart" chip on the nametag.
   */
  isSmartModel?: boolean;
  /**
   * Stage id currently classifying for this slot — drives the in-flight
   * "Choosing the best model…" placeholder. Cleared (set to `undefined`) on
   * `stage:done` / `stage:error`. Only set during streaming on optimistic
   * messages.
   */
  classifyingStageId?: 'smart-model' | undefined;
  /**
   * Resolved model name from a Smart Model (or future) stage — replaces the
   * streaming nametag once the classifier resolves. Set during streaming on
   * optimistic messages; persisted messages derive the same display from
   * `modelName` via the `useModels` lookup.
   */
  resolvedModelName?: string | undefined;
  /**
   * Wrap-once envelope metadata forwarded from the API response. Required by
   * `useMessageShare` to re-wrap the content key under a `shareSecret`.
   * Base64-encoded ECIES blob — safe to keep on the display object.
   */
  wrappedContentKey?: string;
  epochNumber?: number;
  /**
   * Media content items attached to this message (image/audio/video). Bytes
   * are not fetched here — the `MediaContentItem` component lazily fetches
   * and decrypts on mount using the message's wrappedContentKey.
   */
  mediaItems?: MessageMediaItem[];
  /**
   * Live "media generation in flight" hint sourced from `model:media:start`.
   * Drives the placeholder swap from generic "Loading…" to a media-specific
   * label ("Generating image…" / "Generating video…" / "Generating audio…").
   * The first emit carries a placeholder mimeType (e.g. `application/octet-stream`);
   * the second emit carries the real mime so the UI can prepare the right
   * `<img>`/`<video>`/`<audio>` element type once decoded.
   */
  mediaInFlight?: {
    mediaType: 'image' | 'audio' | 'video';
    mimeType: string;
  };
  /**
   * 0-100 progress for long-running media generations (today: video). Sourced
   * from `model:media:progress`; `model:done` is the authoritative 100%.
   */
  mediaProgress?: { percent: number };
}

/**
 * Display-shape for media content items attached to a message.
 *
 * Derived from the shared `contentItemResponseSchema` so the wire/display
 * shapes never drift. We narrow `contentType` to non-text media, mark the
 * media-only fields as required (the shared schema makes them nullable for
 * text items, but the UI never receives those here), and add `downloadUrl`
 * which is forwarded from the SSE `done` event for just-generated media.
 */
export type MessageMediaItem = Pick<ContentItemResponse, 'id' | 'position'> & {
  contentType: 'image' | 'audio' | 'video';
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  /**
   * Pre-fetched presigned GET URL forwarded from the SSE `done` event for
   * media items generated in the current session. Lets the consumer skip
   * `useMediaDownloadUrl()` for the common case (just-generated media), saving
   * a network round-trip immediately after the assistant message lands.
   * Re-fetched messages from the API don't carry this — the URL is only valid
   * for `MEDIA_DOWNLOAD_URL_TTL_SECONDS`.
   */
  downloadUrl?: string;
};

export {
  type ConversationResponse as Conversation,
  type ConversationListItem,
  type ListConversationsResponse as ConversationsResponse,
  type MessageResponse,
  type CreateConversationRequest,
  type GetConversationResponse as ConversationResponse,
  type UpdateConversationRequest,
  type CreateConversationResponse,
  type DeleteConversationResponse,
  type UpdateConversationResponse,
  type ForkResponse,
} from '@hushbox/shared';
