import { describe, it, expect } from 'vitest';
import { randomBytes } from '@noble/hashes/utils.js';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import { encryptContentEnvelope, decryptContentEnvelope } from './envelope.js';
import { asContentKey, generateContentKey, generateEpochKeyPair } from '../primitives/keys.js';
import { wrapSecretTo } from './wrap.js';
import { MAX_DECOMPRESSED_MESSAGE_BYTES } from '../primitives/compression.js';
import {
  DecryptionFailedError,
  InvalidKeyError,
  InvalidParameterError,
  MalformedBlobError,
  UnknownBlobVersionError,
} from '../errors.js';
import { BLOB_FORMAT_VERSION, NONCE_BYTES, TAG_BYTES } from '../primitives/format.js';
import { WRAP_LABELS } from './labels.js';
import type { ContentLocation, EnvelopeContent } from './envelope.js';
import type { WrappedSecret } from './wrap.js';

const LOCATION_A: ContentLocation = {
  conversationId: 'conv-1111',
  messageId: 'msg-2222',
  contentItemId: 'item-3333',
  position: 0,
  epochNumber: 5,
  senderId: 'user-4444',
};

function wrapKey(contentKey: Uint8Array): WrappedSecret {
  const epoch = generateEpochKeyPair();
  return wrapSecretTo(epoch.publicKey, contentKey, WRAP_LABELS.contentKeyEpoch);
}

/** These cases are about location binding and blob framing, never the codec. */
function raw(plaintext: Uint8Array): EnvelopeContent {
  return { plaintext, compression: 'raw' };
}

