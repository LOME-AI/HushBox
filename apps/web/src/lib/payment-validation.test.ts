import { describe, it, expect } from 'vitest';
import {
  validateAmount,
  validateCardHolderName,
  validateBillingAddress,
  getCardValidationState,
  validateAllCardFields,
  MIN_DEPOSIT_AMOUNT,
  MAX_DEPOSIT_AMOUNT,
} from './payment-validation.js';

describe('payment-validation', () => {
  describe('validateAmount', () => {
    it('returns error for empty value', () => {
      const result = validateAmount('');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter an amount');
    });

    it('returns error for non-numeric value', () => {
      const result = validateAmount('abc');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid amount');
    });

    it('returns error for amount below minimum', () => {
      const result = validateAmount('4.99');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe(`Minimum deposit is $${String(MIN_DEPOSIT_AMOUNT)}`);
    });

    it('returns error for amount above maximum', () => {
      const result = validateAmount('1001');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe(`Maximum deposit is $${String(MAX_DEPOSIT_AMOUNT)}`);
    });

    it('returns valid for minimum amount', () => {
      const result = validateAmount('5');
      expect(result.isValid).toBe(true);
      expect(result.success).toBe('Valid amount');
      expect(result.error).toBeUndefined();
    });

    it('returns valid for maximum amount', () => {
      const result = validateAmount('1000');
      expect(result.isValid).toBe(true);
      expect(result.success).toBe('Valid amount');
    });

    it('returns valid for amount in range', () => {
      const result = validateAmount('50.00');
      expect(result.isValid).toBe(true);
      expect(result.success).toBe('Valid amount');
    });
  });

  describe('validateCardHolderName', () => {
    it('returns error for empty name', () => {
      expect(validateCardHolderName('')).toBe('Name is required');
    });

    it('returns error for whitespace-only name', () => {
      expect(validateCardHolderName('   ')).toBe('Name is required');
    });

    it('returns error for name that is too short', () => {
      expect(validateCardHolderName('A')).toBe('Name is too short');
    });

    it('returns error for name with invalid characters', () => {
      expect(validateCardHolderName('John123')).toBe('Name contains invalid characters');
      expect(validateCardHolderName('John@Doe')).toBe('Name contains invalid characters');
    });

    it('returns null for valid name', () => {
      expect(validateCardHolderName('John Smith')).toBeNull();
    });

    it('allows hyphens in name', () => {
      expect(validateCardHolderName('Mary-Jane Watson')).toBeNull();
    });

    it('allows apostrophes in name', () => {
      expect(validateCardHolderName("O'Connor")).toBeNull();
    });

    it('allows periods in name', () => {
      expect(validateCardHolderName('Dr. John Smith')).toBeNull();
    });
  });

  describe('validateBillingAddress', () => {
    it('returns error for empty address', () => {
      expect(validateBillingAddress('')).toBe('Address is required');
    });

    it('returns error for whitespace-only address', () => {
      expect(validateBillingAddress('   ')).toBe('Address is required');
    });

    it('returns error for address that is too short', () => {
      expect(validateBillingAddress('123')).toBe('Address is too short');
    });

    it('returns null for valid address', () => {
      expect(validateBillingAddress('123 Main Street')).toBeNull();
    });

    it('returns null for minimum length address', () => {
      expect(validateBillingAddress('12345')).toBeNull();
    });
  });

  describe('getCardValidationState', () => {
    const cardFields = {
      cardNumber: '4111 1111 1111 1111',
      expiry: '12 / 30',
      cvv: '123',
      cardHolderName: 'John Smith',
      billingAddress: '123 Main Street',
      zipCode: '12345',
    };

    const allTouched = {
      cardNumber: true,
      expiry: true,
      cvv: true,
      cardHolderName: true,
      billingAddress: true,
      zipCode: true,
    };

    const noneTouched = {
      cardNumber: false,
      expiry: false,
      cvv: false,
      cardHolderName: false,
      billingAddress: false,
      zipCode: false,
    };

    it('returns no errors when fields not touched', () => {
      const result = getCardValidationState(cardFields, noneTouched);

      expect(result.cardNumber.error).toBeNull();
      expect(result.expiry.error).toBeNull();
      expect(result.cvv.error).toBeNull();
      expect(result.cardHolderName.error).toBeNull();
      expect(result.billingAddress.error).toBeNull();
      expect(result.zipCode.error).toBeNull();
    });

    it('returns no success messages when fields not touched', () => {
      const result = getCardValidationState(cardFields, noneTouched);

      expect(result.cardNumber.success).toBeUndefined();
      expect(result.expiry.success).toBeUndefined();
      expect(result.cvv.success).toBeUndefined();
      expect(result.cardHolderName.success).toBeUndefined();
      expect(result.billingAddress.success).toBeUndefined();
      expect(result.zipCode.success).toBeUndefined();
    });

    it('returns success messages for valid touched fields', () => {
      const result = getCardValidationState(cardFields, allTouched);

      expect(result.cardNumber.error).toBeNull();
      expect(result.cardNumber.success).toBe('Valid card');
      expect(result.expiry.success).toBe('Valid expiry');
      expect(result.cvv.success).toBe('Valid CVV');
      expect(result.cardHolderName.success).toBe('Valid name');
      expect(result.billingAddress.success).toBe('Valid address');
      expect(result.zipCode.success).toBe('Valid ZIP');
    });

    it('returns errors for invalid touched fields', () => {
      const invalidFields = {
        cardNumber: '1234',
        expiry: '13/99',
        cvv: '1',
        cardHolderName: '',
        billingAddress: '',
        zipCode: '',
      };

      const result = getCardValidationState(invalidFields, allTouched);

      expect(result.cardNumber.error).toBeTruthy();
      expect(result.expiry.error).toBeTruthy();
      expect(result.cvv.error).toBeTruthy();
      expect(result.cardHolderName.error).toBeTruthy();
      expect(result.billingAddress.error).toBeTruthy();
      expect(result.zipCode.error).toBeTruthy();
    });

    it('validates only touched fields', () => {
      const invalidFields = {
        cardNumber: '1234',
        expiry: '13/99',
        cvv: '1',
        cardHolderName: '',
        billingAddress: '',
        zipCode: '',
      };

      const partialTouched = {
        cardNumber: true,
        expiry: false,
        cvv: true,
        cardHolderName: false,
        billingAddress: true,
        zipCode: false,
      };

      const result = getCardValidationState(invalidFields, partialTouched);

      expect(result.cardNumber.error).toBeTruthy();
      expect(result.expiry.error).toBeNull();
      expect(result.cvv.error).toBeTruthy();
      expect(result.cardHolderName.error).toBeNull();
      expect(result.billingAddress.error).toBeTruthy();
      expect(result.zipCode.error).toBeNull();
    });
  });

  describe('validateAllCardFields', () => {
    it('returns true for all valid fields', () => {
      const validFields = {
        cardNumber: '4111 1111 1111 1111',
        expiry: '12 / 30',
        cvv: '123',
        cardHolderName: 'John Smith',
        billingAddress: '123 Main Street',
        zipCode: '12345',
      };

      expect(validateAllCardFields(validFields)).toBe(true);
    });

    it('returns false if card number is invalid', () => {
      const fields = {
        cardNumber: '1234',
        expiry: '12 / 30',
        cvv: '123',
        cardHolderName: 'John Smith',
        billingAddress: '123 Main Street',
        zipCode: '12345',
      };

      expect(validateAllCardFields(fields)).toBe(false);
    });

    it('returns false if expiry is invalid', () => {
      const fields = {
        cardNumber: '4111 1111 1111 1111',
        expiry: '13 / 99',
        cvv: '123',
        cardHolderName: 'John Smith',
        billingAddress: '123 Main Street',
        zipCode: '12345',
      };

      expect(validateAllCardFields(fields)).toBe(false);
    });

    it('returns false if CVV is invalid', () => {
      const fields = {
        cardNumber: '4111 1111 1111 1111',
        expiry: '12 / 30',
        cvv: '1',
        cardHolderName: 'John Smith',
        billingAddress: '123 Main Street',
        zipCode: '12345',
      };

      expect(validateAllCardFields(fields)).toBe(false);
    });

    it('returns false if cardholder name is invalid', () => {
      const fields = {
        cardNumber: '4111 1111 1111 1111',
        expiry: '12 / 30',
        cvv: '123',
        cardHolderName: '',
        billingAddress: '123 Main Street',
        zipCode: '12345',
      };

      expect(validateAllCardFields(fields)).toBe(false);
    });

    it('returns false if billing address is invalid', () => {
      const fields = {
        cardNumber: '4111 1111 1111 1111',
        expiry: '12 / 30',
        cvv: '123',
        cardHolderName: 'John Smith',
        billingAddress: '',
        zipCode: '12345',
      };

      expect(validateAllCardFields(fields)).toBe(false);
    });

    it('returns false if ZIP code is invalid', () => {
      const fields = {
        cardNumber: '4111 1111 1111 1111',
        expiry: '12 / 30',
        cvv: '123',
        cardHolderName: 'John Smith',
        billingAddress: '123 Main Street',
        zipCode: '',
      };

      expect(validateAllCardFields(fields)).toBe(false);
    });
  });
});
