/**
 * How long a conversation title may be, in JS string units, before the client
 * truncates it.
 *
 * Derived from the API's encoded cap on title ciphertext (`TITLE_MAX`), not
 * chosen: 1,024 unpadded base64 characters admit 768 blob bytes, the wrap
 * carries 74 bytes of fixed overhead (codec flag, format version, ephemeral
 * public key, nonce, AEAD tag), and one JS string unit costs at most 3 UTF-8
 * bytes — so 231 units always fit. 200 is the round number under that, leaving
 * room for the blob format to grow. `conversation-title.test.ts` measures the
 * chain rather than trusting this arithmetic.
 *
 * The cap is not this number and cannot be: it bounds encoded ciphertext, the
 * only thing a server holding no plaintext can see, and it stays the authority
 * that refuses. This clamp only keeps a paste from reaching it.
 */
export const CONVERSATION_TITLE_MAX_LENGTH = 200;

/** Truncates rather than rejects: a paste keeps its first words. */
export function clampConversationTitle(value: string): string {
  return value.slice(0, CONVERSATION_TITLE_MAX_LENGTH);
}
