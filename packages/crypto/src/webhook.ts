import { textEncoder, toStandardBase64, fromStandardBase64 } from '@hushbox/shared';
import { constantTimeCompare } from './constant-time.js';

export interface HmacWebhookSignParams {
  secret: string;
  payload: string;
  timestamp: string;
  webhookId: string;
}

export interface HmacWebhookVerifyParams {
  secret: string;
  payload: string;
  signatureHeader: string;
  timestamp: string;
  webhookId: string;
}

/**
 * Sign a webhook payload with HMAC-SHA256.
 * Returns a versioned signature string in the format "v1,<base64>".
 */
export async function signHmacSha256Webhook(params: HmacWebhookSignParams): Promise<string> {
  const { secret, payload, timestamp, webhookId } = params;
  const message = `${webhookId}.${timestamp}.${payload}`;

  const secretBytes = fromStandardBase64(secret);

  const key = await crypto.subtle.importKey(
    'raw',
    secretBytes.buffer as ArrayBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
  const signature = toStandardBase64(new Uint8Array(signatureBuffer));

  return `v1,${signature}`;
}

/**
 * Verify a webhook signature against its payload using HMAC-SHA256.
 * Supports versioned ("v1,signature"), multi-signature ("v1,sig1 v2,sig2"),
 * and plain base64 signature formats.
 */
export async function verifyHmacSha256Webhook(params: HmacWebhookVerifyParams): Promise<boolean> {
  const { secret, payload, signatureHeader, timestamp, webhookId } = params;
  try {
    const message = `${webhookId}.${timestamp}.${payload}`;

    const secretBytes = fromStandardBase64(secret);

    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes.buffer as ArrayBuffer,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign('HMAC', key, textEncoder.encode(message));
    const computedSignature = toStandardBase64(new Uint8Array(signatureBuffer));

    const signatures = parseSignatures(signatureHeader);

    for (const signature of signatures) {
      if (
        constantTimeCompare(textEncoder.encode(computedSignature), textEncoder.encode(signature))
      ) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/* eslint-disable no-secrets/no-secrets -- false positive in docstring format examples */
/**
 * Parse versioned signature header.
 * Formats:
 * - "v1,signature_base64"
 * - "v1,sig1 v2,sig2" (multiple signatures)
 * - "raw_signature" (plain base64, for backwards compatibility)
 */
/* eslint-enable no-secrets/no-secrets */
function parseSignatures(signatureHeader: string): string[] {
  const signatures: string[] = [];

  const parts = signatureHeader.split(' ');

  for (const part of parts) {
    const commaIndex = part.indexOf(',');
    if (commaIndex > 0 && part.startsWith('v')) {
      signatures.push(part.slice(commaIndex + 1));
    } else {
      signatures.push(part);
    }
  }

  return signatures;
}
