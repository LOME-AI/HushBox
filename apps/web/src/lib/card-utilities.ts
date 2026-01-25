/**
 * Card validation and formatting utilities.
 * Used for credit card input validation in payment forms.
 */

/**
 * Validates a card number using the Luhn algorithm.
 * Handles card numbers with spaces or other separators.
 *
 * @param cardNumber - The card number to validate
 * @returns true if the card number passes Luhn validation
 */
export function isValidLuhn(cardNumber: string): boolean {
  const digits = cardNumber.replaceAll(/\D/g, '');
  if (digits.length === 0) return false;

  let sum = 0;
  let isEven = false;

  for (let index = digits.length - 1; index >= 0; index--) {
    const char = digits[index];
    if (char === undefined) continue;
    let digit = Number.parseInt(char, 10);

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

/**
 * Formats a card number with spaces every 4 digits: "1234 5678 9012 3456"
 *
 * @param value - Raw card number input
 * @returns Formatted card number (max 19 characters)
 */
export function formatCardNumber(value: string): string {
  const cleaned = value.replaceAll(/\D/g, '');
  const groups = cleaned.match(/.{1,4}/g);
  return groups ? groups.join(' ').slice(0, 19) : '';
}

/**
 * Formats expiry date: "MM / YY"
 *
 * @param value - Raw expiry input
 * @returns Formatted expiry date
 */
export function formatExpiry(value: string): string {
  const cleaned = value.replaceAll(/\D/g, '');
  if (cleaned.length >= 3) {
    return `${cleaned.slice(0, 2)} / ${cleaned.slice(2, 4)}`;
  }
  return cleaned;
}

/**
 * Formats CVV: digits only, max 4
 *
 * @param value - Raw CVV input
 * @returns Formatted CVV (max 4 digits)
 */
export function formatCvv(value: string): string {
  return value.replaceAll(/\D/g, '').slice(0, 4);
}

/**
 * Formats ZIP code: alphanumeric only, max 10 characters.
 * Supports US ZIP codes and Canadian postal codes.
 *
 * @param value - Raw ZIP input
 * @returns Formatted ZIP code
 */
export function formatZip(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9]/g, '').slice(0, 10);
}

/**
 * Validates a card number.
 *
 * @param cardNumber - The card number to validate
 * @returns Error message or null if valid
 */
export function validateCardNumber(cardNumber: string): string | null {
  const cleaned = cardNumber.replaceAll(/\s/g, '');
  if (cleaned.length === 0) return 'Card number is required';
  if (cleaned.length < 13) return 'Card number must be at least 13 digits';
  if (cleaned.length > 19) return 'Card number is too long';
  if (!/^\d+$/.test(cleaned)) return 'Card number must contain only digits';
  if (!isValidLuhn(cleaned)) return 'Invalid card number';
  return null;
}

/**
 * Validates an expiry date (MM / YY format).
 *
 * @param expiry - The expiry date to validate
 * @returns Error message or null if valid
 */
export function validateExpiry(expiry: string): string | null {
  if (expiry.length === 0) return 'Expiry date is required';
  if (!/^\d{2}\s\/\s\d{2}$/.test(expiry)) return 'Format: MM / YY';

  const parts = expiry.split(' / ');
  const monthString = parts[0] ?? '';
  const yearString = parts[1] ?? '';
  const month = Number.parseInt(monthString, 10);
  const year = Number.parseInt(yearString, 10);

  if (month < 1 || month > 12) return 'Invalid month';

  const now = new Date();
  const currentYear = now.getFullYear() % 100;
  const currentMonth = now.getMonth() + 1;

  if (year < currentYear || (year === currentYear && month < currentMonth)) {
    return 'Card has expired';
  }

  return null;
}

/**
 * Validates a CVV code.
 *
 * @param cvv - The CVV to validate
 * @returns Error message or null if valid
 */
export function validateCvv(cvv: string): string | null {
  if (cvv.length === 0) return 'CVV is required';
  if (cvv.length < 3) return 'CVV must be 3-4 digits';
  if (!/^\d+$/.test(cvv)) return 'CVV must contain only digits';
  return null;
}

/**
 * Validates a ZIP code.
 *
 * @param zip - The ZIP code to validate
 * @returns Error message or null if valid
 */
export function validateZip(zip: string): string | null {
  if (zip.length === 0) return 'ZIP code is required';
  if (zip.length < 5) return 'ZIP code must be 5 digits';
  return null;
}
