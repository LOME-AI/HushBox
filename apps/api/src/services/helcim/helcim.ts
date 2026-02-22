import type { HelcimClient, ProcessPaymentRequest, ProcessPaymentResponse } from './types.js';
import { verifyHmacSha256Webhook } from '@hushbox/crypto';
import { safeJsonParse } from '../../lib/safe-json.js';

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
        amount: Number.parseFloat(request.amount),
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

      const data = await safeJsonParse<HelcimApiResponse>(response, 'Helcim payment');

      if (response.ok && data.approvalCode) {
        return {
          status: 'approved',
          transactionId: data.transactionId == null ? null : String(data.transactionId),
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

export interface WebhookVerificationParams {
  webhookVerifier: string;
  payload: string;
  signatureHeader: string;
  timestamp: string;
  webhookId: string;
}

export async function verifyWebhookSignatureAsync(
  params: WebhookVerificationParams
): Promise<boolean> {
  return verifyHmacSha256Webhook({
    secret: params.webhookVerifier,
    payload: params.payload,
    signatureHeader: params.signatureHeader,
    timestamp: params.timestamp,
    webhookId: params.webhookId,
  });
}
