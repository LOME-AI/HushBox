import { describe, expect, it } from 'vitest';

import { cos, exp, exp2, log, log10, log2, pow, sin, tanh } from './dmath.js';
import { ulpDistance } from './dmath-test-support.js';

/** The number of evenly spaced points each function is compared against `Math` on. */
const POINTS = 200_000;

/** `count` points evenly spaced over [min, max], both ends included. */
function evenlySpaced(min: number, max: number, count: number = POINTS): number[] {
  return Array.from({ length: count }, (_, index) => min + ((max - min) * index) / (count - 1));
}

interface Worst {
  readonly ulps: number;
  readonly input: number;
}

/** The largest ulp distance between `actual` and `expected` over the inputs, and where it occurs. */
function worstUlps(
  actual: (x: number) => number,
  expected: (x: number) => number,
  inputs: readonly number[]
): Worst {
  let worst: Worst = { ulps: 0, input: Number.NaN };
  for (const input of inputs) {
    const ulps = ulpDistance(actual(input), expected(input));
    if (ulps > worst.ulps) {
      worst = { ulps, input };
    }
  }
  return worst;
}

/** `count` points log-spaced over [2^−1074, 1e300]: from the smallest subnormal up. */
function logSpaced(count: number = POINTS): number[] {
  const top = Math.log2(1e300);
  return evenlySpaced(-1074, top, count).map((exponent) => Math.min(Math.pow(2, exponent), 1e300));
}

/** `Math` has no exp2; Math.pow(2, x) is its reference. */
function mathExp2(x: number): number {
  return Math.pow(2, x);
}

/** The largest double below 1,647,099, the first magnitude sin and cos refuse. */
const LARGEST_REDUCIBLE = 1_647_098.999_999_999_8;

/** The IEEE special inputs, whose results `Math` defines exactly: NaN, the infinities, the signed zeros, subnormals and the smallest normal. */
const SPECIAL_INPUTS = [
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  0,
  -0,
  Number.MIN_VALUE,
  -Number.MIN_VALUE,
  2.225_073_858_507_200_9e-308,
  -2.225_073_858_507_200_9e-308,
  1e-300,
  -1e-300,
];

