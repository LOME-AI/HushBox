import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  NanoUSD,
  NANO_USD_PER_CENT,
  nanoUSD,
  nanoUsdToCents,
  nanoUsdToDollarString,
  centsToNanoUsd,
  dollarsToCents,
  dollarsToNanoUsd,
  parseNanoUSD,
  PRICEABLE_AMOUNT,
  serializeNanoUSD,
  nanoUsdToFullDollarString,
} from './nano-usd.ts';

describe('NanoUSD schema', () => {
  it('parses a decimal string into a bigint', () => {
    expect(NanoUSD.parse('1500000000')).toBe(1_500_000_000n);
  });

  it('parses a negative decimal string', () => {
    expect(NanoUSD.parse('-42')).toBe(-42n);
  });

  it('parses zero', () => {
    expect(NanoUSD.parse('0')).toBe(0n);
  });

  it('parses values beyond Number.MAX_SAFE_INTEGER without precision loss', () => {
    expect(NanoUSD.parse('9007199254740993')).toBe(9_007_199_254_740_993n);
  });

  it('rejects a bigint input (wire format is string-only)', () => {
    expect(NanoUSD.safeParse(123n).success).toBe(false);
  });

  it('rejects a number input', () => {
    expect(NanoUSD.safeParse(123).success).toBe(false);
  });

  it('rejects a decimal-point string', () => {
    expect(NanoUSD.safeParse('1.5').success).toBe(false);
  });

  it('rejects leading zeros', () => {
    expect(NanoUSD.safeParse('007').success).toBe(false);
  });

  it('rejects negative zero', () => {
    expect(NanoUSD.safeParse('-0').success).toBe(false);
  });

  it('rejects an explicit plus sign', () => {
    expect(NanoUSD.safeParse('+5').success).toBe(false);
  });

  it('rejects the empty string', () => {
    expect(NanoUSD.safeParse('').success).toBe(false);
  });

  it('rejects non-numeric strings', () => {
    expect(NanoUSD.safeParse('12a3').success).toBe(false);
  });
});

describe('nanoUSD', () => {
  it('brands a raw bigint', () => {
    const value = nanoUSD(7n);
    expect(value).toBe(7n);
  });
});

describe('NanoUSD brand (compile-time)', () => {
  // If the brand ever eroded (plain bigint became assignable), the directive
  // would be flagged unused and `pnpm typecheck` would fail.
  it('rejects a plain bigint where NanoUSD is expected', () => {
    // @ts-expect-error — unbranded bigint is not assignable to NanoUSD
    const serialized = serializeNanoUSD(7n);
    expect(serialized).toBe('7');
  });
});

describe('serializeNanoUSD', () => {
  it('serializes to a decimal string', () => {
    expect(serializeNanoUSD(nanoUSD(1_500_000_000n))).toBe('1500000000');
  });

  it('serializes negative values', () => {
    expect(serializeNanoUSD(nanoUSD(-42n))).toBe('-42');
  });
});

describe('parseNanoUSD', () => {
  it('returns the branded bigint for a valid string', () => {
    expect(parseNanoUSD('99')).toBe(99n);
  });

  it('throws on an invalid string', () => {
    expect(() => parseNanoUSD('1.5')).toThrow();
  });
});

describe('nanoUsdToCents', () => {
  it('converts one cent of nano-USD to 1 cent', () => {
    expect(nanoUsdToCents('10000000')).toBe(1);
  });

  it('converts a whole-dollar amount to cents', () => {
    // $50.00 = 5_000 cents = 5e10 nano
    expect(nanoUsdToCents('50000000000')).toBe(5000);
  });

  it('is negative-capable', () => {
    expect(nanoUsdToCents('-5000000000')).toBe(-500);
  });

  it('truncates sub-cent nano toward zero', () => {
    // 1 cent + 999_999 nano (< 1 cent) → 1 cent
    expect(nanoUsdToCents('10999999')).toBe(1);
  });

  it('is zero for zero', () => {
    expect(nanoUsdToCents('0')).toBe(0);
  });
});

describe('nanoUsdToDollarString', () => {
  it('formats a whole-dollar amount with two decimals', () => {
    expect(nanoUsdToDollarString('50000000000')).toBe('50.00');
  });

  it('formats a cents-precise amount', () => {
    // $42.50 = 4_250 cents = 4.25e10 nano
    expect(nanoUsdToDollarString('42500000000')).toBe('42.50');
  });

  it('formats a negative amount with a leading minus', () => {
    expect(nanoUsdToDollarString('-25000000000')).toBe('-25.00');
  });

  it('pads single-digit cents', () => {
    // $10.05 = 1_005 cents = 1.005e10 nano
    expect(nanoUsdToDollarString('10050000000')).toBe('10.05');
  });

  it('truncates sub-cent precision for display', () => {
    // $8.00 + 999_999 nano (< 1 cent) → "8.00"
    expect(nanoUsdToDollarString('8000999999')).toBe('8.00');
  });

  it('formats zero', () => {
    expect(nanoUsdToDollarString('0')).toBe('0.00');
  });
});

