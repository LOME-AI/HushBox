export interface ProcessPaymentRequest {
  cardToken: string;
  amount: string; // USD amount as decimal string, e.g., "10.00000000"
  paymentId: string; // Used as idempotency key
}

export interface ProcessPaymentResponse {
  status: 'approved' | 'declined';
  transactionId?: string | undefined;
  errorMessage?: string | undefined;
  cardType?: string | undefined;
  cardLastFour?: string | undefined;
}

export interface HelcimClient {
  processPayment(request: ProcessPaymentRequest): Promise<ProcessPaymentResponse>;
  readonly isMock: boolean;
}

export interface MockHelcimClient extends HelcimClient {
  setNextResponse(response: ProcessPaymentResponse): void;
  getProcessedPayments(): ProcessPaymentRequest[];
  clearProcessedPayments(): void;
}
