import { useState, useEffect, useRef, useCallback } from 'react';
import { Button } from '@lome-chat/ui';
import { DollarSign, CreditCard, Lock, MapPin } from 'lucide-react';
import { HelcimLogo } from './helcim-logo.js';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@lome-chat/ui';
import { FormInput } from '@/components/shared/form-input';
import { DevOnly } from '@/components/shared/dev-only';
import {
  loadHelcimScript,
  readHelcimResult,
  type HelcimTokenResult,
} from '../../lib/helcim-loader.js';
import { useCreatePayment, useProcessPayment, usePaymentStatus } from '../../hooks/billing.js';
import { usePaymentForm } from '../../hooks/use-payment-form.js';
import { MIN_DEPOSIT_AMOUNT, MAX_DEPOSIT_AMOUNT } from '../../lib/payment-validation.js';

// Declare Helcim global functions
declare global {
  interface Window {
    helcimProcess?: () => void;
  }
}

type PaymentState = 'idle' | 'processing' | 'success' | 'error';

interface PaymentFormProps {
  onSuccess?: (newBalance: string) => void;
  onCancel?: () => void;
}

export function PaymentForm({ onSuccess, onCancel }: PaymentFormProps): React.JSX.Element {
  const jsToken = import.meta.env['VITE_HELCIM_JS_TOKEN'] as string | undefined;
  const isDevMode = jsToken === 'dev-mock';

  const form = usePaymentForm();

  const [paymentState, setPaymentState] = useState<PaymentState>('idle');
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const observerRef = useRef<MutationObserver | null>(null);

  const createPayment = useCreatePayment();
  const processPayment = useProcessPayment();

  // Poll payment status when awaiting webhook
  const { data: paymentStatus } = usePaymentStatus(paymentId, {
    enabled: isPolling,
    refetchInterval: isPolling ? 2000 : false,
  });

  useEffect(() => {
    if (!paymentStatus || !isPolling) return;

    if (paymentStatus.status === 'confirmed') {
      setIsPolling(false);
      setPaymentState('success');
      if ('newBalance' in paymentStatus) {
        onSuccess?.(paymentStatus.newBalance);
      }
    } else if (paymentStatus.status === 'failed') {
      setIsPolling(false);
      setPaymentState('error');
      if ('errorMessage' in paymentStatus && paymentStatus.errorMessage) {
        setErrorMessage(paymentStatus.errorMessage);
      }
    }
  }, [paymentStatus, isPolling, onSuccess]);

  const handleTokenizationResult = useCallback(
    async (result: HelcimTokenResult): Promise<void> => {
      if (!result.success) {
        setPaymentState('error');
        setErrorMessage(result.errorMessage ?? 'Card tokenization failed');
        return;
      }

      if (!result.cardToken || !paymentId) {
        setPaymentState('error');
        setErrorMessage('Missing card token or payment ID');
        return;
      }

      try {
        const response = await processPayment.mutateAsync({
          paymentId,
          cardToken: result.cardToken,
        });

        if (response.status === 'confirmed') {
          setPaymentState('success');
          onSuccess?.(response.newBalance);
        } else {
          // response.status === 'processing' - Start polling for webhook confirmation
          setIsPolling(true);
        }
      } catch (err) {
        setPaymentState('error');
        setErrorMessage(err instanceof Error ? err.message : 'Payment failed');
      }
    },
    [paymentId, processPayment, onSuccess]
  );

  useEffect(() => {
    // In dev mode, mark as loaded immediately (script will fail but we use simulation)
    if (isDevMode) {
      setScriptLoaded(true);
      return;
    }

    let mounted = true;

    loadHelcimScript()
      .then(() => {
        if (mounted) {
          setScriptLoaded(true);
        }
      })
      .catch((err: unknown) => {
        if (mounted) {
          setScriptError(err instanceof Error ? err.message : 'Failed to load payment form');
        }
      });

    return () => {
      mounted = false;
    };
  }, [isDevMode]);

  // Set up MutationObserver to detect Helcim response
  useEffect(() => {
    if (!scriptLoaded) return;

    const resultsDiv = document.getElementById('helcimResults');
    if (!resultsDiv) return;

    observerRef.current = new MutationObserver(() => {
      // Only process if there's actual data in the response field
      const responseEl = document.getElementById('response') as HTMLInputElement | null;
      if (!responseEl?.value) return;

      const result = readHelcimResult();
      void handleTokenizationResult(result);
    });

    observerRef.current.observe(resultsDiv, {
      childList: true,
      subtree: true,
      attributes: true,
    });

    return () => {
      observerRef.current?.disconnect();
    };
  }, [scriptLoaded, handleTokenizationResult]);

  const handleSimulateSuccess = async (): Promise<void> => {
    try {
      const simulateAmount = form.amount || '100';
      const formattedAmount = parseFloat(simulateAmount).toFixed(8);

      const payment = await createPayment.mutateAsync({ amount: formattedAmount });

      const result = await processPayment.mutateAsync({
        paymentId: payment.paymentId,
        cardToken: 'mock-dev-token',
      });

      if (result.status === 'confirmed') {
        setPaymentState('success');
        onSuccess?.(result.newBalance);
      } else {
        // Shouldn't happen in mock mode, but handle it
        setPaymentState('error');
        setErrorMessage('Simulated payment processing');
      }
    } catch (error) {
      setPaymentState('error');
      setErrorMessage(error instanceof Error ? error.message : 'Simulation failed');
    }
  };

  const handleSimulateFailure = (): void => {
    setPaymentState('error');
    setErrorMessage('Simulated payment failure');
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();

    if (!form.validateAll()) {
      return;
    }

    setPaymentState('processing');

    try {
      // Format to 8 decimal places for backend
      const formattedAmount = parseFloat(form.amount).toFixed(8);
      const result = await createPayment.mutateAsync({ amount: formattedAmount });
      setPaymentId(result.paymentId);

      // Dev mode: don't call helcimProcess - wait for simulation buttons
      if (isDevMode) {
        return;
      }

      if (window.helcimProcess) {
        window.helcimProcess();
        // MutationObserver on #helcimResults will handle the response
      } else {
        throw new Error('Helcim payment processor not available');
      }
    } catch (err) {
      setPaymentState('error');
      setErrorMessage(err instanceof Error ? err.message : 'Payment failed');
    }
  };

  const handleReset = (): void => {
    form.reset();
    setPaymentState('idle');
    setPaymentId(null);
    setErrorMessage(null);
    setIsPolling(false);
  };

  if (paymentState === 'success') {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Payment Successful</CardTitle>
          <CardDescription>Your deposit has been processed</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="py-4 text-center">
            <p className="text-primary text-2xl font-semibold">
              +${parseFloat(form.amount || '0').toFixed(2)}
            </p>
            <p className="text-muted-foreground mt-2">Added to your balance</p>
          </div>
          <Button onClick={handleReset} className="w-full">
            Make Another Deposit
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (paymentState === 'error') {
    return (
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Payment Failed</CardTitle>
          <CardDescription>We couldn&apos;t process your payment</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="py-4 text-center">
            <p className="text-destructive">
              Something went wrong. Please try again or contact support.
            </p>
          </div>
          <DevOnly>
            <p className="text-muted-foreground text-center text-sm">
              {errorMessage ?? 'An unexpected error occurred'}
            </p>
          </DevOnly>
          <div className="flex gap-3">
            {onCancel && (
              <Button variant="outline" onClick={onCancel} className="flex-1">
                Cancel
              </Button>
            )}
            <Button onClick={handleReset} className="flex-1">
              Try Again
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-md">
      <CardHeader>
        <CardTitle>Add Credits</CardTitle>
        <CardDescription>Enter amount and card details</CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={(e) => {
            void handleSubmit(e);
          }}
          className="space-y-4"
          noValidate
        >
          {/* Hidden Helcim fields */}
          <input type="hidden" id="token" value={jsToken ?? ''} />
          <input type="hidden" id="amount" value={form.amount} />

          <FormInput
            id="amount-input"
            label="Amount (USD) - Minimum $5"
            type="number"
            min={MIN_DEPOSIT_AMOUNT}
            max={MAX_DEPOSIT_AMOUNT}
            step="0.01"
            icon={<DollarSign className="h-5 w-5" />}
            value={form.amount}
            onChange={(e) => {
              form.handleAmountChange(e.target.value);
            }}
            aria-invalid={!!form.amountValidation.error}
            error={form.amountValidation.error}
            success={form.amountValidation.success}
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />

          {scriptError ? (
            <div className="py-4 text-center">
              <p className="text-destructive mb-4">Failed to load payment form</p>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  window.location.reload();
                }}
              >
                Reload Page
              </Button>
            </div>
          ) : !scriptLoaded ? (
            <div className="py-8 text-center" data-testid="helcim-loading">
              <p className="text-muted-foreground">Loading payment form...</p>
            </div>
          ) : (
            <>
              <FormInput
                id="cardNumber"
                label="Card Number"
                type="text"
                inputMode="numeric"
                autoComplete="cc-number"
                icon={<CreditCard className="h-5 w-5" />}
                value={form.cardNumber}
                onChange={(e) => {
                  form.handleCardNumberChange(e.target.value);
                }}
                maxLength={19}
                aria-invalid={!!form.cardValidation.cardNumber.error}
                error={form.cardValidation.cardNumber.error ?? undefined}
                success={form.cardValidation.cardNumber.success}
              />

              <div className="flex gap-3">
                <div className="flex-1">
                  <FormInput
                    id="cardExpiryDate"
                    label="Expiry (MM/YY)"
                    type="text"
                    inputMode="numeric"
                    autoComplete="cc-exp"
                    value={form.expiry}
                    onChange={(e) => {
                      form.handleExpiryChange(e.target.value);
                    }}
                    maxLength={7}
                    aria-invalid={!!form.cardValidation.expiry.error}
                    error={form.cardValidation.expiry.error ?? undefined}
                    success={form.cardValidation.expiry.success}
                  />
                </div>
                {/* Hidden fields for Helcim - it needs month and year separately */}
                <input type="hidden" id="cardExpiryMonth" value={form.expiryParts.month} />
                <input type="hidden" id="cardExpiryYear" value={form.expiryParts.year} />

                <div className="flex-1">
                  <FormInput
                    id="cardCVV"
                    label="CVV"
                    type="text"
                    inputMode="numeric"
                    autoComplete="cc-csc"
                    icon={<Lock className="h-5 w-5" />}
                    value={form.cvv}
                    onChange={(e) => {
                      form.handleCvvChange(e.target.value);
                    }}
                    maxLength={4}
                    aria-invalid={!!form.cardValidation.cvv.error}
                    error={form.cardValidation.cvv.error ?? undefined}
                    success={form.cardValidation.cvv.success}
                  />
                </div>
              </div>

              <FormInput
                id="cardHolderPostalCode"
                label="ZIP Code"
                type="text"
                autoComplete="postal-code"
                icon={<MapPin className="h-5 w-5" />}
                value={form.zipCode}
                onChange={(e) => {
                  form.handleZipChange(e.target.value);
                }}
                maxLength={10}
                aria-invalid={!!form.cardValidation.zipCode.error}
                error={form.cardValidation.zipCode.error ?? undefined}
                success={form.cardValidation.zipCode.success}
              />

              {/* Hidden results container for Helcim response */}
              <div id="helcimResults" className="hidden">
                <input type="hidden" id="response" />
                <input type="hidden" id="responseMessage" />
                <input type="hidden" id="cardToken" />
                <input type="hidden" id="cardType" />
                <input type="hidden" id="cardF4L4" />
              </div>
            </>
          )}

          {paymentState === 'processing' && (
            <div className="py-4 text-center">
              <p className="text-muted-foreground animate-pulse">Processing payment...</p>
            </div>
          )}

          <div className="flex gap-3">
            {onCancel && (
              <Button type="button" variant="outline" onClick={onCancel} className="flex-1">
                Cancel
              </Button>
            )}
            <Button
              type="submit"
              disabled={!scriptLoaded || paymentState === 'processing' || createPayment.isPending}
              className="flex-1"
            >
              {paymentState === 'processing' || createPayment.isPending
                ? 'Processing...'
                : 'Purchase'}
            </Button>
          </div>

          <div data-testid="helcim-security-badge" className="flex justify-center pt-4">
            <HelcimLogo />
          </div>

          <DevOnly>
            <div className="flex gap-2" data-testid="dev-simulation-buttons">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleSimulateSuccess()}
                disabled={createPayment.isPending || processPayment.isPending}
                className="flex-1"
                data-testid="simulate-success-btn"
              >
                {createPayment.isPending || processPayment.isPending
                  ? 'Processing...'
                  : 'Simulate Success'}
              </Button>
              <Button
                type="button"
                variant="destructive"
                onClick={handleSimulateFailure}
                className="flex-1"
                data-testid="simulate-failure-btn"
              >
                Simulate Failure
              </Button>
            </div>
          </DevOnly>
        </form>
      </CardContent>
    </Card>
  );
}