/**
 * Canonical wire strings: the base-ten rendering of any amount, which is a
 * leading `-` on the negatives, no sign on zero, and no other spelling. Drawn
 * from the amount rather than assembled from a sign and a magnitude, so `-0`
 * — which is not a canonical string and which the codec never emits — cannot
 * enter the draw.
 */
const canonicalStrings = fc.bigInt().map((amount) => amount.toString(10));

describe('the nano-USD wire codec, read from the string side', () => {
  it('formats back every canonical string it parses', () => {
    fc.assert(
      fc.property(canonicalStrings, (canonical) => {
        expect(serializeNanoUSD(parseNanoUSD(canonical))).toBe(canonical);
      })
    );
  });
});

describe('NANO_USD_PER_CENT', () => {
  it('is 10^7 nano-USD per cent', () => {
    expect(NANO_USD_PER_CENT).toBe(10_000_000n);
  });
});

/** Every string up to four characters over an alphabet of the shapes a money
 *  field can receive: digits, both separators, both signs, whitespace, and the
 *  characters that read as numeric to a float parse but not to `BigInt`. */
function moneyCorpus(): string[] {
  const alphabet = ['0', '5', '9', '.', '+', '-', ' ', '\n', '\t', 'e', 'a', ','];
  const words: string[] = [''];
  let frontier = [''];
  for (let length = 0; length < 4; length++) {
    frontier = frontier.flatMap((word) => alphabet.map((character) => word + character));
    words.push(...frontier);
  }
  return words;
}

describe('dollarsToCents', () => {
  // The two hand-rolled web parsers this replaces. `budgetParseFloat` is the
  // budget-settings modal's `Math.round(parseFloat * 100)`; `paymentBigintSplit`
  // is the payment form's integer split. Byte-identity across the validated
  // money domain is the consolidation invariant.
  const budgetParseFloat = (d: string): number => Math.round(Number.parseFloat(d) * 100);
  const paymentBigintSplit = (amount: string): bigint => {
    const [whole = '0', fraction = ''] = amount.split('.');
    const wholeDigits = whole.length > 0 ? whole : '0';
    return BigInt(wholeDigits) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  };

  it.each([
    ['0.10', 10],
    ['5.00', 500],
    ['10.99', 1099],
    ['0.1', 10],
    ['5.5', 550],
    ['5.05', 505],
    ['0.29', 29],
    ['1000', 100_000],
    ['0', 0],
    ['0.00', 0],
    ['.5', 50],
    ['5.', 500],
  ])('parses %j to %d cents with no float drift', (input, expected) => {
    expect(dollarsToCents(input)).toBe(expected);
  });

  it('matches both prior web parsers across the validated money domain', () => {
    for (const d of ['0.10', '5.00', '10.99', '0.1', '5.5', '5.05', '0.29', '1000', '0', '0.00']) {
      expect(dollarsToCents(d)).toBe(budgetParseFloat(d));
      expect(BigInt(dollarsToCents(d))).toBe(paymentBigintSplit(d));
    }
  });

  // The fraction half is padded and sliced to two characters, so a whitespace
  // character occupies a digit slot and `BigInt` tolerates it: "5.5\n" priced
  // as $5.05 against text reading $5.50, with no error anywhere.
  it.each(['5.5\n', '5.5 ', '5.5\t', '0.1 ', '1.1\n', '10.99 '])(
    'refuses %j rather than pricing it a digit short',
    (input) => {
      expect(() => dollarsToCents(input)).toThrow();
    }
  );

  // Each of these priced silently to a figure the text does not name: the empty
  // string and a bare dot to zero, a second dot to whatever precedes the first,
  // and a leading minus to a negative amount no deposit grammar admits.
  it.each(['', '.', '5..0', '-5', '5.5.5'])(
    'refuses %j, which it cannot price exactly',
    (input) => {
      expect(() => dollarsToCents(input)).toThrow();
    }
  );

  // A cent has two digits; a third names precision the unit cannot hold. Pricing
  // such a string means discarding the digits past the second — $5.999 charged
  // as $5.99 — which is a different amount than the text names, so the grammar
  // refuses the shape. It refuses on the shape alone: a third digit of zero
  // discards nothing, and is still refused, because a rule that admitted it
  // would decide priceability from the digits rather than from the format.
  it.each(['5.999', '0.001', '.555', '10.9999', '5.100'])(
    'refuses %j rather than pricing away the digits past the second',
    (input) => {
      expect(() => dollarsToCents(input)).toThrow();
    }
  );

  it('refuses every string outside its grammar across a brute-forced corpus', () => {
    const outside = moneyCorpus().filter((word) => !PRICEABLE_AMOUNT.test(word));
    const silentlyPriced = outside.filter((word) => {
      try {
        dollarsToCents(word);
        return true;
      } catch {
        return false;
      }
    });

    expect(outside.length).toBeGreaterThan(0);
    expect(silentlyPriced).toEqual([]);
  });

  // The fixtures above cover the shapes someone thought of; this covers the ones
  // nobody did, which is how the mispricing survived four readings of this
  // function. `readsAs` is not a second converter — it is the specification, the
  // amount a person reading the text would name. It reads each digit for itself,
  // taking the tenths and hundredths characters and no third: it shares the
  // grammar's two-digit bound, and that bound is pinned by the `refuses … rather
  // than pricing away the digits past the second` fixtures, which is where a
  // change to it is proved. It stays in bigint so the converter's `Number`
  // coercion does not sit on both sides of the comparison.
  it('prices every string inside its grammar exactly as the text reads', () => {
    const readsAs = (text: string): bigint => {
      const [whole = '', fraction = ''] = text.trim().replace(/^\+/, '').split('.');
      const valueOf = (digit: string): bigint => BigInt('0123456789'.indexOf(digit));
      let dollars = 0n;
      for (let index = 0; index < whole.length; index++) {
        dollars = dollars * 10n + valueOf(whole.charAt(index));
      }
      const tenths = fraction.length > 0 ? valueOf(fraction.charAt(0)) : 0n;
      const hundredths = fraction.length > 1 ? valueOf(fraction.charAt(1)) : 0n;
      return dollars * 100n + tenths * 10n + hundredths;
    };

    const inside = moneyCorpus().filter((word) => PRICEABLE_AMOUNT.test(word));
    const mispriced = inside.filter((word) => {
      try {
        return BigInt(dollarsToCents(word)) !== readsAs(word);
      } catch {
        return true;
      }
    });

    expect(inside.length).toBeGreaterThan(0);
    expect(mispriced).toEqual([]);
  });
});

