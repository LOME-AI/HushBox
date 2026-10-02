import { describe, it, expect } from 'vitest';
import {
  asShareSecret,
  createShare,
  decryptContentEnvelope,
  encryptContentEnvelope,
  generateContentKey,
  generateEpochKeyPair,
  openShare,
  wrapContentKeyToEpoch,
  type ContentLocation,
  type SealedSecret,
} from '@hushbox/crypto';
import { toBase64, fromBase64 } from '@hushbox/shared';

// End-to-end proof that the sharer wiring (useMessageShare) and the viewer
// wiring (useSharedMessage) agree on the bytes the SERVER writes: the ciphertext
// here is built with `encryptContentEnvelope` under a real location tuple and
// epoch wrap, exactly as `persistEncryptedMessage` does, and the secret carried
// in the URL fragment opens exactly that. No mocks — the crypto is the contract
// under test.
const LOCATION: ContentLocation = {
  conversationId: '00000000-0000-7000-8000-00000000c0de',
  messageId: '00000000-0000-7000-8000-000000000001',
  contentItemId: '00000000-0000-7000-8000-000000000002',
  position: 0,
  epochNumber: 3,
  senderId: '00000000-0000-7000-8000-000000005e11',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function serverWrite(text: string): {
  contentKey: ReturnType<typeof generateContentKey>;
  wrappedContentKey: ReturnType<typeof wrapContentKeyToEpoch>;
  ciphertext: Uint8Array;
} {
  const epoch = generateEpochKeyPair();
  const contentKey = generateContentKey();
  const wrappedContentKey = wrapContentKeyToEpoch(epoch.publicKey, contentKey);
  return {
    contentKey,
    wrappedContentKey,
    ciphertext: encryptContentEnvelope(contentKey, wrappedContentKey, LOCATION, {
      plaintext: encoder.encode(text),
      compression: 'raw',
    }),
  };
}

describe('message-share round-trip', () => {
  it('recovers the sharer plaintext from the share URL secret and the wire-wrapped key', () => {
    const { contentKey, wrappedContentKey, ciphertext } = serverWrite('the secret answer');

    // Sharer side: re-wrap the content key under a fresh share secret, then
    // serialize both exactly as useMessageShare does (secret → URL fragment,
    // wrapped key → the POST body's `wrappedContentKey`).
    const { shareSecret, wrappedShareKey } = createShare(contentKey);
    const url = `https://app.example/share/m/share-1#${toBase64(shareSecret)}`;
    const wireWrappedContentKey = toBase64(wrappedShareKey);

    // Viewer side: recover the secret from the fragment and both wraps from the
    // wire, exactly as useSharedMessage does.
    const secretFromUrl = asShareSecret(fromBase64(new URL(url).hash.slice(1)));
    const wrapped = fromBase64(wireWrappedContentKey) as SealedSecret;
    const recoveredKey = openShare(secretFromUrl, wrapped);
    const plaintext = decoder.decode(
      decryptContentEnvelope(recoveredKey, wrappedContentKey, LOCATION, ciphertext)
    );

    expect(plaintext).toBe('the secret answer');
  });

  it('a wrong URL secret cannot open the wrapped content key', () => {
    const { contentKey } = serverWrite('unread');
    const { wrappedShareKey } = createShare(contentKey);
    const { shareSecret: wrongSecret } = createShare(generateContentKey());

    expect(() => openShare(wrongSecret, wrappedShareKey)).toThrow();
  });

  it('the right key cannot open a blob the server sealed at another location', () => {
    const { contentKey, wrappedContentKey, ciphertext } = serverWrite('bound to its place');
    const { shareSecret, wrappedShareKey } = createShare(contentKey);
    const recoveredKey = openShare(shareSecret, wrappedShareKey);

    expect(() =>
      decryptContentEnvelope(
        recoveredKey,
        wrappedContentKey,
        { ...LOCATION, position: LOCATION.position + 1 },
        ciphertext
      )
    ).toThrow();
  });
});
