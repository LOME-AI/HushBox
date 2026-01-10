import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePaymentForm } from './use-payment-form.js';

describe('usePaymentForm', () => {
  describe('initial state', () => {
    it('initializes with empty values', () => {
      const { result } = renderHook(() => usePaymentForm());

      expect(result.current.amount).toBe('');
      expect(result.current.cardNumber).toBe('');
      expect(result.current.expiry).toBe('');
      expect(result.current.cvv).toBe('');
      expect(result.current.zipCode).toBe('');
    });

    it('initializes with untouched state', () => {
      const { result } = renderHook(() => usePaymentForm());

      expect(result.current.amountTouched).toBe(false);
      expect(result.current.cardTouched.cardNumber).toBe(false);
      expect(result.current.cardTouched.expiry).toBe(false);
      expect(result.current.cardTouched.cvv).toBe(false);
      expect(result.current.cardTouched.zipCode).toBe(false);
    });

    it('has no validation errors initially', () => {
      const { result } = renderHook(() => usePaymentForm());

      expect(result.current.amountValidation.isValid).toBe(false);
      expect(result.current.amountValidation.error).toBeUndefined();
      expect(result.current.cardValidation.cardNumber.error).toBeNull();
      expect(result.current.cardValidation.expiry.error).toBeNull();
      expect(result.current.cardValidation.cvv.error).toBeNull();
      expect(result.current.cardValidation.zipCode.error).toBeNull();
    });
  });

  describe('amount handling', () => {
    it('updates amount value', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      expect(result.current.amount).toBe('50');
    });

    it('marks amount as touched on change', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      expect(result.current.amountTouched).toBe(true);
    });

    it('validates amount after touch', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      expect(result.current.amountValidation.isValid).toBe(true);
      expect(result.current.amountValidation.success).toBe('Valid amount');
    });

    it('shows error for invalid amount', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('2');
      });

      expect(result.current.amountValidation.isValid).toBe(false);
      expect(result.current.amountValidation.error).toBe('Minimum deposit is $5');
    });
  });

  describe('card number handling', () => {
    it('updates and formats card number', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleCardNumberChange('4111111111111111');
      });

      expect(result.current.cardNumber).toBe('4111 1111 1111 1111');
    });

    it('marks card number as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleCardNumberChange('4111');
      });

      expect(result.current.cardTouched.cardNumber).toBe(true);
    });

    it('validates valid card number', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleCardNumberChange('4111111111111111');
      });

      expect(result.current.cardValidation.cardNumber.error).toBeNull();
      expect(result.current.cardValidation.cardNumber.success).toBe('Valid card');
    });
  });

  describe('expiry handling', () => {
    it('updates and formats expiry', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleExpiryChange('1230');
      });

      expect(result.current.expiry).toBe('12 / 30');
    });

    it('marks expiry as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleExpiryChange('12');
      });

      expect(result.current.cardTouched.expiry).toBe(true);
    });
  });

  describe('CVV handling', () => {
    it('updates and formats CVV', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleCvvChange('1234');
      });

      expect(result.current.cvv).toBe('1234');
    });

    it('marks CVV as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleCvvChange('123');
      });

      expect(result.current.cardTouched.cvv).toBe(true);
    });
  });

  describe('ZIP code handling', () => {
    it('updates and formats ZIP code', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleZipChange('12345');
      });

      expect(result.current.zipCode).toBe('12345');
    });

    it('marks ZIP code as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleZipChange('12345');
      });

      expect(result.current.cardTouched.zipCode).toBe(true);
    });
  });

  describe('touchAllFields', () => {
    it('marks all fields as touched', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.touchAllFields();
      });

      expect(result.current.amountTouched).toBe(true);
      expect(result.current.cardTouched.cardNumber).toBe(true);
      expect(result.current.cardTouched.expiry).toBe(true);
      expect(result.current.cardTouched.cvv).toBe(true);
      expect(result.current.cardTouched.zipCode).toBe(true);
    });
  });

  describe('validateAll', () => {
    it('returns false when form is empty', () => {
      const { result } = renderHook(() => usePaymentForm());

      let isValid = false;
      act(() => {
        isValid = result.current.validateAll();
      });

      expect(isValid).toBe(false);
    });

    it('returns false when only amount is valid', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      let isValid = false;
      act(() => {
        isValid = result.current.validateAll();
      });

      expect(isValid).toBe(false);
    });

    it('returns true when all fields are valid', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
        result.current.handleCardNumberChange('4111111111111111');
        result.current.handleExpiryChange('1230');
        result.current.handleCvvChange('123');
        result.current.handleZipChange('12345');
      });

      let isValid = false;
      act(() => {
        isValid = result.current.validateAll();
      });

      expect(isValid).toBe(true);
    });

    it('touches all fields when validating', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.validateAll();
      });

      expect(result.current.amountTouched).toBe(true);
      expect(result.current.cardTouched.cardNumber).toBe(true);
    });
  });

  describe('reset', () => {
    it('resets all values to initial state', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
        result.current.handleCardNumberChange('4111111111111111');
        result.current.handleExpiryChange('1230');
        result.current.handleCvvChange('123');
        result.current.handleZipChange('12345');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.amount).toBe('');
      expect(result.current.cardNumber).toBe('');
      expect(result.current.expiry).toBe('');
      expect(result.current.cvv).toBe('');
      expect(result.current.zipCode).toBe('');
    });

    it('resets touched state', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleAmountChange('50');
      });

      act(() => {
        result.current.reset();
      });

      expect(result.current.amountTouched).toBe(false);
      expect(result.current.cardTouched.cardNumber).toBe(false);
    });
  });

  describe('cardFields getter', () => {
    it('returns all card fields', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleCardNumberChange('4111111111111111');
        result.current.handleExpiryChange('1230');
        result.current.handleCvvChange('123');
        result.current.handleZipChange('12345');
      });

      expect(result.current.cardFields).toEqual({
        cardNumber: '4111 1111 1111 1111',
        expiry: '12 / 30',
        cvv: '123',
        zipCode: '12345',
      });
    });
  });

  describe('expiryParts getter', () => {
    it('returns month and year from expiry', () => {
      const { result } = renderHook(() => usePaymentForm());

      act(() => {
        result.current.handleExpiryChange('1230');
      });

      expect(result.current.expiryParts).toEqual({ month: '12', year: '30' });
    });

    it('returns empty strings for invalid expiry', () => {
      const { result } = renderHook(() => usePaymentForm());

      expect(result.current.expiryParts).toEqual({ month: '', year: '' });
    });
  });
});
