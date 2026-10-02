import { describe, it, expect } from 'vitest';
import { encryptTextForEpoch, generateEpochKeyPair } from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { testUuidV7 } from '@hushbox/shared/test-time';
import { CONVERSATION_TITLE_MAX_LENGTH, clampConversationTitle } from './conversation-title';

/**
 * The API's encoded cap on a title ciphertext (`TITLE_MAX`, in the conversations
 * slice). A literal, not an import: apps/web cannot reach the API's domain
 * schemas, and a pin that followed the constant would move with a change to it
 * instead of catching one.
 */
const SERVER_TITLE_MAX_ENCODED = 1024;

/** UTF-8 spends at most this many bytes on one JS string unit. */
const MAX_UTF8_BYTES_PER_UNIT = 3;

const CONVERSATION_ID = testUuidV7(1);

const utf8 = new TextEncoder();

/**
 * A deterministic run of distinct three-byte characters (the U+4E00 block) —
 * the widest UTF-8 a `.length` clamp admits. Such a run still deflates, so it
 * is a realistic long title rather than the size ceiling; the ceiling is
 * bounded arithmetically below.
 */
function wideTitle(length: number): string {
  return Array.from({ length }, (_, index) =>
    String.fromCodePoint(0x4e_00 + ((index * 977) % 0x40_00))
  ).join('');
}

/** Incompressible at this size: deflate of it is larger, so the wrap stores raw. */
const INCOMPRESSIBLE = 'q7Zk2Pv9Xr4Bn1Ms6Tc8Wj3Hd5Ly0Gf';

function encryptedTitle(plaintext: string): Uint8Array {
  const { publicKey } = generateEpochKeyPair();
  return encryptTextForEpoch(publicKey, plaintext, {
    conversationId: CONVERSATION_ID,
    epochNumber: 1,
  });
}

function encodedLength(plaintext: string): number {
  return toBase64(encryptedTitle(plaintext)).length;
}

/** The wrap's fixed cost, measured rather than assumed, off a payload it stores raw. */
const wrapOverheadBytes =
  encryptedTitle(INCOMPRESSIBLE).length - utf8.encode(INCOMPRESSIBLE).length;

describe('conversation title clamp', () => {
  it('carries a fixed per-blob overhead the ceiling can be computed from', () => {
    expect(wrapOverheadBytes).toBe(74);
  });

  it('keeps the worst case a clamped title can reach under the API ciphertext cap', () => {
    // The wrap stores deflated bytes only when they are strictly smaller, so raw
    // UTF-8 is the ceiling: at most 3 bytes per clamped string unit, plus the wrap.
    const ceilingBytes =
      CONVERSATION_TITLE_MAX_LENGTH * MAX_UTF8_BYTES_PER_UNIT + wrapOverheadBytes;

    expect(toBase64(new Uint8Array(ceilingBytes)).length).toBeLessThanOrEqual(
      SERVER_TITLE_MAX_ENCODED
    );
  });

  it('brings an over-long paste under the cap by truncating it', () => {
    const pasted = wideTitle(CONVERSATION_TITLE_MAX_LENGTH * 3);

    expect(encodedLength(pasted)).toBeGreaterThan(SERVER_TITLE_MAX_ENCODED);
    expect(encodedLength(clampConversationTitle(pasted))).toBeLessThanOrEqual(
      SERVER_TITLE_MAX_ENCODED
    );
  });
});
