import { z } from 'zod';

/**
 * Content-type discriminator shared between server serialization and client
 * parsing. Enforced at the DB via a CHECK constraint on `content_items`;
 * re-parsed here so the server fails loud if a rogue row slips through.
 */
export const publicShareContentTypeSchema = z.enum(['text', 'image', 'audio', 'video']);

/**
 * A single content item in the public share response. Shape is deliberately
 * loose (every media/text field is nullable) because it matches what the
 * server can emit verbatim — text items populate `encryptedBlob` and null the
 * media fields, media items populate `mimeType` + `downloadUrl` + metadata
 * and null `encryptedBlob`. Consumers narrow via `contentType`.
 */
export const publicShareContentItemSchema = z.object({
  id: z.string(),
  contentType: publicShareContentTypeSchema,
  position: z.number().int().nonnegative(),
  encryptedBlob: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  /** Presigned GET URL; set only for media items. */
  downloadUrl: z.string().nullable(),
  /** ISO-8601 expiry of `downloadUrl`; set only for media items. */
  expiresAt: z.string().nullable(),
});

export const publicShareResponseSchema = z.object({
  shareId: z.string(),
  messageId: z.string(),
  /** Base64-encoded symmetric wrap of the message content key under HKDF(shareSecret). */
  wrappedShareKey: z.string(),
  contentItems: z.array(publicShareContentItemSchema),
  createdAt: z.string(),
});

export type PublicShareContentType = z.infer<typeof publicShareContentTypeSchema>;
export type PublicShareContentItem = z.infer<typeof publicShareContentItemSchema>;
export type PublicShareResponse = z.infer<typeof publicShareResponseSchema>;