describe('envelope', () => {
  const plaintext = new TextEncoder().encode('the content payload');

  describe('encryptContentEnvelope', () => {
    it('produces a versioned blob', () => {
      const key = generateContentKey();

      const blob = encryptContentEnvelope(key, wrapKey(key), LOCATION_A, raw(plaintext));

      expect(blob.at(0)).toBe(BLOB_FORMAT_VERSION);
    });

    it('uses a fresh nonce per call', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const first = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));
      const second = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));

      expect(first).not.toEqual(second);
    });

    it('rejects a negative position', () => {
      const key = generateContentKey();
      const location = { ...LOCATION_A, position: -1 };

      expect(() => encryptContentEnvelope(key, wrapKey(key), location, raw(plaintext))).toThrow(
        InvalidParameterError
      );
    });

    it('rejects a non-integer epoch number', () => {
      const key = generateContentKey();
      const location = { ...LOCATION_A, epochNumber: 1.5 };

      expect(() => encryptContentEnvelope(key, wrapKey(key), location, raw(plaintext))).toThrow(
        InvalidParameterError
      );
    });

    it('refuses an all-zero content key with a typed error', () => {
      const key = generateContentKey();

      expect(() =>
        encryptContentEnvelope(
          asContentKey(new Uint8Array(32)),
          wrapKey(key),
          LOCATION_A,
          raw(plaintext)
        )
      ).toThrow(InvalidKeyError);
    });
  });

  describe('decryptContentEnvelope', () => {
    it('round-trips at the same location with the same wrapped key', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(decrypted).toEqual(plaintext);
    });

    it('round-trips empty plaintext', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(new Uint8Array(0)));
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(decrypted).toEqual(new Uint8Array(0));
    });

    it('round-trips a 5 MiB plaintext', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const mib = 1024 * 1024;
      const large = new Uint8Array(5 * mib);
      for (let index = 0; index < large.length; index++) {
        large[index] = (index * 31 + 7) & 0xff;
      }

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(large));
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(decrypted.length).toBe(5 * mib);
      // Native byte comparison proves exact equality far faster than a
      // 5M-element deep-equal.
      expect(Buffer.compare(Buffer.from(decrypted), Buffer.from(large))).toBe(0);
    });

    it('round-trips unicode plaintext', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const text = '混合 unicode → emoji 🎉, combining é, RTL שלום, and ﷽';
      const encoded = new TextEncoder().encode(text);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(encoded));
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(new TextDecoder().decode(decrypted)).toBe(text);
    });

    it('round-trips with unicode location-tuple strings', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const location: ContentLocation = {
        ...LOCATION_A,
        conversationId: '会話-🗨️-1',
        messageId: 'сообщение-2',
        contentItemId: 'पद-3',
        senderId: 'ユーザー-🙂-4',
      };

      const blob = encryptContentEnvelope(key, wrapped, location, raw(plaintext));
      const decrypted = decryptContentEnvelope(key, wrapped, location, blob);

      expect(decrypted).toEqual(plaintext);
    });

    const spliceTargets: readonly [string, Partial<ContentLocation>][] = [
      ['conversationId', { conversationId: 'conv-9999' }],
      ['messageId', { messageId: 'msg-9999' }],
      ['contentItemId', { contentItemId: 'item-9999' }],
      ['position', { position: 1 }],
      ['epochNumber', { epochNumber: 6 }],
      ['senderId', { senderId: 'user-9999' }],
    ];

    it.each(spliceTargets)(
      'splice attack: relocating the blob to a different %s fails the AAD check',
      (_field, overrides) => {
        const key = generateContentKey();
        const wrapped = wrapKey(key);
        const locationB = { ...LOCATION_A, ...overrides };

        const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));

        expect(() => decryptContentEnvelope(key, wrapped, locationB, blob)).toThrow(
          DecryptionFailedError
        );
      }
    );

    it('fails when presented with a different wrapped content key', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const otherWrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));

      expect(() => decryptContentEnvelope(key, otherWrapped, LOCATION_A, blob)).toThrow(
        DecryptionFailedError
      );
    });

    it('fails with the wrong content key', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));

      expect(() => decryptContentEnvelope(generateContentKey(), wrapped, LOCATION_A, blob)).toThrow(
        DecryptionFailedError
      );
    });

    it('fails on a tampered ciphertext', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));
      const tampered = new Uint8Array(blob);
      const lastIndex = tampered.length - 1;
      tampered[lastIndex] = (tampered.at(lastIndex) ?? 0) ^ 0xff;

      expect(() => decryptContentEnvelope(key, wrapped, LOCATION_A, tampered)).toThrow(
        DecryptionFailedError
      );
    });

    it('rejects an unknown version byte with a typed error', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));
      const downgraded = new Uint8Array(blob);
      downgraded[0] = 0x03;

      expect(() => decryptContentEnvelope(key, wrapped, LOCATION_A, downgraded)).toThrow(
        UnknownBlobVersionError
      );
    });

    it('rejects a blob shorter than the minimum length', () => {
      const key = generateContentKey();
      const short = Uint8Array.of(BLOB_FORMAT_VERSION, 1, 2);

      expect(() => decryptContentEnvelope(key, wrapKey(key), LOCATION_A, short)).toThrow(
        MalformedBlobError
      );
    });

    it('refuses an all-zero content key with a typed error', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(plaintext));

      expect(() =>
        decryptContentEnvelope(asContentKey(new Uint8Array(32)), wrapped, LOCATION_A, blob)
      ).toThrow(InvalidKeyError);
    });

    it('reports the zeroed key ahead of a malformed blob, naming the caller-side defect', () => {
      const key = generateContentKey();
      const short = Uint8Array.of(BLOB_FORMAT_VERSION, 1, 2);

      expect(() =>
        decryptContentEnvelope(asContentKey(new Uint8Array(32)), wrapKey(key), LOCATION_A, short)
      ).toThrow(InvalidKeyError);
    });

    it('decrypts independently of the epoch key, given key and wrap', () => {
      // Location binding, not authorship: anyone holding the content key and
      // the exact wrap bytes can decrypt — the AAD pins where, not who.
      const key = generateContentKey();
      const epoch = generateEpochKeyPair();
      const wrapped = wrapSecretTo(epoch.publicKey, key, WRAP_LABELS.contentKeyEpoch);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, raw(randomBytes(64)));
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);

      expect(decrypted.length).toBe(64);
    });
  });

  describe('compression', () => {
    // A blob's fixed cost around the codec payload: version byte, nonce, tag.
    const OVERHEAD_BYTES = 1 + NONCE_BYTES + TAG_BYTES;
    const prose = new TextEncoder().encode(
      (
        'Nothing commits mid-run: one fenced settlement transaction writes the ' +
        'content, every charge, the double-entry ledger legs and the ' +
        'idempotency-key flip atomically, so a run killed at any earlier moment ' +
        'leaves an expiring hold and nothing else to clean up. '
      ).repeat(3)
    );

    it('stores prose materially smaller than the same prose stored raw', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const compressedBlob = encryptContentEnvelope(key, wrapped, LOCATION_A, {
        plaintext: prose,
        compression: 'auto',
      });
      const rawBlob = encryptContentEnvelope(key, wrapped, LOCATION_A, {
        plaintext: prose,
        compression: 'raw',
      });

      expect(prose.length).toBeGreaterThanOrEqual(602);
      expect(rawBlob.length).toBe(OVERHEAD_BYTES + 1 + prose.length);
      expect(compressedBlob.length).toBeLessThan(rawBlob.length * 0.75);
      expect(decryptContentEnvelope(key, wrapped, LOCATION_A, compressedBlob)).toEqual(prose);
    });

    it('stores an incompressible payload raw rather than expanding it', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const incompressible = randomBytes(2048);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, {
        plaintext: incompressible,
        compression: 'auto',
      });

      expect(blob.length).toBe(OVERHEAD_BYTES + 1 + incompressible.length);
      expect(decryptContentEnvelope(key, wrapped, LOCATION_A, blob)).toEqual(incompressible);
    });

    it('stores the codec flag inside the AEAD: flipping it fails authentication', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, {
        plaintext: prose,
        compression: 'auto',
      });
      // The blob is deflate-flagged only if the payload actually shrank; without
      // that the flipped byte below would be ordinary content, not the flag.
      expect(blob.length).toBeLessThan(OVERHEAD_BYTES + prose.length);
      const flagIndex = 1 + NONCE_BYTES;
      const flipped = new Uint8Array(blob);
      flipped[flagIndex] = (flipped.at(flagIndex) ?? 0) ^ 0x01;

      expect(() => decryptContentEnvelope(key, wrapped, LOCATION_A, flipped)).toThrow(
        DecryptionFailedError
      );
    });

    it('round-trips a payload past the decompression cap by storing it raw', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);
      const overCap = new Uint8Array(MAX_DECOMPRESSED_MESSAGE_BYTES + 1);
      overCap[overCap.length - 1] = 0x7f;

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, {
        plaintext: overCap,
        compression: 'auto',
      });

      // The writer never emits a blob its own reader would refuse: deflating
      // past the inflate cap would store content nobody could ever read back.
      expect(blob.length).toBe(OVERHEAD_BYTES + 1 + overCap.length);
      const decrypted = decryptContentEnvelope(key, wrapped, LOCATION_A, blob);
      expect(decrypted.length).toBe(overCap.length);
      expect(decrypted.at(-1)).toBe(0x7f);
    });

    it('leaves compressible bytes raw for a writer that declares the raw policy', () => {
      const key = generateContentKey();
      const wrapped = wrapKey(key);

      const blob = encryptContentEnvelope(key, wrapped, LOCATION_A, {
        plaintext: prose,
        compression: 'raw',
      });

      expect(blob.length).toBe(OVERHEAD_BYTES + 1 + prose.length);
      expect(decryptContentEnvelope(key, wrapped, LOCATION_A, blob)).toEqual(prose);
    });

    /**
     * Type test: the @ts-expect-error asserts the marked call DOES NOT compile.
     * If bare bytes ever became assignable to `EnvelopeContent` again, the
     * directive would be flagged unused and `pnpm typecheck` would fail — every
     * writer has to name its compression policy rather than inherit one.
     */
    it('rejects bare bytes that declare no compression policy (compile-time)', () => {
      const policylessKey = generateContentKey();
      const bareBytesAsEnvelopeContent = (): Uint8Array =>
        // @ts-expect-error — bare bytes are not an EnvelopeContent
        encryptContentEnvelope(policylessKey, wrapKey(policylessKey), LOCATION_A, prose);
      expectCompileTimeProof(bareBytesAsEnvelopeContent);
    });
  });
});
