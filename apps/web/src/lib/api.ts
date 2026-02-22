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
} from '@hushbox/shared';
