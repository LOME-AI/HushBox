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

// Minimum deposit amount in USD
const MIN_DEPOSIT_AMOUNT = 5;
const MAX_DEPOSIT_AMOUNT = 1000;

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

interface AmountValidation {
  isValid: boolean;
  error?: string;
  success?: string;
}

// Luhn algorithm for card number validation
function isValidLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.length === 0) return false;

  let sum = 0;
  let isEven = false;

  for (let i = digits.length - 1; i >= 0; i--) {
    const char = digits[i];
    if (char === undefined) continue;
    let digit = parseInt(char, 10);

    if (isEven) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
    isEven = !isEven;
  }

  return sum % 10 === 0;
}

// Format card number: "1234 5678 9012 3456"
function formatCardNumber(value: string): string {
  const cleaned = value.replace(/\D/g, '');
  const groups = cleaned.match(/.{1,4}/g);
  return groups ? groups.join(' ').substring(0, 19) : '';
}

// Format expiry: "MM / YY"
function formatExpiry(value: string): string {
  const cleaned = value.replace(/\D/g, '');
  if (cleaned.length >= 3) {
    return `${cleaned.slice(0, 2)} / ${cleaned.slice(2, 4)}`;
  }
  return cleaned;
}

// Format CVV: digits only, max 4
function formatCvv(value: string): string {
  return value.replace(/\D/g, '').slice(0, 4);
}

