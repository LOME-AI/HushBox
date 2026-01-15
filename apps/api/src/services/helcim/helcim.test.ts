import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createHelcimClient, verifyWebhookSignatureAsync } from './helcim.js';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('createHelcimClient', () => {
  const config = {
    apiToken: 'test-api-token',
    webhookVerifier: btoa('test-webhook-secret'),
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('validation', () => {
    it('throws if apiToken is missing', () => {
      expect(() =>
        createHelcimClient({ apiToken: '', webhookVerifier: config.webhookVerifier })
      ).toThrow('Helcim API token is not configured');
    });

    it('throws if apiToken is only whitespace', () => {
      expect(() =>
        createHelcimClient({ apiToken: '   ', webhookVerifier: config.webhookVerifier })
      ).toThrow('Helcim API token is empty');
    });

    it('throws if apiToken is too short', () => {
      expect(() =>
        createHelcimClient({ apiToken: 'short', webhookVerifier: config.webhookVerifier })
      ).toThrow('Helcim API token appears invalid (too short)');
    });

    it('throws if webhookVerifier is missing', () => {
      expect(() => createHelcimClient({ apiToken: config.apiToken, webhookVerifier: '' })).toThrow(
        'Helcim webhook verifier is not configured'
      );
    });

    it('throws if webhookVerifier is only whitespace', () => {
      expect(() =>
        createHelcimClient({ apiToken: config.apiToken, webhookVerifier: '   ' })
      ).toThrow('Helcim webhook verifier is empty');
    });
  });

  describe('isMock property', () => {
    it('returns false for real client', () => {
      const client = createHelcimClient(config);

      expect(client.isMock).toBe(false);
    });
  });

  describe('processPayment', () => {
    it('makes POST request to Helcim API with correct headers', async () => {
      const client = createHelcimClient(config);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            transactionId: 12345,
            approvalCode: 'ABC123',
            cardNumber: '************1234',
            cardType: 'Visa',
          }),
      });

      await client.processPayment({
        cardToken: 'test-token',
        customerCode: 'CST1234',
        amount: '10.00000000',
        paymentId: 'payment-123',
        ipAddress: '192.168.1.1',
      });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.helcim.com/v2/payment/purchase',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'api-token': 'test-api-token',
            'Content-Type': 'application/json',
            accept: 'application/json',
            'idempotency-key': 'payment-123',
          },
          body: JSON.stringify({
            amount: 10,
            currency: 'USD',
            ipAddress: '192.168.1.1',
            customerCode: 'CST1234',
            cardData: {
              cardToken: 'test-token',
            },
          }),
        })
      );
    });

    it('returns approved status on successful response', async () => {
      const client = createHelcimClient(config);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            transactionId: 12345,
            approvalCode: 'ABC123',
            cardNumber: '************1234',
            cardType: 'Visa',
          }),
      });

      const result = await client.processPayment({
        cardToken: 'test-token',
        customerCode: 'CST1234',
        amount: '10.00000000',
        paymentId: 'payment-123',
        ipAddress: '192.168.1.1',
      });

      expect(result.status).toBe('approved');
      expect(result.transactionId).toBe('12345');
      expect(result.cardType).toBe('Visa');
      expect(result.cardLastFour).toBe('1234');
    });

    it('returns declined status on failed response', async () => {
      const client = createHelcimClient(config);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () =>
          Promise.resolve({
            responseMessage: 'Insufficient funds',
          }),
      });

      const result = await client.processPayment({
        cardToken: 'test-token',
        customerCode: 'CST1234',
        amount: '10.00000000',
        paymentId: 'payment-123',
        ipAddress: '192.168.1.1',
      });

      expect(result.status).toBe('declined');
      expect(result.errorMessage).toBe('Insufficient funds');
    });

    it('handles validation errors from Helcim', async () => {
      const client = createHelcimClient(config);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () =>
          Promise.resolve({
            errors: {
              ERR_INVALID_REQUEST: [
                { code: 'ERR_INVALID_REQUEST', message: 'Invalid card token' },
                { code: 'ERR_INVALID_REQUEST', message: 'Invalid amount' },
              ],
            },
          }),
      });

      const result = await client.processPayment({
        cardToken: 'invalid-token',
        customerCode: 'CST1234',
        amount: '10.00000000',
        paymentId: 'payment-123',
        ipAddress: '192.168.1.1',
      });

      expect(result.status).toBe('declined');
      expect(result.errorMessage).toContain('Invalid card token');
      expect(result.errorMessage).toContain('Invalid amount');
    });

    it('returns default error message when no specific message provided', async () => {
      const client = createHelcimClient(config);
      mockFetch.mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({}),
      });

      const result = await client.processPayment({
        cardToken: 'test-token',
        customerCode: 'CST1234',
        amount: '10.00000000',
        paymentId: 'payment-123',
        ipAddress: '192.168.1.1',
      });

      expect(result.status).toBe('declined');
      expect(result.errorMessage).toBe('Payment declined');
    });

    it('parses amount as float', async () => {
      const client = createHelcimClient(config);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            transactionId: 12345,
            approvalCode: 'ABC123',
          }),
      });

      await client.processPayment({
        cardToken: 'test-token',
        customerCode: 'CST1234',
        amount: '25.50000000',
        paymentId: 'payment-123',
        ipAddress: '192.168.1.1',
      });

      const call = mockFetch.mock.calls[0] as [string, { body: string }] | undefined;
      expect(call).toBeDefined();
      const body = JSON.parse(call?.[1]?.body ?? '{}') as { amount: number };
      expect(body.amount).toBe(25.5);
    });
  });
});

