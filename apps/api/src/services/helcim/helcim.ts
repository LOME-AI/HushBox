import type { HelcimClient, ProcessPaymentRequest, ProcessPaymentResponse } from './types.js';

const HELCIM_API_URL = 'https://api.helcim.com/v2/payment/purchase';

interface HelcimErrorDetail {
  code: string;
  message: string;
  source?: string;
  data?: string;
}

interface HelcimApiResponse {
  transactionId?: number;
  approvalCode?: string;
  responseMessage?: string;
  cardNumber?: string;
  cardType?: string;
  errors?: Record<string, HelcimErrorDetail[]>;
}

interface HelcimClientConfig {
  apiToken: string;
  webhookVerifier: string;
}

function extractHelcimErrors(errors: Record<string, HelcimErrorDetail[]>): string {
  return Object.values(errors)
    .flat()
    .map((e) => e.message)
    .join(', ');
}

export function createHelcimClient(config: HelcimClientConfig): HelcimClient {
  // Validate API token
  if (!config.apiToken) {
    throw new Error('Helcim API token is not configured');
  }
  if (config.apiToken.trim().length === 0) {
    throw new Error('Helcim API token is empty');
  }
  if (config.apiToken.length < 10) {
    throw new Error('Helcim API token appears invalid (too short)');
  }

  // Validate webhook verifier
  if (!config.webhookVerifier) {
    throw new Error('Helcim webhook verifier is not configured');
  }
  if (config.webhookVerifier.trim().length === 0) {
    throw new Error('Helcim webhook verifier is empty');
  }

  return {
    isMock: false,

    async processPayment(request: ProcessPaymentRequest): Promise<ProcessPaymentResponse> {
      const requestBody = {
        amount: parseFloat(request.amount),
        currency: 'USD',
        ipAddress: request.ipAddress,
        customerCode: request.customerCode,
        cardData: {
          cardToken: request.cardToken,
        },
      };

      const response = await fetch(HELCIM_API_URL, {
        method: 'POST',
        headers: {
          'api-token': config.apiToken,
          'Content-Type': 'application/json',
          accept: 'application/json',
          'idempotency-key': request.paymentId,
        },
        body: JSON.stringify(requestBody),
      });

      const data: HelcimApiResponse = await response.json();

      if (response.ok && data.approvalCode) {
        return {
          status: 'approved',
          transactionId: String(data.transactionId),
          cardType: data.cardType,
          cardLastFour: data.cardNumber?.slice(-4),
        };
      }

      const errorMessage =
        data.responseMessage ??
        (data.errors ? extractHelcimErrors(data.errors) : null) ??
        'Payment declined';

      return {
        status: 'declined',
        errorMessage,
        debugInfo: {
          httpStatus: response.status,
          responseBody: data,
        },
      };
    },
  };
}

/**
 * Parse versioned signature header from Helcim.
 * Helcim sends signatures in formats like:
 * - "v1,signature_base64"
 * - "v1,sig1 v2,sig2" (multiple signatures)
 * - "raw_signature" (plain base64, for backwards compatibility)
 */
function parseSignatures(signatureHeader: string): string[] {
  const signatures: string[] = [];

  // Split by space for multiple signatures
  const parts = signatureHeader.split(' ');

  for (const part of parts) {
    // Check for versioned format "v1,signature"
    const commaIndex = part.indexOf(',');
    if (commaIndex > 0 && part.startsWith('v')) {
      // Extract signature after the version prefix
      signatures.push(part.slice(commaIndex + 1));
    } else {
      // Plain signature without version
      signatures.push(part);
    }
  }

  return signatures;
}

// Async version for proper webhook verification
export async function verifyWebhookSignatureAsync(
  webhookVerifier: string,
  payload: string,
  signatureHeader: string,
  timestamp: string,
  webhookId: string
): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const message = `${webhookId}.${timestamp}.${payload}`;

    // Decode the base64 verifier
    const secretBytes = Uint8Array.from(atob(webhookVerifier), (c) => c.charCodeAt(0));

    // Import the key for HMAC-SHA256
    const key = await crypto.subtle.importKey(
      'raw',
      secretBytes,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    // Compute the signature
    const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
    const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

    // Parse potentially versioned signature header
    const signatures = parseSignatures(signatureHeader);

    // Check if any signature matches (timing-safe comparison for each)
    for (const signature of signatures) {
      if (timingSafeEqual(computedSignature, signature)) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }

  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
