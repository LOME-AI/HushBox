/* eslint-disable @typescript-eslint/no-unsafe-assignment */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateWebhookSignature, scheduleMockWebhook } from './mock-webhook.js';
import { verifyWebhookSignatureAsync } from './helcim.js';

describe('mock-webhook', () => {
  describe('generateWebhookSignature', () => {
    it('generates a signature that verifyWebhookSignatureAsync accepts', async () => {
      const webhookVerifier = 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=';
      const payload = JSON.stringify({ type: 'cardTransaction', id: 'test-123' });
      const timestamp = '1234567890';
      const webhookId = 'webhook-abc';

      const signature = await generateWebhookSignature(
        webhookVerifier,
        payload,
        timestamp,
        webhookId
      );

      // Signature should be in versioned format "v1,base64signature"
      expect(signature).toMatch(/^v1,.+$/);

      // Signature should be verifiable
      const isValid = await verifyWebhookSignatureAsync(
        webhookVerifier,
        payload,
        signature,
        timestamp,
        webhookId
      );
      expect(isValid).toBe(true);
    });

    it('produces different signatures for different payloads', async () => {
      const webhookVerifier = 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=';
      const timestamp = '1234567890';
      const webhookId = 'webhook-abc';

      const sig1 = await generateWebhookSignature(
        webhookVerifier,
        '{"id": "1"}',
        timestamp,
        webhookId
      );
      const sig2 = await generateWebhookSignature(
        webhookVerifier,
        '{"id": "2"}',
        timestamp,
        webhookId
      );

      expect(sig1).not.toBe(sig2);
    });
  });

  describe('scheduleMockWebhook', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.clearAllMocks();
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ received: true }),
      });
    });

    afterEach(() => {
      vi.clearAllTimers();
      vi.useRealTimers();
      vi.clearAllMocks();
    });

    it('sends webhook after specified delay', async () => {
      const webhookUrl = 'http://localhost:8787/webhooks/payment';
      const webhookVerifier = 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=';
      const transactionId = 'txn-123';

      scheduleMockWebhook({
        webhookUrl,
        webhookVerifier,
        transactionId,
        delayMs: 1000,
      });

      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1);
      });

      expect(fetch).toHaveBeenCalledWith(
        webhookUrl,
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'webhook-signature': expect.stringMatching(/^v1,.+$/),
            'webhook-timestamp': expect.any(String),
            'webhook-id': expect.stringMatching(/^mock-webhook-/),
          }),
          body: expect.stringContaining(transactionId),
        })
      );
    });

    it('uses default delay of 1000ms', async () => {
      scheduleMockWebhook({
        webhookUrl: 'http://localhost:8787/webhooks/payment',
        webhookVerifier: 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=',
        transactionId: 'txn-456',
      });

      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(999);
      expect(fetch).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1);
      });
    });

    it('sends correct webhook payload format', async () => {
      scheduleMockWebhook({
        webhookUrl: 'http://localhost:8787/webhooks/payment',
        webhookVerifier: 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=',
        transactionId: 'txn-789',
        delayMs: 0,
      });

      await vi.advanceTimersByTimeAsync(0);
      await vi.waitFor(() => {
        expect(fetch).toHaveBeenCalledTimes(1);
      });

      const fetchCall = vi.mocked(fetch).mock.calls[0];
      expect(fetchCall).toBeDefined();
      const body = JSON.parse(fetchCall?.[1]?.body as string);

      expect(body).toEqual({
        type: 'cardTransaction',
        id: 'txn-789',
      });
    });
  });
});