describe('verifyWebhookSignatureAsync', () => {
  it('returns true for matching signature', async () => {
    const verifier = btoa('test-secret');
    const payload = '{"event":"test"}';
    const timestamp = '1234567890';
    const webhookId = 'webhook-123';

    // Compute expected signature
    const encoder = new TextEncoder();
    const message = `${webhookId}.${timestamp}.${payload}`;
    const secretBytes = Uint8Array.from(atob(verifier), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const signature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    const result = await verifyWebhookSignatureAsync(
      verifier,
      payload,
      signature,
      timestamp,
      webhookId
    );

    expect(result).toBe(true);
  });

  it('returns true for versioned signature format (v1,signature)', async () => {
    const verifier = btoa('test-secret');
    const payload = '{"event":"test"}';
    const timestamp = '1234567890';
    const webhookId = 'webhook-123';

    // Compute expected signature
    const encoder = new TextEncoder();
    const message = `${webhookId}.${timestamp}.${payload}`;
    const secretBytes = Uint8Array.from(atob(verifier), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const rawSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    // Helcim sends versioned signatures like "v1,signature"
    const versionedSignature = `v1,${rawSignature}`;

    const result = await verifyWebhookSignatureAsync(
      verifier,
      payload,
      versionedSignature,
      timestamp,
      webhookId
    );

    expect(result).toBe(true);
  });

  it('returns true when any version matches in multi-signature header', async () => {
    const verifier = btoa('test-secret');
    const payload = '{"event":"test"}';
    const timestamp = '1234567890';
    const webhookId = 'webhook-123';

    // Compute expected signature
    const encoder = new TextEncoder();
    const message = `${webhookId}.${timestamp}.${payload}`;
    const secretBytes = Uint8Array.from(atob(verifier), (c) => c.charCodeAt(0));
    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const rawSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    // Helcim can send multiple signatures: "v1,sig1 v2,sig2"
    const multiSignature = `v0,invalidSignature v1,${rawSignature}`;

    const result = await verifyWebhookSignatureAsync(
      verifier,
      payload,
      multiSignature,
      timestamp,
      webhookId
    );

    expect(result).toBe(true);
  });

  it('returns false for non-matching signature', async () => {
    const verifier = btoa('test-secret');
    const payload = '{"event":"test"}';
    const wrongSignature = btoa(String.fromCharCode(...Array.from({ length: 32 }, () => 65)));

    const result = await verifyWebhookSignatureAsync(
      verifier,
      payload,
      wrongSignature,
      '1234567890',
      'webhook-123'
    );

    expect(result).toBe(false);
  });

  it('returns false for invalid base64 signature', async () => {
    const verifier = btoa('test-secret');

    const result = await verifyWebhookSignatureAsync(
      verifier,
      'payload',
      '!!!invalid!!!',
      'timestamp',
      'webhookId'
    );

    expect(result).toBe(false);
  });

  it('returns false for invalid verifier', async () => {
    const result = await verifyWebhookSignatureAsync(
      '!!!invalid!!!',
      'payload',
      btoa('signature'),
      'timestamp',
      'webhookId'
    );

    expect(result).toBe(false);
  });
});
