import { z } from 'zod';

/**
 * Request schema for creating a conversation.
 * Client MUST provide the conversation ID (UUID) for idempotency.
 * Optionally includes a first message to create atomically.
 */
export const createConversationRequestSchema = z.object({
  id: z.uuid(), // REQUIRED: client-generated UUID for idempotency
  title: z.string().optional(),
  firstMessage: z
    .object({
      content: z.string().min(1),
    })
    .optional(),
});

// Use z.input for request types to preserve optionality (z.infer gives output type with defaults applied)
export type CreateConversationRequest = z.input<typeof createConversationRequestSchema>;

/**
 * Request schema for updating a conversation (rename).
 */
export const updateConversationRequestSchema = z.object({
  title: z.string().min(1).max(255),
});

export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>;

/**
 * Request schema for creating a message.
 */
export const createMessageRequestSchema = z.object({
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().min(1),
  model: z.string().optional(),
});

export type CreateMessageRequest = z.infer<typeof createMessageRequestSchema>;

// ============================================================
// Response Schemas - Single Source of Truth for API responses
// ============================================================

/**
 * Schema for a conversation entity in API responses.
 */
export const conversationResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

/**
 * Schema for a message entity in API responses.
 */
export const messageResponseSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string(),
  model: z.string().nullable().optional(),
  /** Cost of this message in USD (null for user/system messages) */
  cost: z.string().nullable().optional(),
  createdAt: z.string(),
});

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * Response schema for GET /conversations
 */
export const listConversationsResponseSchema = z.object({
  conversations: z.array(conversationResponseSchema),
});

export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;

/**
 * Response schema for GET /conversations/:id
 */
export const getConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  messages: z.array(messageResponseSchema),
});

export type GetConversationResponse = z.infer<typeof getConversationResponseSchema>;

/**
 * Response schema for POST /conversations
 * Returns either:
 * - 201 Created: new conversation with optional first message (isNew: true)
 * - 200 OK: existing conversation with all messages (isNew: false, idempotent)
 */
export const createConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  message: messageResponseSchema.optional(), // First message when newly created
  messages: z.array(messageResponseSchema).optional(), // All messages when returning existing
  isNew: z.boolean(), // true = 201 Created, false = 200 OK (idempotent return)
});

export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>;

/**
 * Response schema for PATCH /conversations/:id
 */
export const updateConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
});

export type UpdateConversationResponse = z.infer<typeof updateConversationResponseSchema>;

/**
 * Response schema for DELETE /conversations/:id
 */
export const deleteConversationResponseSchema = z.object({
  deleted: z.boolean(),
});

export type DeleteConversationResponse = z.infer<typeof deleteConversationResponseSchema>;

/**
 * Response schema for POST /conversations/:id/messages
 */
export const createMessageResponseSchema = z.object({
  message: messageResponseSchema,
});

export type CreateMessageResponse = z.infer<typeof createMessageResponseSchema>;
