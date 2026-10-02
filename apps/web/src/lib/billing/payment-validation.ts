import { MAX_DEPOSIT_USD, MIN_DEPOSIT_USD, PRICEABLE_AMOUNT } from '@hushbox/shared';
import { validateCardNumber, validateExpiry, validateCvv, validateZip } from './card-utilities.js';

export const MIN_DEPOSIT_AMOUNT = MIN_DEPOSIT_USD;
export const MAX_DEPOSIT_AMOUNT = MAX_DEPOSIT_USD;
const MIN_NAME_LENGTH = 2;
const MIN_ADDRESS_LENGTH = 5;

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
 * An amount carrying digits past the cent, captured as the same amount shortened
 * to a whole cent. Matching is not the verdict — {@link PRICEABLE_AMOUNT} rules
 * on the capture, so this stays a decomposition and never becomes a second copy
 * of the amount format. The trailing `\d+` is what keeps `5.99abc` out: only
 * digits may follow the cent.
 *
 * The head is `[\s\S]*` rather than `.*` because `.` excludes line terminators
 * while {@link PRICEABLE_AMOUNT}'s leading `\s*` admits them: with a `.` head,
 * whether an over-precise amount earned this decomposition would turn on which
 * whitespace character preceded it.
 */
const OVER_PRECISE_AMOUNT = /^([\s\S]*\.\d{2})\d+$/;

export function validateAmount(value: string): AmountValidation {
  if (!value) {
    return { isValid: false, error: 'Please enter an amount' };
  }

  if (!PRICEABLE_AMOUNT.test(value)) {
    // Over-precision earns its own message, but only where it is the sole
    // reason the grammar refused: shorten the fraction to a whole cent and ask
    // the same grammar again. Answering before the grammar has spoken would
    // name decimals as the fault in a string that is not an amount at all, and
    // send the user to fix the wrong thing.
    const shortened = OVER_PRECISE_AMOUNT.exec(value)?.[1];
    if (shortened !== undefined && PRICEABLE_AMOUNT.test(shortened)) {
      return { isValid: false, error: 'Amount cannot have more than 2 decimal places' };
    }
    return { isValid: false, error: 'Please enter a valid amount' };
  }

  // Range only. {@link PRICEABLE_AMOUNT} guarantees at least one digit, so this
  // is never NaN, and no money value is derived from it.
  const numberValue = Number.parseFloat(value);

  if (numberValue < MIN_DEPOSIT_AMOUNT) {
    return { isValid: false, error: `Minimum deposit is $${String(MIN_DEPOSIT_AMOUNT)}` };
  }

  if (numberValue > MAX_DEPOSIT_AMOUNT) {
    return { isValid: false, error: `Maximum deposit is $${String(MAX_DEPOSIT_AMOUNT)}` };
  }

  return { isValid: true, success: 'Valid amount' };
}

export function validateCardHolderName(name: string): string | null {
  if (!name || name.trim().length === 0) return 'Name is required';
  if (name.trim().length < MIN_NAME_LENGTH) return 'Name is too short';
  // Letters plus combining marks, so accented and non-Latin names pass: an
  // ASCII-only class hard-blocks the only credit-loading path for them.
  if (!/^[\p{L}\p{M}\s\-'.]+$/u.test(name)) return 'Name contains invalid characters';
  return null;
}

export function validateBillingAddress(address: string): string | null {
  if (!address || address.trim().length === 0) return 'Address is required';
  if (address.trim().length < MIN_ADDRESS_LENGTH) return 'Address is too short';
  return null;
}

function getFieldValidation(
  value: string,
  touched: boolean,
  validate: (v: string) => string | null,
  successMessage: string
): FieldValidationState {
  if (!touched) {
    return { error: null, success: undefined };
  }
  const error = validate(value);
  return {
    error,
    success: error === null && value.length > 0 ? successMessage : undefined,
  };
}

export function getCardValidationState(
  fields: CardFields,
  touched: CardTouchedState
): CardValidationState {
  return {
    cardNumber: getFieldValidation(
      fields.cardNumber,
      touched.cardNumber,
      validateCardNumber,
      'Valid card'
    ),
    expiry: getFieldValidation(fields.expiry, touched.expiry, validateExpiry, 'Valid expiry'),
    cvv: getFieldValidation(fields.cvv, touched.cvv, validateCvv, 'Valid CVV'),
    cardHolderName: getFieldValidation(
      fields.cardHolderName,
      touched.cardHolderName,
      validateCardHolderName,
      'Valid name'
    ),
    billingAddress: getFieldValidation(
      fields.billingAddress,
      touched.billingAddress,
      validateBillingAddress,
      'Valid address'
    ),
    zipCode: getFieldValidation(fields.zipCode, touched.zipCode, validateZip, 'Valid ZIP'),
  };
}

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
