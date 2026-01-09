import type { MockHelcimClient, ProcessPaymentRequest, ProcessPaymentResponse } from './types.js';

export function createMockHelcimClient(): MockHelcimClient {
  const processedPayments: ProcessPaymentRequest[] = [];
  let nextResponse: ProcessPaymentResponse = {
    status: 'approved',
    transactionId: 'mock-txn-' + crypto.randomUUID(),
    cardType: 'Visa',
    cardLastFour: '9990',
  };

  return {
    isMock: true,

    processPayment(request: ProcessPaymentRequest): Promise<ProcessPaymentResponse> {
      processedPayments.push({ ...request });

      // Return a copy with unique transaction ID for each request
      const response = { ...nextResponse };
      if (response.status === 'approved') {
        // Always generate a unique transaction ID for approved payments
        response.transactionId = 'mock-txn-' + crypto.randomUUID();
      }
      return Promise.resolve(response);
    },

    verifyWebhookSignature(): boolean {
      // Mock always returns true - real verification tested in integration tests
      return true;
    },

    setNextResponse(response: ProcessPaymentResponse): void {
      nextResponse = response;
    },

    getProcessedPayments(): ProcessPaymentRequest[] {
      return [...processedPayments];
    },

    clearProcessedPayments(): void {
      processedPayments.length = 0;
    },
  };
}
