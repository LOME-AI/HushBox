import { z } from 'zod';
import { memberPrivilegeSchema } from '../../enums.js';

/**
 * Request schema for creating a conversation.
 * Client MUST provide the conversation ID (UUID) for idempotency.
 * Title is base64-encoded encrypted blob (client-side encryption).
 * Epoch fields establish the first epoch for the conversation.
 */
export const createConversationRequestSchema = z.object({
  id: z.uuid(), // REQUIRED: client-generated UUID for idempotency
  title: z.string().optional(), // base64-encoded encrypted title
  epochPublicKey: z.string().min(1), // base64-encoded epoch public key
  confirmationHash: z.string().min(1), // base64-encoded confirmation hash
  memberWrap: z.string().min(1), // base64-encoded ECIES-wrapped epoch key for owner
});

// Use z.input for request types to preserve optionality (z.infer gives output type with defaults applied)
export type CreateConversationRequest = z.input<typeof createConversationRequestSchema>;

/**
 * Request schema for updating a conversation (rename).
 * Title is base64-encoded encrypted blob.
 * titleEpochNumber identifies which epoch key was used for encryption.
 */
export const updateConversationRequestSchema = z.object({
  title: z.string().min(1), // base64-encoded encrypted title
  titleEpochNumber: z.number().int().min(1), // epoch number used for encryption
});

export type UpdateConversationRequest = z.infer<typeof updateConversationRequestSchema>;

/**
 * Schema for epoch rotation data piggybacked on a chat request.
 * When a pending member removal exists, the client must rotate the epoch
 * before sending a new message. All fields are base64-encoded where noted.
 */
export const rotationSchema = z.object({
  expectedEpoch: z.number().int().min(1),
  epochPublicKey: z.string().min(1), // base64
  confirmationHash: z.string().min(1), // base64
  chainLink: z.string().min(1), // base64
  memberWraps: z
    .array(
      z.object({
        memberPublicKey: z.string().min(1), // base64
        wrap: z.string().min(1), // base64
      })
    )
    .min(1),
  encryptedTitle: z.string().min(1), // base64
});

export type StreamChatRotation = z.infer<typeof rotationSchema>;

/**
 * Request schema for POST /chat/stream.
 * Single atomic endpoint: validate, stream, persist user msg + ECIES assistant msg + billing.
 * User message is plaintext — server encrypts with epoch key.
 * Optional rotation field for piggybacked epoch rotation.
 */
/** Valid funding source values for billing claim validation. */
const fundingSourceSchema = z.enum([
  'owner_balance',
  'personal_balance',
  'free_allowance',
  'guest_fixed',
]);

export const streamChatRequestSchema = z.object({
  conversationId: z.uuid(),
  model: z.string(),
  userMessage: z.object({
    id: z.uuid(),
    content: z.string().min(1), // plaintext — server encrypts with epoch key
  }),
  messagesForInference: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      })
    )
    .min(1),
  fundingSource: fundingSourceSchema, // client's billing claim — compared with backend's resolveBilling()
});

export type StreamChatRequest = z.infer<typeof streamChatRequestSchema>;

/**
 * Request schema for POST /chat/message.
 * Saves a user-only message without triggering AI. Free — no billing.
 * Used in group chats when the AI toggle is off.
 */
export const userOnlyMessageSchema = z.object({
  conversationId: z.uuid(),
  messageId: z.uuid(),
  content: z.string().min(1),
});

export type UserOnlyMessageRequest = z.infer<typeof userOnlyMessageSchema>;

// ============================================================
// Response Schemas - Single Source of Truth for API responses
// ============================================================

/**
 * Schema for a conversation entity in API responses.
 * Title is base64-encoded encrypted bytea.
 * Includes epoch management fields.
 */
export const conversationResponseSchema = z.object({
  id: z.string(),
  userId: z.string(),
  title: z.string(), // base64-encoded encrypted title
  currentEpoch: z.number().int().min(1),
  titleEpochNumber: z.number().int().min(1),
  nextSequence: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

/**
 * Schema for a conversation list item in GET /conversations responses.
 * Extends base conversation with membership acceptance state.
 */
export const conversationListItemSchema = conversationResponseSchema.extend({
  accepted: z.boolean(),
  invitedByUsername: z.string().nullable(),
  privilege: memberPrivilegeSchema,
});

export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

/**
 * Schema for a message entity in API responses.
 * Uses epoch-based ECIES encryption model.
 * encryptedBlob is base64-encoded ECIES blob.
 */
export const messageResponseSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  encryptedBlob: z.string(), // base64-encoded ECIES blob
  senderType: z.enum(['user', 'ai']),
  senderId: z.string().nullable(),
  senderDisplayName: z.string().nullable(),
  payerId: z.string().nullable(),
  cost: z.string().nullable(),
  epochNumber: z.number().int().min(1),
  sequenceNumber: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * Response schema for GET /conversations
 */
export const listConversationsResponseSchema = z.object({
  conversations: z.array(conversationListItemSchema),
});

export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;

/**
 * Response schema for GET /conversations/:id
 * Includes acceptance state for the requesting user's membership.
 */
export const getConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  messages: z.array(messageResponseSchema),
  accepted: z.boolean(),
  invitedByUsername: z.string().nullable(),
});

export type GetConversationResponse = z.infer<typeof getConversationResponseSchema>;

/**
 * Response schema for POST /conversations
 * Returns either:
 * - 201 Created: new conversation (isNew: true)
 * - 200 OK: existing conversation with all messages (isNew: false, idempotent)
 */
export const createConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  messages: z.array(messageResponseSchema).optional(),
  isNew: z.boolean(), // true = 201 Created, false = 200 OK (idempotent return)
  accepted: z.boolean(),
  invitedByUsername: z.string().nullable(),
});

export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>;

/**
 * Response schema for PATCH /conversations/:id
 */
export const updateConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  accepted: z.boolean(),
  invitedByUsername: z.string().nullable(),
});

export type UpdateConversationResponse = z.infer<typeof updateConversationResponseSchema>;

/**
 * Response schema for DELETE /conversations/:id
 */
export const deleteConversationResponseSchema = z.object({
  deleted: z.boolean(),
});

export type DeleteConversationResponse = z.infer<typeof deleteConversationResponseSchema>;
