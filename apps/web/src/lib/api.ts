import { frontendEnvSchema } from '@hushbox/shared';

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
}

export interface MessageMediaItem {
  id: string;
  contentType: 'image' | 'audio' | 'video';
  position: number;
  mimeType: string;
  sizeBytes: number;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

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