// Format ZIP: alphanumeric only
function formatZip(value: string): string {
  return value.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

function validateAmount(value: string): AmountValidation {
  if (!value) {
    return { isValid: false, error: 'Please enter an amount' };
  }

  const numValue = parseFloat(value);
  if (isNaN(numValue)) {
    return { isValid: false, error: 'Please enter a valid amount' };
  }

  if (numValue < MIN_DEPOSIT_AMOUNT) {
    return { isValid: false, error: `Minimum deposit is $${String(MIN_DEPOSIT_AMOUNT)}` };
  }

  if (numValue > MAX_DEPOSIT_AMOUNT) {
    return { isValid: false, error: `Maximum deposit is $${String(MAX_DEPOSIT_AMOUNT)}` };
  }

  return { isValid: true, success: 'Valid amount' };
}

function validateCardNumber(cardNumber: string): string | null {
  const cleaned = cardNumber.replace(/\s/g, '');
  if (cleaned.length === 0) return 'Card number is required';
  if (cleaned.length < 13) return 'Card number must be at least 13 digits';
  if (cleaned.length > 19) return 'Card number is too long';
  if (!/^\d+$/.test(cleaned)) return 'Card number must contain only digits';
  if (!isValidLuhn(cleaned)) return 'Invalid card number';
  return null;
}

function validateExpiry(expiry: string): string | null {
  if (expiry.length === 0) return 'Expiry date is required';
  if (!/^\d{2}\s\/\s\d{2}$/.exec(expiry)) return 'Format: MM / YY';

  const parts = expiry.split(' / ');
  const monthStr = parts[0] ?? '';
  const yearStr = parts[1] ?? '';
  const month = parseInt(monthStr, 10);
  const year = parseInt(yearStr, 10);

  if (month < 1 || month > 12) return 'Invalid month';

  const now = new Date();
  const currentYear = now.getFullYear() % 100;
  const currentMonth = now.getMonth() + 1;

  if (year < currentYear || (year === currentYear && month < currentMonth)) {
    return 'Card has expired';
  }

  return null;
}

function validateCvv(cvv: string): string | null {
  if (cvv.length === 0) return 'CVV is required';
  if (cvv.length < 3) return 'CVV must be 3-4 digits';
  if (!/^\d+$/.test(cvv)) return 'CVV must contain only digits';
  return null;
}

function validateZip(zip: string): string | null {
  if (zip.length === 0) return 'ZIP code is required';
  if (zip.length < 5) return 'ZIP code must be 5 digits';
  return null;
}

export function PaymentForm({ onSuccess, onCancel }: PaymentFormProps): React.JSX.Element {
  // Check if we're in dev mode (for simulation buttons)
  const jsToken = import.meta.env['VITE_HELCIM_JS_TOKEN'] as string | undefined;
  const isDevMode = jsToken === 'dev-mock';

  // Amount state
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);

  // Card input state
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [cardTouched, setCardTouched] = useState({
    cardNumber: false,
    expiry: false,
    cvv: false,
    zipCode: false,
  });

  // Payment state
  const [paymentState, setPaymentState] = useState<PaymentState>('idle');
  const [scriptLoaded, setScriptLoaded] = useState(false);
  const [scriptError, setScriptError] = useState<string | null>(null);
  const [paymentId, setPaymentId] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);
  const observerRef = useRef<MutationObserver | null>(null);

  const createPayment = useCreatePayment();
  const processPayment = useProcessPayment();

  // Real-time validation
  const amountValidation = amountTouched ? validateAmount(amount) : { isValid: false };
  const cardValidation = {
    cardNumber: cardTouched.cardNumber
      ? {
          error: validateCardNumber(cardNumber),
          success:
            validateCardNumber(cardNumber) === null && cardNumber.length > 0
              ? 'Valid card'
              : undefined,
        }
      : { error: null, success: undefined },
    expiry: cardTouched.expiry
      ? {
          error: validateExpiry(expiry),
          success:
            validateExpiry(expiry) === null && expiry.length > 0 ? 'Valid expiry' : undefined,
        }
      : { error: null, success: undefined },
    cvv: cardTouched.cvv
      ? {
          error: validateCvv(cvv),
          success: validateCvv(cvv) === null && cvv.length > 0 ? 'Valid CVV' : undefined,
        }
      : { error: null, success: undefined },
    zipCode: cardTouched.zipCode
      ? {
          error: validateZip(zipCode),
          success: validateZip(zipCode) === null && zipCode.length > 0 ? 'Valid ZIP' : undefined,
        }
      : { error: null, success: undefined },
  };

  // Poll payment status when awaiting webhook
  const { data: paymentStatus } = usePaymentStatus(paymentId, {
    enabled: isPolling,
    refetchInterval: isPolling ? 2000 : false,
  });

  // Handle polling result
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

  // Handle tokenization result
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

  // Load Helcim script on mount
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

  // Dev-only simulation handlers
  const handleSimulateSuccess = async (): Promise<void> => {
    try {
      // Use user-entered amount or default to $100
      const simulateAmount = amount || '100';
      const formattedAmount = parseFloat(simulateAmount).toFixed(8);

      // Step 1: Create payment record
      const payment = await createPayment.mutateAsync({ amount: formattedAmount });

      // Step 2: Process payment with mock token (backend mock Helcim will approve)
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

  // Card input handlers
  const handleCardNumberChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setCardNumber(formatCardNumber(e.target.value));
    if (!cardTouched.cardNumber) setCardTouched((prev) => ({ ...prev, cardNumber: true }));
  };

  const handleExpiryChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setExpiry(formatExpiry(e.target.value));
    if (!cardTouched.expiry) setCardTouched((prev) => ({ ...prev, expiry: true }));
  };

  const handleCvvChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setCvv(formatCvv(e.target.value));
    if (!cardTouched.cvv) setCardTouched((prev) => ({ ...prev, cvv: true }));
  };

  const handleZipChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    setZipCode(formatZip(e.target.value));
    if (!cardTouched.zipCode) setCardTouched((prev) => ({ ...prev, zipCode: true }));
  };

  // Validate all card fields
  const validateCardFields = (): boolean => {
    const errors = {
      cardNumber: validateCardNumber(cardNumber),
      expiry: validateExpiry(expiry),
      cvv: validateCvv(cvv),
      zipCode: validateZip(zipCode),
    };

    // Mark all as touched to show errors
    setCardTouched({
      cardNumber: true,
      expiry: true,
      cvv: true,
      zipCode: true,
    });

    return !errors.cardNumber && !errors.expiry && !errors.cvv && !errors.zipCode;
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();

    // Mark amount as touched on submit
    setAmountTouched(true);

    const validation = validateAmount(amount);
    if (!validation.isValid) {
      return;
    }

    // Validate card fields
    if (!validateCardFields()) {
      return;
    }

    setPaymentState('processing');

    try {
      // Format to 8 decimal places for backend
      const formattedAmount = parseFloat(amount).toFixed(8);
      const result = await createPayment.mutateAsync({ amount: formattedAmount });
      setPaymentId(result.paymentId);

      // Dev mode: don't call helcimProcess - wait for simulation buttons
      if (isDevMode) {
        return;
      }

      // Production: call Helcim to tokenize
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
    setAmount('');
    setAmountTouched(false);
    setCardNumber('');
    setExpiry('');
    setCvv('');
    setZipCode('');
    setCardTouched({
      cardNumber: false,
      expiry: false,
      cvv: false,
      zipCode: false,
    });
    setPaymentState('idle');
    setPaymentId(null);
    setErrorMessage(null);
    setIsPolling(false);
  };

  // Render success state
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
              +${parseFloat(amount || '0').toFixed(2)}
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

  // Render error state
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

  // Render single-page form
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
          <input type="hidden" id="amount" value={amount} />

          {/* Amount input */}
          <FormInput
            id="amount-input"
            label="Amount (USD) - Minimum $5"
            type="number"
            min={MIN_DEPOSIT_AMOUNT}
            max={MAX_DEPOSIT_AMOUNT}
            step="0.01"
            icon={<DollarSign className="h-5 w-5" />}
            value={amount}
            onChange={(e) => {
              setAmount(e.target.value);
              if (!amountTouched) setAmountTouched(true);
            }}
            aria-invalid={!!amountValidation.error}
            error={amountValidation.error}
            success={amountValidation.success}
            className="[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          />

          {/* Card inputs or loading/error state */}
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
              {/* Card Number */}
              <FormInput
                id="cardNumber"
                label="Card Number"
                type="text"
                inputMode="numeric"
                autoComplete="cc-number"
                icon={<CreditCard className="h-5 w-5" />}
                value={cardNumber}
                onChange={handleCardNumberChange}
                maxLength={19}
                aria-invalid={!!cardValidation.cardNumber.error}
                error={cardValidation.cardNumber.error ?? undefined}
                success={cardValidation.cardNumber.success}
              />

              {/* Expiry and CVV side by side */}
              <div className="flex gap-3">
                <div className="flex-1">
                  <FormInput
                    id="cardExpiryDate"
                    label="Expiry (MM/YY)"
                    type="text"
                    inputMode="numeric"
                    autoComplete="cc-exp"
                    value={expiry}
                    onChange={handleExpiryChange}
                    maxLength={7}
                    aria-invalid={!!cardValidation.expiry.error}
                    error={cardValidation.expiry.error ?? undefined}
                    success={cardValidation.expiry.success}
                  />
                </div>
                {/* Hidden fields for Helcim - it needs month and year separately */}
                <input type="hidden" id="cardExpiryMonth" value={expiry.split(' / ')[0] ?? ''} />
                <input type="hidden" id="cardExpiryYear" value={expiry.split(' / ')[1] ?? ''} />

                <div className="flex-1">
                  <FormInput
                    id="cardCVV"
                    label="CVV"
                    type="text"
                    inputMode="numeric"
                    autoComplete="cc-csc"
                    icon={<Lock className="h-5 w-5" />}
                    value={cvv}
                    onChange={handleCvvChange}
                    maxLength={4}
                    aria-invalid={!!cardValidation.cvv.error}
                    error={cardValidation.cvv.error ?? undefined}
                    success={cardValidation.cvv.success}
                  />
                </div>
              </div>

              {/* ZIP Code */}
              <FormInput
                id="cardHolderPostalCode"
                label="ZIP Code"
                type="text"
                autoComplete="postal-code"
                icon={<MapPin className="h-5 w-5" />}
                value={zipCode}
                onChange={handleZipChange}
                maxLength={10}
                aria-invalid={!!cardValidation.zipCode.error}
                error={cardValidation.zipCode.error ?? undefined}
                success={cardValidation.zipCode.success}
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

          {/* Processing indicator */}
          {paymentState === 'processing' && (
            <div className="py-4 text-center">
              <p className="text-muted-foreground animate-pulse">Processing payment...</p>
            </div>
          )}

          {/* Action buttons */}
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

          {/* Helcim logo */}
          <div data-testid="helcim-security-badge" className="flex justify-center pt-4">
            <HelcimLogo />
          </div>

          {/* Dev-only simulation buttons */}
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
