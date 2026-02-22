import { describe, it, expect } from 'vitest';
import { textEncoder, toStandardBase64 } from '@hushbox/shared';
import { verifyHmacSha256Webhook, signHmacSha256Webhook } from './webhook.js';

const TEST_SECRET = toStandardBase64(textEncoder.encode('test-webhook-secret'));

describe('signHmacSha256Webhook', () => {
  it('returns a versioned signature string', async () => {
    const signature = await signHmacSha256Webhook({
      secret: TEST_SECRET,
      payload: '{"event":"test"}',
      timestamp: '1234567890',
      webhookId: 'webhook-123',
    });

    expect(typeof signature).toBe('string');
    expect(signature).toMatch(/^v1,/);
  });

  it('produces deterministic output for same inputs', async () => {
    const params = {
      secret: TEST_SECRET,
      payload: '{"event":"test"}',
      timestamp: '1234567890',
      webhookId: 'webhook-123',
    };

    const sig1 = await signHmacSha256Webhook(params);
    const sig2 = await signHmacSha256Webhook(params);

    expect(sig1).toBe(sig2);
  });

  it('produces different output for different payloads', async () => {
    const sig1 = await signHmacSha256Webhook({
      secret: TEST_SECRET,
      payload: '{"event":"test1"}',
      timestamp: '1234567890',
      webhookId: 'webhook-123',
    });
    const sig2 = await signHmacSha256Webhook({
      secret: TEST_SECRET,
      payload: '{"event":"test2"}',
      timestamp: '1234567890',
      webhookId: 'webhook-123',
    });

    expect(sig1).not.toBe(sig2);
  });

  it('produces different output for different secrets', async () => {
    const secret2 = toStandardBase64(textEncoder.encode('different-secret'));

    const sig1 = await signHmacSha256Webhook({
      secret: TEST_SECRET,
      payload: '{"event":"test"}',
      timestamp: '1234567890',
      webhookId: 'webhook-123',
    });
    const sig2 = await signHmacSha256Webhook({
      secret: secret2,
      payload: '{"event":"test"}',
      timestamp: '1234567890',
      webhookId: 'webhook-123',
    });

    expect(sig1).not.toBe(sig2);
  });
});

describe('verifyHmacSha256Webhook', () => {
  it('returns true for a valid signature', async () => {
    const payload = '{"event":"test"}';
    const timestamp = '1234567890';
    const webhookId = 'webhook-123';

    const signature = await signHmacSha256Webhook({
      secret: TEST_SECRET,
      payload,
      timestamp,
      webhookId,
    });

    const result = await verifyHmacSha256Webhook({
      secret: TEST_SECRET,
      payload,
      signatureHeader: signature,
      timestamp,
      webhookId,
    });

    expect(result).toBe(true);
  });

  it('returns true for a plain (unversioned) signature', async () => {
    const payload = '{"event":"test"}';
    const timestamp = '1234567890';
    const webhookId = 'webhook-123';

    const versionedSig = await signHmacSha256Webhook({
      secret: TEST_SECRET,
      payload,
      timestamp,
      webhookId,
    });

    // Strip the "v1," prefix to get raw signature
    const rawSignature = versionedSig.replace(/^v1,/, '');

    const result = await verifyHmacSha256Webhook({
      secret: TEST_SECRET,
      payload,
      signatureHeader: rawSignature,
      timestamp,
      webhookId,
    });

    expect(result).toBe(true);
  });

  it('returns true when any version matches in multi-signature header', async () => {
    const payload = '{"event":"test"}';
    const timestamp = '1234567890';
    const webhookId = 'webhook-123';

    const versionedSig = await signHmacSha256Webhook({
      secret: TEST_SECRET,
      payload,
      timestamp,
      webhookId,
    });

    // "v0,invalid v1,valid"
    const multiSig = `v0,invalidSignature ${versionedSig}`;

    const result = await verifyHmacSha256Webhook({
      secret: TEST_SECRET,
      payload,
      signatureHeader: multiSig,
      timestamp,
      webhookId,
    });

    expect(result).toBe(true);
  });

  it('returns false for non-matching signature', async () => {
    const result = await verifyHmacSha256Webhook({
      secret: TEST_SECRET,
      payload: '{"event":"test"}',
      signatureHeader: toStandardBase64(new Uint8Array(Array.from({ length: 32 }, () => 65))),
      timestamp: '1234567890',
      webhookId: 'webhook-123',
    });

    expect(result).toBe(false);
  });

  it('returns false for invalid base64 signature', async () => {
    const result = await verifyHmacSha256Webhook({
      secret: TEST_SECRET,
      payload: 'payload',
      signatureHeader: '!!!invalid!!!',
      timestamp: 'timestamp',
      webhookId: 'webhookId',
    });

    expect(result).toBe(false);
  });

  it('returns false for invalid verifier', async () => {
    const result = await verifyHmacSha256Webhook({
      secret: '!!!invalid!!!',
      payload: 'payload',
      signatureHeader: toStandardBase64(textEncoder.encode('signature')),
      timestamp: 'timestamp',
      webhookId: 'webhookId',
    });

    expect(result).toBe(false);
  });
});
