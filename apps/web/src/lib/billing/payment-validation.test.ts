import { describe, it, expect } from 'vitest';
import { dollarsToNanoUsd } from '@hushbox/shared';
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

    it('validates "5.11" as $5.11 (not $511)', () => {
      const result = validateAmount('5.11');
      expect(result.isValid).toBe(true);
      expect(Number.parseFloat('5.11').toFixed(2)).toBe('5.11');
    });

    it('validates "10.99" correctly', () => {
      const result = validateAmount('10.99');
      expect(result.isValid).toBe(true);
    });

    it('rejects "5.111" with 3 decimal places', () => {
      const result = validateAmount('5.111');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Amount cannot have more than 2 decimal places');
    });

    it('rejects "5.119" with 3 decimal places', () => {
      const result = validateAmount('5.119');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Amount cannot have more than 2 decimal places');
    });

    it('rejects "5.1111" with 4 decimal places', () => {
      const result = validateAmount('5.1111');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Amount cannot have more than 2 decimal places');
    });

    it('rejects "99.999" with 3 decimal places', () => {
      const result = validateAmount('99.999');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Amount cannot have more than 2 decimal places');
    });

    it('rejects "999.999" with 3 decimal places', () => {
      const result = validateAmount('999.999');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Amount cannot have more than 2 decimal places');
    });

    it('rejects "1000.001" with 3 decimal places', () => {
      const result = validateAmount('1000.001');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Amount cannot have more than 2 decimal places');
    });

    // The decimal-place message is reserved for a value that is an amount but
    // for its precision. A string that is not an amount at all gets the generic
    // refusal, however many characters trail its dot: telling someone who typed
    // letters that their decimals are the problem sends them to fix the wrong
    // thing.
    it.each(['abc.999', '5.9.99', '5.99abc', 'e.111', '.9 9 9'])(
      'refuses "%s" as an invalid amount, not as an over-precise one',
      (value) => {
        const result = validateAmount(value);
        expect(result.isValid).toBe(false);
        expect(result.error).toBe('Please enter a valid amount');
      }
    );

    // The decomposition behind that message must admit everything the shared
    // grammar admits. The grammar's leading `\s*` covers line terminators, and a
    // regex `.` excludes exactly those, so an amount faulted only on precision
    // would be told its whole shape was wrong depending on which whitespace
    // character preceded it.
    it.each(['\n5.999', '\r5.999', '\u20285.999', '\u20295.999', '\n.555', '\r\n5.100'])(
      'names precision as the fault in %j, led by a line terminator',
      (value) => {
        const result = validateAmount(value);
        expect(result.isValid).toBe(false);
        expect(result.error).toBe('Amount cannot have more than 2 decimal places');
      }
    );

    it('handles leading zeros "05.11"', () => {
      const result = validateAmount('05.11');
      expect(result.isValid).toBe(true);
    });

    it('handles leading zeros "005.00"', () => {
      const result = validateAmount('005.00');
      expect(result.isValid).toBe(true);
    });

    it('rejects "4.999" with 3 decimal places', () => {
      const result = validateAmount('4.999');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Amount cannot have more than 2 decimal places');
    });

    it('accepts "5.00" at exact minimum', () => {
      const result = validateAmount('5.00');
      expect(result.isValid).toBe(true);
    });

    it('rejects "5.001" with 3 decimal places', () => {
      const result = validateAmount('5.001');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Amount cannot have more than 2 decimal places');
    });

    it('accepts "1000.00" at exact maximum', () => {
      const result = validateAmount('1000.00');
      expect(result.isValid).toBe(true);
    });

    it('rejects "1000.01" just above maximum', () => {
      const result = validateAmount('1000.01');
      expect(result.isValid).toBe(false);
    });

    // The amount the user types is priced by `dollarsToNanoUsd`, which splits on
    // the dot and hands each half to `BigInt`. A float parse cannot stand in for
    // that grammar: it stops at the first character it cannot read, so every
    // string below looks numeric to it and throws in the converter.
    it.each(['5e2', '1e1', '1E1', '5e0', '1e3', '50abc', '5e2abc', '5.e1', '50,00', '5 0'])(
      'rejects "%s", which the exact-cent converter refuses',
      (value) => {
        expect(() => dollarsToNanoUsd(value)).toThrow();

        const result = validateAmount(value);
        expect(result.isValid).toBe(false);
        expect(result.error).toBe('Please enter a valid amount');
      }
    );

    it('rejects a fraction followed by whitespace, which the converter refuses', () => {
      // The converter's fraction half is `${fraction}00`.slice(0, 2), so a space
      // carried into the fraction would shift a digit out of it and price "5.5\n"
      // as $5.05 against text reading $5.50. The converter refuses the shape
      // outright rather than pricing it, and this validator refuses it before
      // the field ever reaches one.
      expect(() => dollarsToNanoUsd('5.5\n')).toThrow();

      const result = validateAmount('5.5\n');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid amount');
    });

    it('rejects "5..0", which the converter refuses for having a second dot', () => {
      expect(() => dollarsToNanoUsd('5..0')).toThrow();

      const result = validateAmount('5..0');
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid amount');
    });

    // Trailing whitespace is refused whether or not a fraction is present: one
    // rule, so the accepted set never depends on the deposit bounds to stay
    // priceable.
    it.each(['50  ', '5.  '])('rejects "%s": nothing may follow the amount', (value) => {
      const result = validateAmount(value);
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Please enter a valid amount');
    });

    it.each([
      ['5', '5000000000'],
      ['10.99', '10990000000'],
      ['50.00', '50000000000'],
      ['+50', '50000000000'],
      ['  50', '50000000000'],
      ['5.', '5000000000'],
      ['005', '5000000000'],
      ['05.11', '5110000000'],
      ['5.5', '5500000000'],
      ['+5.50', '5500000000'],
      ['0005.50', '5500000000'],
      ['1000', '1000000000000'],
      ['1000.00', '1000000000000'],
    ])('admits "%s", which the exact-cent converter prices as %s', (value, nanoUsd) => {
      expect(validateAmount(value).isValid).toBe(true);
      expect(dollarsToNanoUsd(value)).toBe(nanoUsd);
    });

    // The fixtures above cover the shapes someone thought of; this covers the
    // ones nobody did, which is how the gap arose. `readsAs` is not a second
    // converter — it is the specification of the field, the amount a person
    // reading the text would name — and every value the validator admits must
    // price to exactly that. It reads each digit for itself and takes the
    // fraction from its length rather than by padding and slicing: a checker
    // built from the converter's own expression would carry a wrong truncation
    // rule into the expectation and stay green on it.
    it('prices every admitted string in a brute-forced corpus exactly as its text reads', () => {
      const alphabet = ['0', '5', '.', '+', '-', 'e', 'a', ' ', '\n', ','];
      let corpus = [''];
      const words: string[] = [];
      for (let length = 0; length < 4; length++) {
        corpus = corpus.flatMap((word) => alphabet.map((character) => word + character));
        words.push(...corpus);
      }

      const readsAs = (text: string): string => {
        const [whole = '', fraction = ''] = text.trim().replace(/^\+/, '').split('.');
        const valueOf = (digit: string): bigint => BigInt('0123456789'.indexOf(digit));
        let dollars = 0n;
        for (let index = 0; index < whole.length; index++) {
          dollars = dollars * 10n + valueOf(whole.charAt(index));
        }
        const tenths = fraction.length > 0 ? valueOf(fraction.charAt(0)) : 0n;
        const hundredths = fraction.length > 1 ? valueOf(fraction.charAt(1)) : 0n;
        const cents = dollars * 100n + tenths * 10n + hundredths;
        return (cents * 10_000_000n).toString();
      };

      const admitted = words.filter((word) => validateAmount(word).isValid);
      const mispriced = admitted.filter((word) => {
        try {
          return dollarsToNanoUsd(word) !== readsAs(word);
        } catch {
          return true;
        }
      });

      expect(admitted.length).toBeGreaterThan(0);
      expect(mispriced).toEqual([]);
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

    it('allows accented Latin letters in name', () => {
      expect(validateCardHolderName('José Müller')).toBeNull();
    });

    it('allows a name written with combining marks', () => {
      // "José" composed as J-o-s-e + U+0301 combining acute, the form a macOS
      // keyboard produces; a letters-only class rejects the bare mark.
      expect(validateCardHolderName('José')).toBeNull();
    });

    it('allows a name in a non-Latin script', () => {
      expect(validateCardHolderName('田中太郎')).toBeNull();
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
