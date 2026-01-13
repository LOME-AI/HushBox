import { validateCardNumber, validateExpiry, validateCvv, validateZip } from './card-utils.js';

export const MIN_DEPOSIT_AMOUNT = 5;
export const MAX_DEPOSIT_AMOUNT = 1000;
export const MIN_NAME_LENGTH = 2;
export const MIN_ADDRESS_LENGTH = 5;

export interface AmountValidation {
  isValid: boolean;
  error?: string;
  success?: string;
}

export interface CardFields {
  cardNumber: string;
  expiry: string;
  cvv: string;
  cardHolderName: string;
  billingAddress: string;
  zipCode: string;
}

export interface CardTouchedState {
  cardNumber: boolean;
  expiry: boolean;
  cvv: boolean;
  cardHolderName: boolean;
  billingAddress: boolean;
  zipCode: boolean;
}

export interface FieldValidationState {
  error: string | null;
  success?: string | undefined;
}

export interface CardValidationState {
  cardNumber: FieldValidationState;
  expiry: FieldValidationState;
  cvv: FieldValidationState;
  cardHolderName: FieldValidationState;
  billingAddress: FieldValidationState;
  zipCode: FieldValidationState;
}

/**
 * Validates deposit amount.
 */
export function validateAmount(value: string): AmountValidation {
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

/**
 * Validates cardholder name.
 */
export function validateCardHolderName(name: string): string | null {
  if (!name || name.trim().length === 0) return 'Name is required';
  if (name.trim().length < MIN_NAME_LENGTH) return 'Name is too short';
  if (!/^[a-zA-Z\s\-'.]+$/.test(name)) return 'Name contains invalid characters';
  return null;
}

/**
 * Validates billing address.
 */
export function validateBillingAddress(address: string): string | null {
  if (!address || address.trim().length === 0) return 'Address is required';
  if (address.trim().length < MIN_ADDRESS_LENGTH) return 'Address is too short';
  return null;
}

/**
 * Gets validation state for all card fields based on touched state.
 * Only returns errors/success for touched fields.
 */
export function getCardValidationState(
  fields: CardFields,
  touched: CardTouchedState
): CardValidationState {
  return {
    cardNumber: touched.cardNumber
      ? {
          error: validateCardNumber(fields.cardNumber),
          success:
            validateCardNumber(fields.cardNumber) === null && fields.cardNumber.length > 0
              ? 'Valid card'
              : undefined,
        }
      : { error: null, success: undefined },
    expiry: touched.expiry
      ? {
          error: validateExpiry(fields.expiry),
          success:
            validateExpiry(fields.expiry) === null && fields.expiry.length > 0
              ? 'Valid expiry'
              : undefined,
        }
      : { error: null, success: undefined },
    cvv: touched.cvv
      ? {
          error: validateCvv(fields.cvv),
          success:
            validateCvv(fields.cvv) === null && fields.cvv.length > 0 ? 'Valid CVV' : undefined,
        }
      : { error: null, success: undefined },
    cardHolderName: touched.cardHolderName
      ? {
          error: validateCardHolderName(fields.cardHolderName),
          success:
            validateCardHolderName(fields.cardHolderName) === null &&
            fields.cardHolderName.length > 0
              ? 'Valid name'
              : undefined,
        }
      : { error: null, success: undefined },
    billingAddress: touched.billingAddress
      ? {
          error: validateBillingAddress(fields.billingAddress),
          success:
            validateBillingAddress(fields.billingAddress) === null &&
            fields.billingAddress.length > 0
              ? 'Valid address'
              : undefined,
        }
      : { error: null, success: undefined },
    zipCode: touched.zipCode
      ? {
          error: validateZip(fields.zipCode),
          success:
            validateZip(fields.zipCode) === null && fields.zipCode.length > 0
              ? 'Valid ZIP'
              : undefined,
        }
      : { error: null, success: undefined },
  };
}

/**
 * Validates all card fields and returns whether all are valid.
 */
export function validateAllCardFields(fields: CardFields): boolean {
  const errors = {
    cardNumber: validateCardNumber(fields.cardNumber),
    expiry: validateExpiry(fields.expiry),
    cvv: validateCvv(fields.cvv),
    cardHolderName: validateCardHolderName(fields.cardHolderName),
    billingAddress: validateBillingAddress(fields.billingAddress),
    zipCode: validateZip(fields.zipCode),
  };

  return (
    !errors.cardNumber &&
    !errors.expiry &&
    !errors.cvv &&
    !errors.cardHolderName &&
    !errors.billingAddress &&
    !errors.zipCode
  );
}
