import { z } from 'zod';
import { memberPrivilegeSchema } from '../../enums.js';
import { MAX_SELECTED_MODELS } from '../../constants.js';

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
  'trial_fixed',
]);

export const imageConfigSchema = z.object({
  aspectRatio: z.enum(['1:1', '3:2', '16:9', '9:16', '4:3']).default('1:1'),
});

export type ImageConfig = z.infer<typeof imageConfigSchema>;

export const streamChatRequestSchema = z.object({
  modality: z.enum(['text', 'image']).default('text'),
  models: z.array(z.string()).min(1).max(MAX_SELECTED_MODELS),
  userMessage: z.object({
    id: z.uuid(),
    content: z.string().min(1), // plaintext — server encrypts with epoch key
  }),
  /**
   * Full conversation history used as the model's prompt.
   * When `modality === 'image'`, this is ignored by the image pipeline —
   * only `userMessage.content` is used as the image prompt.
   */
  messagesForInference: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      })
    )
    .min(1),
  fundingSource: fundingSourceSchema, // client's billing claim — compared with backend's resolveBilling()
  webSearchEnabled: z.boolean().optional(),
  customInstructions: z.string().max(5000).optional(),
  forkId: z.uuid().optional(),
  imageConfig: imageConfigSchema.optional(),
});

export type StreamChatRequest = z.infer<typeof streamChatRequestSchema>;

/**
 * Request schema for POST /chat/message.
 * Saves a user-only message without triggering AI. Free — no billing.
 * Used in group chats when the AI toggle is off.
 */
export const userOnlyMessageSchema = z.object({
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
 *
 * `muted` and `pinned` are intentionally list-only — they are per-user display
 * preferences relevant when scanning conversations, not needed in the
 * single-conversation detail response (conversationResponseSchema).
 */
export const conversationListItemSchema = conversationResponseSchema.extend({
  accepted: z.boolean(),
  invitedByUsername: z.string().nullable(),
  privilege: memberPrivilegeSchema,
  muted: z.boolean().default(false),
  pinned: z.boolean().default(false),
});

export type ConversationListItem = z.infer<typeof conversationListItemSchema>;

/**
 * Schema for a single content item inside a message.
 * Text items carry `encryptedBlob` (base64) inline. Media items (image/audio/video)
 * carry `storageKey` + mime/size/dimensions and are fetched via presigned GET URLs.
 * Fields not applicable to a given `contentType` are null.
 */
export const contentItemResponseSchema = z.object({
  id: z.string(),
  contentType: z.enum(['text', 'image', 'audio', 'video']),
  position: z.number().int().nonnegative(),

  /** Base64-encoded symmetric ciphertext under the parent message's content key. Set for text items, null for media. */
  encryptedBlob: z.string().nullable(),

  /** R2 object key for media items. Null for text items. */
  storageKey: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),

  /** AI generation metadata. Null for user-authored content. */
  modelName: z.string().nullable(),
  cost: z.string().nullable(),
  isSmartModel: z.boolean(),
});

export type ContentItemResponse = z.infer<typeof contentItemResponseSchema>;

/**
 * Schema for a message entity in API responses.
 *
 * Under the wrap-once envelope model, each message has one `wrappedContentKey`
 * (ECIES-wrapped under the epoch public key) plus one or more `contentItems`
 * encrypted symmetrically under the unwrapped content key. Clients unwrap the
 * content key once and decrypt every content item with it.
 */
export const messageResponseSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  /** Base64-encoded ECIES-wrapped content key for this message. */
  wrappedContentKey: z.string(),
  senderType: z.enum(['user', 'ai']),
  senderId: z.string().nullable(),
  epochNumber: z.number().int().min(1),
  sequenceNumber: z.number().int().nonnegative(),
  parentMessageId: z.string().nullable(),
  createdAt: z.string(),
  /** Discrete content items belonging to this message, ordered by position. */
  contentItems: z.array(contentItemResponseSchema),
});

export type MessageResponse = z.infer<typeof messageResponseSchema>;

/**
 * Schema for a fork entity in API responses.
 */
export const forkResponseSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  name: z.string(),
  tipMessageId: z.string().nullable(),
  createdAt: z.string(),
});

export type ForkResponse = z.infer<typeof forkResponseSchema>;

/**
 * Response schema for GET /conversations
 */
export const listConversationsResponseSchema = z.object({
  conversations: z.array(conversationListItemSchema),
  nextCursor: z.string().nullable(),
});

export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;

/**
 * Response schema for GET /conversations/:id
 * Includes acceptance state for the requesting user's membership.
 */
export const getConversationResponseSchema = z.object({
  conversation: conversationResponseSchema,
  messages: z.array(messageResponseSchema),
  forks: z.array(forkResponseSchema).default([]),
  accepted: z.boolean(),
  invitedByUsername: z.string().nullable(),
  callerId: z.string(),
  privilege: memberPrivilegeSchema,
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
  forks: z.array(forkResponseSchema).default([]),
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

// ============================================================
// Fork Request Schemas
// ============================================================

/**
 * Request schema for creating a fork.
 * Client provides fork ID for idempotency.
 */
export const createForkRequestSchema = z.object({
  id: z.uuid(),
  fromMessageId: z.uuid(),
  name: z.string().min(1).max(50).optional(),
});

export type CreateForkRequest = z.infer<typeof createForkRequestSchema>;

/**
 * Request schema for renaming a fork.
 */
export const renameForkRequestSchema = z.object({
  name: z.string().min(1).max(50),
});

export type RenameForkRequest = z.infer<typeof renameForkRequestSchema>;

// ============================================================
// Regeneration Schemas
// ============================================================

/**
 * Request schema for POST /chat/regenerate.
 * Supports retry (resend same user message), edit (new user message), and regenerate (re-run AI).
 */
export const regenerateRequestSchema = z.object({
  targetMessageId: z.uuid(),
  action: z.enum(['retry', 'edit', 'regenerate']),
  model: z.string(),
  userMessage: z.object({
    id: z.uuid(),
    content: z.string().min(1),
  }),
  messagesForInference: z
    .array(
      z.object({
        role: z.enum(['user', 'assistant', 'system']),
        content: z.string(),
      })
    )
    .min(1),
  fundingSource: fundingSourceSchema,
  forkId: z.uuid().optional(),
  webSearchEnabled: z.boolean().optional(),
  customInstructions: z.string().max(5000).optional(),
});

export type RegenerateRequest = z.infer<typeof regenerateRequestSchema>;
