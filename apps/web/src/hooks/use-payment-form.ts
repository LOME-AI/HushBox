import { useState, useCallback, useMemo } from 'react';
import { formatCardNumber, formatExpiry, formatCvv, formatZip } from '../lib/card-utils.js';
import {
  validateAmount,
  getCardValidationState,
  validateAllCardFields,
  type AmountValidation,
  type CardFields,
  type CardTouchedState,
  type CardValidationState,
} from '../lib/payment-validation.js';

interface UsePaymentFormReturn {
  // Values
  amount: string;
  cardNumber: string;
  expiry: string;
  cvv: string;
  zipCode: string;

  // Touched state
  amountTouched: boolean;
  cardTouched: CardTouchedState;

  // Validation state
  amountValidation: AmountValidation;
  cardValidation: CardValidationState;

  // Handlers
  handleAmountChange: (value: string) => void;
  handleCardNumberChange: (value: string) => void;
  handleExpiryChange: (value: string) => void;
  handleCvvChange: (value: string) => void;
  handleZipChange: (value: string) => void;

  // Actions
  touchAllFields: () => void;
  validateAll: () => boolean;
  reset: () => void;

  // Computed values
  cardFields: CardFields;
  expiryParts: { month: string; year: string };
}

/**
 * Hook for managing payment form state, validation, and handlers.
 */
export function usePaymentForm(): UsePaymentFormReturn {
  // Amount state
  const [amount, setAmount] = useState('');
  const [amountTouched, setAmountTouched] = useState(false);

  // Card input state
  const [cardNumber, setCardNumber] = useState('');
  const [expiry, setExpiry] = useState('');
  const [cvv, setCvv] = useState('');
  const [zipCode, setZipCode] = useState('');
  const [cardTouched, setCardTouched] = useState<CardTouchedState>({
    cardNumber: false,
    expiry: false,
    cvv: false,
    zipCode: false,
  });

  // Computed card fields
  const cardFields = useMemo<CardFields>(
    () => ({
      cardNumber,
      expiry,
      cvv,
      zipCode,
    }),
    [cardNumber, expiry, cvv, zipCode]
  );

  // Computed expiry parts for Helcim hidden fields
  const expiryParts = useMemo(() => {
    const parts = expiry.split(' / ');
    return {
      month: parts[0] ?? '',
      year: parts[1] ?? '',
    };
  }, [expiry]);

  // Computed validation state
  const amountValidation = useMemo<AmountValidation>(
    () => (amountTouched ? validateAmount(amount) : { isValid: false }),
    [amount, amountTouched]
  );

  const cardValidation = useMemo<CardValidationState>(
    () => getCardValidationState(cardFields, cardTouched),
    [cardFields, cardTouched]
  );

  // Handlers
  const handleAmountChange = useCallback((value: string) => {
    setAmount(value);
    setAmountTouched(true);
  }, []);

  const handleCardNumberChange = useCallback((value: string) => {
    setCardNumber(formatCardNumber(value));
    setCardTouched((prev) => ({ ...prev, cardNumber: true }));
  }, []);

  const handleExpiryChange = useCallback((value: string) => {
    setExpiry(formatExpiry(value));
    setCardTouched((prev) => ({ ...prev, expiry: true }));
  }, []);

  const handleCvvChange = useCallback((value: string) => {
    setCvv(formatCvv(value));
    setCardTouched((prev) => ({ ...prev, cvv: true }));
  }, []);

  const handleZipChange = useCallback((value: string) => {
    setZipCode(formatZip(value));
    setCardTouched((prev) => ({ ...prev, zipCode: true }));
  }, []);

  // Touch all fields (for form submission)
  const touchAllFields = useCallback(() => {
    setAmountTouched(true);
    setCardTouched({
      cardNumber: true,
      expiry: true,
      cvv: true,
      zipCode: true,
    });
  }, []);

  // Validate all and return result
  const validateAll = useCallback((): boolean => {
    touchAllFields();

    const amountResult = validateAmount(amount);
    const cardResult = validateAllCardFields(cardFields);

    return amountResult.isValid && cardResult;
  }, [amount, cardFields, touchAllFields]);

  // Reset form
  const reset = useCallback(() => {
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
  }, []);

  return {
    // Values
    amount,
    cardNumber,
    expiry,
    cvv,
    zipCode,

    // Touched state
    amountTouched,
    cardTouched,

    // Validation state
    amountValidation,
    cardValidation,

    // Handlers
    handleAmountChange,
    handleCardNumberChange,
    handleExpiryChange,
    handleCvvChange,
    handleZipChange,

    // Actions
    touchAllFields,
    validateAll,
    reset,

    // Computed values
    cardFields,
    expiryParts,
  };
}
