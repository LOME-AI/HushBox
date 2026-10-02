import { encryptTextForEpoch, generateKeyPair } from '@hushbox/crypto/content';

/** The bytes a demo message is stored as, in hex, with their count. */
export interface DemoSample {
  hex: string;
  byteLength: number;
}

export const DEMO_SAMPLE_TEXT = 'This is private.';

// The demo stores the text the way a conversation title is stored: the same
// wrap, under a throwaway key whose private half is never kept.
const DEMO_LOCATION = { conversationId: 'demo', epochNumber: 1 };

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function encryptDemoSampleTo(publicKey: Uint8Array, text: string): DemoSample {
  const blob = encryptTextForEpoch(publicKey, text, DEMO_LOCATION);
  return { hex: toHex(blob), byteLength: blob.length };
}

/** `text` stored under a fresh demo key, as the page renders it before anyone types. */
export function encryptDemoSample(text: string): DemoSample {
  return encryptDemoSampleTo(generateKeyPair().publicKey, text);
}