describe('sin', () => {
  it('matches Math.sin exactly at every IEEE special input', () => {
    for (const input of SPECIAL_INPUTS) {
      expect(Object.is(sin(input), Math.sin(input)), `sin(${String(input)})`).toBe(true);
    }
  });

  it('stays within 2 ulp of Math.sin on 200,000 evenly spaced points over [−1e4, 1e4]', () => {
    const worst = worstUlps(sin, Math.sin, evenlySpaced(-1e4, 1e4));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.sin from 1e4 up to the largest reducible magnitude', () => {
    const worst = worstUlps(sin, Math.sin, evenlySpaced(1e4, LARGEST_REDUCIBLE, 50_000));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('accepts the largest magnitude below 1,647,099', () => {
    expect(ulpDistance(sin(LARGEST_REDUCIBLE), Math.sin(LARGEST_REDUCIBLE))).toBeLessThanOrEqual(2);
    expect(ulpDistance(sin(-LARGEST_REDUCIBLE), Math.sin(-LARGEST_REDUCIBLE))).toBeLessThanOrEqual(
      2
    );
  });

  it('throws a RangeError naming the argument for magnitudes from 1,647,099 up', () => {
    for (const x of [1_647_099, -1_647_099, 2e6]) {
      expect(() => sin(x)).toThrow(RangeError);
      expect(() => sin(x)).toThrow(`got ${String(x)}.`);
    }
  });
});

describe('cos', () => {
  it('matches Math.cos exactly at every IEEE special input', () => {
    for (const input of SPECIAL_INPUTS) {
      expect(Object.is(cos(input), Math.cos(input)), `cos(${String(input)})`).toBe(true);
    }
  });

  it('stays within 2 ulp of Math.cos on 200,000 evenly spaced points over [−1e4, 1e4]', () => {
    const worst = worstUlps(cos, Math.cos, evenlySpaced(-1e4, 1e4));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.cos from 1e4 up to the largest reducible magnitude', () => {
    const worst = worstUlps(cos, Math.cos, evenlySpaced(1e4, LARGEST_REDUCIBLE, 50_000));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('accepts the largest magnitude below 1,647,099', () => {
    expect(ulpDistance(cos(LARGEST_REDUCIBLE), Math.cos(LARGEST_REDUCIBLE))).toBeLessThanOrEqual(2);
    expect(ulpDistance(cos(-LARGEST_REDUCIBLE), Math.cos(-LARGEST_REDUCIBLE))).toBeLessThanOrEqual(
      2
    );
  });

  it('throws a RangeError naming the argument for magnitudes from 1,647,099 up', () => {
    for (const x of [1_647_099, -1_647_099, 2e6]) {
      expect(() => cos(x)).toThrow(RangeError);
      expect(() => cos(x)).toThrow(`got ${String(x)}.`);
    }
  });
});

describe('exp', () => {
  it('matches Math.exp exactly at every IEEE special input', () => {
    for (const input of SPECIAL_INPUTS) {
      expect(Object.is(exp(input), Math.exp(input)), `exp(${String(input)})`).toBe(true);
    }
  });

  it('overflows to Infinity above 709.782712893384, as Math.exp does', () => {
    expect(exp(709.782_712_893_384)).toBe(Math.exp(709.782_712_893_384));
    expect(exp(709.782_712_893_384_1)).toBe(Number.POSITIVE_INFINITY);
  });

  it('underflows to 0 below −745.1332191019411, as Math.exp does', () => {
    expect(exp(-745.133_219_101_941_1)).toBe(Math.exp(-745.133_219_101_941_1));
    expect(exp(-745.133_219_101_941_2)).toBe(0);
  });

  it('stays within 2 ulp of Math.exp on 200,000 evenly spaced points over [−700, 700]', () => {
    const worst = worstUlps(exp, Math.exp, evenlySpaced(-700, 700));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.exp approaching overflow', () => {
    const worst = worstUlps(exp, Math.exp, evenlySpaced(700, 709.782_712_893_384, 20_000));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.exp where the result is subnormal', () => {
    const worst = worstUlps(exp, Math.exp, evenlySpaced(-745.133, -708.4, 20_000));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });
});

describe('exp2', () => {
  it('matches Math.pow(2, x) exactly at every IEEE special input', () => {
    for (const input of SPECIAL_INPUTS) {
      expect(Object.is(exp2(input), mathExp2(input)), `exp2(${String(input)})`).toBe(true);
    }
  });

  it('returns exact powers of two at integer arguments', () => {
    for (let n = -1074; n <= 1023; n += 1) {
      expect(exp2(n), `exp2(${String(n)})`).toBe(mathExp2(n));
    }
  });

  it('overflows to Infinity from 1024, as Math.pow(2, x) does', () => {
    expect(exp2(1023.999_999_999_999_9)).toBe(mathExp2(1023.999_999_999_999_9));
    expect(exp2(1024)).toBe(Number.POSITIVE_INFINITY);
  });

  it('underflows to 0 at −1075 and below, as Math.pow(2, x) does', () => {
    expect(exp2(-1074.999_999_999_999_8)).toBe(Number.MIN_VALUE);
    expect(exp2(-1075)).toBe(0);
  });

  it('stays within 2 ulp of Math.pow(2, x) on 200,000 evenly spaced points over [−700, 700]', () => {
    const worst = worstUlps(exp2, mathExp2, evenlySpaced(-700, 700));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.pow(2, x) approaching overflow', () => {
    const worst = worstUlps(exp2, mathExp2, evenlySpaced(1000, 1023.999_999_999_999_9, 20_000));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.pow(2, x) where the result is subnormal', () => {
    const worst = worstUlps(exp2, mathExp2, evenlySpaced(-1074.999, -1022, 20_000));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });
});

describe('log', () => {
  it('matches Math.log exactly at every IEEE special input', () => {
    for (const input of [...SPECIAL_INPUTS, -1, 1]) {
      expect(Object.is(log(input), Math.log(input)), `log(${String(input)})`).toBe(true);
    }
  });

  it('stays within 2 ulp of Math.log on 200,000 log-spaced points over (0, 1e300]', () => {
    const worst = worstUlps(log, Math.log, logSpaced());
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.log around 1, where the result nears 0', () => {
    const worst = worstUlps(log, Math.log, evenlySpaced(0.5, 2));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });
});

describe('log2', () => {
  it('matches Math.log2 exactly at every IEEE special input', () => {
    for (const input of [...SPECIAL_INPUTS, -1, 1]) {
      expect(Object.is(log2(input), Math.log2(input)), `log2(${String(input)})`).toBe(true);
    }
  });

  it('stays within 2 ulp of Math.log2 on 200,000 log-spaced points over (0, 1e300]', () => {
    const worst = worstUlps(log2, Math.log2, logSpaced());
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.log2 around 1, where the result nears 0', () => {
    const worst = worstUlps(log2, Math.log2, evenlySpaced(0.5, 2));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });
});

describe('log10', () => {
  it('matches Math.log10 exactly at every IEEE special input', () => {
    for (const input of [...SPECIAL_INPUTS, -1, 1]) {
      expect(Object.is(log10(input), Math.log10(input)), `log10(${String(input)})`).toBe(true);
    }
  });

  // Math.log10 itself errs by up to 1.77 ulp, so the bound against it is 3 ulp;
  // the high-precision reference test holds log10 to 1 ulp of the true value.
  it('stays within 3 ulp of Math.log10 on 200,000 log-spaced points over (0, 1e300]', () => {
    const worst = worstUlps(log10, Math.log10, logSpaced());
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(3);
  });

  it('stays within 3 ulp of Math.log10 around 1, where the result nears 0', () => {
    const worst = worstUlps(log10, Math.log10, evenlySpaced(0.5, 2));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(3);
  });
});

describe('log2 at powers of two', () => {
  it('returns the exponent exactly', () => {
    for (let n = -1074; n <= 1023; n += 1) {
      expect(log2(Math.pow(2, n)), `log2(2^${String(n)})`).toBe(n);
    }
  });
});

describe('pow', () => {
  /** True when `actual` is `expected` exactly where IEEE defines it, and within `ulps` elsewhere. */
  function agrees(actual: number, expected: number, ulps: number): boolean {
    if (Number.isNaN(expected) || expected === 0 || !Number.isFinite(expected)) {
      return Object.is(actual, expected);
    }
    return ulpDistance(actual, expected) <= ulps;
  }

  const SPECIAL_BASES = [
    Number.NaN,
    0,
    -0,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1,
    -1,
    0.5,
    -0.5,
    2,
    -2,
    3,
    -3,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
  ];
  const SPECIAL_EXPONENTS = [
    Number.NaN,
    0,
    -0,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1,
    -1,
    2,
    -2,
    3,
    -3,
    0.5,
    -0.5,
    2.5,
    Number.MAX_SAFE_INTEGER,
    Number.MAX_SAFE_INTEGER + 1,
    -(Number.MAX_SAFE_INTEGER + 1),
    Math.pow(2, 70),
    -Math.pow(2, 70),
    1e300,
  ];

  it('matches Math.pow over the grid of special base-exponent pairs', () => {
    for (const base of SPECIAL_BASES) {
      for (const exponent of SPECIAL_EXPONENTS) {
        const expected = Math.pow(base, exponent);
        const actual = pow(base, exponent);
        expect(
          agrees(actual, expected, 4),
          `pow(${String(base)}, ${String(exponent)}) = ${String(actual)}, Math ${String(expected)}`
        ).toBe(true);
      }
    }
  });

  it('stays within 4 ulp of Math.pow on 200,000 lattice points over x ∈ (0, 1e3], y ∈ [−50, 50]', () => {
    // A rank-1 lattice: every x and every y is used once, both evenly spaced,
    // paired through a multiplier coprime to the point count.
    const xs = evenlySpaced(1e3 / POINTS, 1e3);
    const ys = evenlySpaced(-50, 50);
    let worst = { ulps: 0, x: Number.NaN, y: Number.NaN };
    for (const [index, x] of xs.entries()) {
      const y = ys[(index * 123_457) % POINTS] ?? Number.NaN;
      const ulps = ulpDistance(pow(x, y), Math.pow(x, y));
      if (ulps > worst.ulps) {
        worst = { ulps, x, y };
      }
    }
    expect(worst.ulps, `worst input (${String(worst.x)}, ${String(worst.y)})`).toBeLessThanOrEqual(
      4
    );
  });

  it('overflows at the same exponents as Math.pow', () => {
    const edges: readonly (readonly [number, number])[] = [
      [2, 1024],
      [2, 1023.999_999_999_999_9],
      [-2, 1025],
      [10, 308.254_715_559_916_7],
      [10, 308.254_715_559_916_8],
      [1e3, 200],
    ];
    for (const [base, exponent] of edges) {
      const expected = Math.pow(base, exponent);
      expect(
        agrees(pow(base, exponent), expected, 4),
        `pow(${String(base)}, ${String(exponent)})`
      ).toBe(true);
    }
  });

  it('underflows at the same exponents as Math.pow', () => {
    const edges: readonly (readonly [number, number])[] = [
      [2, -1075],
      [2, -1074.999_999_999_999_8],
      [-2, -1075],
      [0.5, 1074],
      [0.5, 1075],
      [1e-3, 200],
    ];
    for (const [base, exponent] of edges) {
      const expected = Math.pow(base, exponent);
      expect(
        agrees(pow(base, exponent), expected, 4),
        `pow(${String(base)}, ${String(exponent)})`
      ).toBe(true);
    }
  });

  it('stays within 4 ulp of Math.pow where the result is subnormal', () => {
    const worst = worstUlps(
      (y) => pow(10, y),
      (y) => Math.pow(10, y),
      evenlySpaced(-323.3, -307.7, 20_000)
    );
    expect(worst.ulps, `worst exponent ${String(worst.input)}`).toBeLessThanOrEqual(4);
  });

  it('stays within 4 ulp of Math.pow for subnormal bases', () => {
    const worst = worstUlps(
      (x) => pow(x, 0.25),
      (x) => Math.pow(x, 0.25),
      evenlySpaced(Number.MIN_VALUE, 2.225e-308, 20_000)
    );
    expect(worst.ulps, `worst base ${String(worst.input)}`).toBeLessThanOrEqual(4);
  });
});

describe('tanh', () => {
  it('matches Math.tanh exactly at every IEEE special input', () => {
    for (const input of SPECIAL_INPUTS) {
      expect(Object.is(tanh(input), Math.tanh(input)), `tanh(${String(input)})`).toBe(true);
    }
  });

  it('stays within 2 ulp of Math.tanh on 200,000 evenly spaced points over [−30, 30]', () => {
    const worst = worstUlps(tanh, Math.tanh, evenlySpaced(-30, 30));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });

  it('stays within 2 ulp of Math.tanh near 0, where it approaches x', () => {
    const worst = worstUlps(tanh, Math.tanh, evenlySpaced(-1e-3, 1e-3, 20_000));
    expect(worst.ulps, `worst input ${String(worst.input)}`).toBeLessThanOrEqual(2);
  });
});
