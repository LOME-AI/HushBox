/**
 * Mock webhook sender for local development.
 * Sends properly-signed webhooks to the local webhook endpoint
 * to test the full payment flow without real Helcim.
 */

const WEBHOOK_PAYMENT_PATH = '/api/webhooks/payment';
const MOCK_WEBHOOK_DELAY_MS = 1000;

export interface MockWebhookConfig {
  webhookUrl: string;
  webhookVerifier: string;
  transactionId: string;
  delayMs?: number;
}

interface MockWebhookPayload {
  type: 'cardTransaction';
  id: string;
}

// eslint-disable-next-line no-secrets/no-secrets -- Function name reference, not a secret
/**
 * Generate HMAC-SHA256 signature matching Helcim's webhook format.
 * Uses the same algorithm as verifyWebhookSignatureAsync in helcim.ts.
 */
export async function generateWebhookSignature(
  webhookVerifier: string,
  payload: string,
  timestamp: string,
  webhookId: string
): Promise<string> {
  const encoder = new TextEncoder();
  const message = `${webhookId}.${timestamp}.${payload}`;

  const secretBytes = Uint8Array.from(atob(webhookVerifier), (c) => c.codePointAt(0) ?? 0);

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  const signature = btoa(String.fromCodePoint(...new Uint8Array(signatureBuffer)));

  return `v1,${signature}`;
}

/**
 * Schedule mock webhook delivery after a delay.
 * Fire-and-forget - does not block the caller.
 */
export function scheduleMockWebhook(config: MockWebhookConfig): void {
  const { webhookUrl, webhookVerifier, transactionId, delayMs = MOCK_WEBHOOK_DELAY_MS } = config;

  setTimeout(() => {
    void sendMockWebhook(webhookUrl, webhookVerifier, transactionId);
  }, delayMs);
}

async function sendMockWebhook(
  webhookUrl: string,
  webhookVerifier: string,
  transactionId: string
): Promise<void> {
  const payload: MockWebhookPayload = {
    type: 'cardTransaction',
    id: transactionId,
  };
  const payloadString = JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const webhookId = `mock-webhook-${crypto.randomUUID()}`;

  const signature = await generateWebhookSignature(
    webhookVerifier,
    payloadString,
    timestamp,
    webhookId
  );

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'webhook-signature': signature,
        'webhook-timestamp': timestamp,
        'webhook-id': webhookId,
      },
      body: payloadString,
    });

    if (response.ok) {
      console.log(`[MockWebhook] Delivered for transactionId=${transactionId}`);
    } else {
      console.error(`[MockWebhook] Failed: ${String(response.status)} ${response.statusText}`);
    }
  } catch (error) {
    console.error('[MockWebhook] Error:', error);
  }
}

export { WEBHOOK_PAYMENT_PATH, MOCK_WEBHOOK_DELAY_MS };