describe('centsToNanoUsd', () => {
  it('scales whole cents to a canonical nano-USD string', () => {
    expect(centsToNanoUsd(0)).toBe('0');
    expect(centsToNanoUsd(500)).toBe('5000000000');
    expect(centsToNanoUsd(1099)).toBe('10990000000');
  });

  it('matches the prior budget-hook `BigInt(cents) * 10_000_000n` math', () => {
    for (const cents of [0, 1, 10, 500, 2500, 100_000]) {
      expect(centsToNanoUsd(cents)).toBe((BigInt(cents) * 10_000_000n).toString());
    }
  });
});

describe('dollarsToNanoUsd', () => {
  it('parses a dollar string to a canonical nano-USD string', () => {
    expect(dollarsToNanoUsd('5')).toBe('5000000000');
    expect(dollarsToNanoUsd('10.99')).toBe('10990000000');
    expect(dollarsToNanoUsd('0.10')).toBe('100000000');
  });

  it('matches the prior payment-form `(cents * 10_000_000n).toString()` math', () => {
    for (const d of ['5', '10.99', '0.10', '0.1', '1000', '5.05']) {
      const [whole = '0', fraction = ''] = d.split('.');
      const wholeDigits = whole.length > 0 ? whole : '0';
      const cents = BigInt(wholeDigits) * 100n + BigInt(`${fraction}00`.slice(0, 2));
      expect(dollarsToNanoUsd(d)).toBe((cents * 10_000_000n).toString());
    }
  });
});

describe('nanoUsdToFullDollarString', () => {
  it('preserves sub-cent precision instead of truncating to cents', () => {
    // 1_360_000 nano = $0.00136 — the cent-truncating formatter would drop this
    expect(nanoUsdToFullDollarString('1360000')).toBe('0.001360000');
  });

  it('renders zero with full fractional padding', () => {
    expect(nanoUsdToFullDollarString('0')).toBe('0.000000000');
  });

  it('renders a whole dollar', () => {
    expect(nanoUsdToFullDollarString('1000000000')).toBe('1.000000000');
  });

  it('renders dollars-and-cents amounts without precision loss', () => {
    expect(nanoUsdToFullDollarString('12345670000000')).toBe('12345.670000000');
  });

  it('renders negative amounts', () => {
    expect(nanoUsdToFullDollarString('-1360000')).toBe('-0.001360000');
  });

  it('keeps full precision above the float-safe integer range', () => {
    // 10^16 nano = $10,000,000 — exceeds Number.MAX_SAFE_INTEGER as raw nano
    expect(nanoUsdToFullDollarString('10000000000000001')).toBe('10000000.000000001');
  });
});
