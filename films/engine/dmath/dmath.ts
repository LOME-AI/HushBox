// Transcendental functions that return the same bits on every engine, machine and
// Node version. The algorithms and coefficients are fdlibm's, as FreeBSD's msun
// carries them; every step is an IEEE 754 basic operation or an exact `Math`
// function, so the result depends on no platform maths library. Where fdlibm
// reads or writes a double's bits, this module does the same with exact
// arithmetic: a comparison against a bound, a Veltkamp split, a power of two.

// ---------------------------------------------------------------------------
// Exact helpers

/** 2^n exactly, for an integer n in [−1074, 1023]: every partial product is a power of two. */
function pow2(n: number): number {
  let base = n < 0 ? 0.5 : 2;
  let remaining = Math.abs(n);
  let result = 1;
  while (remaining > 0) {
    if (remaining % 2 === 1) {
      result *= base;
    }
    base *= base;
    remaining = Math.floor(remaining / 2);
  }
  return result;
}

const TWO_POW_1023 = pow2(1023);
const TWO_POW_MINUS_1000 = pow2(-1000);

/** y · 2^k rounded once, for y near 1 and an integer k in [−1075, 1024]. */
function scaleByPowerOfTwo(y: number, k: number): number {
  if (k > 1023) {
    return y * 2 * TWO_POW_1023;
  }
  // A subnormal result is scaled in two steps so that only the last one rounds.
  if (k < -1021) {
    return y * pow2(k + 1000) * TWO_POW_MINUS_1000;
  }
  return y * pow2(k);
}

/** 2^32 + 1: a Veltkamp split by it leaves 21 significant bits, so two such heads multiply exactly. */
const SPLITTER = 4_294_967_297;

/** The nearest double to x with at most 21 significant bits (where fdlibm clears a low word). */
function head21(x: number): number {
  const scaled = x * SPLITTER;
  return scaled - (scaled - x);
}

/** 2^512, 2^256, …, 2^1 with their reciprocals: halving steps that sum to any exponent below 1024. */
const EXPONENT_STEPS = [512, 256, 128, 64, 32, 16, 8, 4, 2, 1].map((step) => ({
  step,
  up: pow2(step),
  down: pow2(-step),
}));
const SMALLEST_NORMAL = pow2(-1022);
const TWO_POW_54 = pow2(54);
/** 2^20: scales a mantissa's fraction so its floor is the top 20 fraction bits fdlibm tests. */
const TWO_POW_20 = pow2(20);

type Decomposed = readonly [mantissa: number, exponent: number];

/** x = mantissa · 2^exponent, mantissa in [1, 2), for a finite x ≥ 2. Each step is exact. */
function decomposeLarge(x: number): Decomposed {
  let mantissa = x;
  let exponent = 0;
  for (const { step, down, up } of EXPONENT_STEPS) {
    if (mantissa >= up) {
      mantissa *= down;
      exponent += step;
    }
  }
  return [mantissa, exponent];
}

/** x = mantissa · 2^exponent, mantissa in [1, 2), for a normal x < 2. Each step is exact. */
function decomposeSmall(x: number): Decomposed {
  let mantissa = x;
  let exponent = 0;
  for (const { step, up } of EXPONENT_STEPS) {
    const scaled = mantissa * up;
    if (scaled < 2) {
      mantissa = scaled;
      exponent -= step;
    }
  }
  return [mantissa, exponent];
}

/** x = mantissa · 2^exponent with the mantissa in [1, 2), for a positive finite x. */
function decompose(x: number): Decomposed {
  if (x < SMALLEST_NORMAL) {
    const [mantissa, exponent] = decomposeSmall(x * TWO_POW_54);
    return [mantissa, exponent - 54];
  }
  return x >= 2 ? decomposeLarge(x) : decomposeSmall(x);
}

// ---------------------------------------------------------------------------
// sin and cos

/** fdlibm's bound for |x| ≤ π/4, where no reduction is needed. */
const PI_OVER_4_BOUND = 0.785_398_483_276_367_2;
/** fdlibm's bound below which sin(x) rounds to x. */
const TWO_POW_MINUS_26 = pow2(-26);
/** fdlibm's bound below which cos(x) rounds to 1. */
const COS_TINY_BOUND = 1.053_670_928_286_010_2e-8;
/** Reduction by π/2 in 33-bit pieces is exact while |x| stays below this (fdlibm's medium range). */
const MEDIUM_LIMIT = 1_647_099;
/** 1.5 · 2^52: adding and subtracting it rounds a double below 2^51 to the nearest integer, ties to even. */
const ROUND_TO_INTEGER = 6_755_399_441_055_744;
/** How far a reduction round may cancel, relative to |x|, before the next round runs. */
const TWO_POW_MINUS_16 = pow2(-16);
const TWO_POW_MINUS_49 = pow2(-49);

/** 2/π, and π/2 as three 33-bit pieces, each with the tail of π/2 beyond it. */
const INV_PIO2 = 0.636_619_772_367_581_4;
const PIO2_1 = 1.570_796_326_734_125_6;
const PIO2_1T = 6.077_100_506_506_192e-11;
const PIO2_2 = 6.077_100_506_303_966e-11;
const PIO2_2T = 2.022_266_248_795_950_6e-21;
const PIO2_3 = 2.022_266_248_711_166_5e-21;
const PIO2_3T = 8.478_427_660_368_9e-32;

/** fdlibm's sin and cos kernel coefficients on [−π/4, π/4]. */
const S1 = -0.166_666_666_666_666_32;
const S2 = 0.008_333_333_333_322_49;
const S3 = -0.000_198_412_698_298_579_5;
const S4 = 0.000_002_755_731_370_707_006_8;
const S5 = -2.505_076_025_340_686_3e-8;
const S6 = 1.589_690_995_211_55e-10;
const C1 = 0.041_666_666_666_666_6;
const C2 = -0.001_388_888_888_887_411;
const C3 = 0.000_024_801_587_289_476_73;
const C4 = -2.755_731_435_139_066_3e-7;
const C5 = 2.087_572_321_298_175e-9;
const C6 = -1.135_964_755_778_819_5e-11;

/** sin(x) for |x| ≤ π/4. */
function kernelSinSingle(x: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  return x + z * x * (S1 + z * r);
}

/** sin(x + y) for |x + y| ≤ π/4, where y is the tail of a reduced argument. */
function kernelSin(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = S2 + z * (S3 + z * S4) + z * w * (S5 + z * S6);
  const v = z * x;
  return x - (z * (0.5 * y - v * r) - y - v * S1);
}

/** cos(x + y) for |x + y| ≤ π/4, where y is the tail of a reduced argument. */
function kernelCos(x: number, y: number): number {
  const z = x * x;
  const w = z * z;
  const r = z * (C1 + z * (C2 + z * C3)) + w * w * (C4 + z * (C5 + z * C6));
  const halfZ = 0.5 * z;
  const oneMinusHalfZ = 1 - halfZ;
  return oneMinusHalfZ + (1 - oneMinusHalfZ - halfZ + (z * r - x * y));
}

type Reduced = readonly [quadrant: number, head: number, tail: number];

/**
 * x − n·π/2 as head + tail with |head + tail| ≤ π/4, and n mod 4. A later round
 * runs only when the previous one cancelled enough bits to need it; the bounds
 * compare against |x| rather than its binary exponent, so a round runs in a
 * superset of fdlibm's cases, each of which is still exact.
 */
function reduceByHalfPi(x: number): Reduced {
  const magnitude = Math.abs(x);
  if (magnitude >= MEDIUM_LIMIT) {
    throw new RangeError(
      `dmath sin and cos take |x| < ${String(MEDIUM_LIMIT)}; got ${String(x)}. Wrap a phase into [−π, π] before calling.`
    );
  }
  const n = x * INV_PIO2 + ROUND_TO_INTEGER - ROUND_TO_INTEGER;
  let r = x - n * PIO2_1;
  let w = n * PIO2_1T;
  let head = r - w;
  if (Math.abs(head) < magnitude * TWO_POW_MINUS_16) {
    let t = r;
    w = n * PIO2_2;
    r = t - w;
    w = n * PIO2_2T - (t - r - w);
    head = r - w;
    if (Math.abs(head) < magnitude * TWO_POW_MINUS_49) {
      t = r;
      w = n * PIO2_3;
      r = t - w;
      w = n * PIO2_3T - (t - r - w);
      head = r - w;
    }
  }
  return [n - 4 * Math.floor(n / 4), head, r - head - w];
}

/** sin of a reduced argument whose quadrant is taken mod 4. */
function sinOfReduced(quadrant: number, head: number, tail: number): number {
  switch (quadrant % 4) {
    case 0: {
      return kernelSin(head, tail);
    }
    case 1: {
      return kernelCos(head, tail);
    }
    case 2: {
      return -kernelSin(head, tail);
    }
    default: {
      return -kernelCos(head, tail);
    }
  }
}

/** The sine of x, for |x| below 1,647,099 (throws a RangeError from there up). */
export function sin(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude < PI_OVER_4_BOUND) {
    return magnitude < TWO_POW_MINUS_26 ? x : kernelSinSingle(x);
  }
  if (!Number.isFinite(x)) {
    return Number.NaN;
  }
  const [quadrant, head, tail] = reduceByHalfPi(x);
  return sinOfReduced(quadrant, head, tail);
}

/** The cosine of x, for |x| below 1,647,099 (throws a RangeError from there up). */
export function cos(x: number): number {
  const magnitude = Math.abs(x);
  if (magnitude < PI_OVER_4_BOUND) {
    return magnitude < COS_TINY_BOUND ? 1 : kernelCos(x, 0);
  }
  if (!Number.isFinite(x)) {
    return Number.NaN;
  }
  const [quadrant, head, tail] = reduceByHalfPi(x);
  // cos(x) = sin(x + π/2): one quadrant further round.
  return sinOfReduced(quadrant + 1, head, tail);
}

// ---------------------------------------------------------------------------
// exp and exp2

/** exp overflows above the first bound and underflows to 0 below the second. */
const EXP_OVERFLOW = 709.782_712_893_384;
const EXP_UNDERFLOW = -745.133_219_101_941_1;
/** fdlibm's bound for |x| > ln2 / 2, where exp reduces by multiples of ln2. */
const HALF_LN2_BOUND = 0.346_573_591_232_299_8;
/** fdlibm's bound below which exp(x) rounds to 1 + x and tanh(x) to x. */
const TWO_POW_MINUS_28 = pow2(-28);

/** ln2 as a 32-bit head, so k · LN2_HI is exact for every k exp meets, and its tail; and 1/ln2. */
const LN2_HI = 0.693_147_180_369_123_8;
const LN2_LO = 1.908_214_929_270_587_7e-10;
const INV_LN2 = 1.442_695_040_888_963_4;

/** fdlibm's Remez coefficients for exp on [−ln2/2, ln2/2]. */
const P1 = 0.166_666_666_666_666_02;
const P2 = -0.002_777_777_777_701_559_3;
const P3 = 0.000_066_137_563_214_379_34;
const P4 = -0.000_001_653_390_220_546_525_2;
const P5 = 4.138_136_797_057_238_5e-8;

/** ln2 as a double, and as a 21-bit head with its tail. */
const LN2 = 0.693_147_180_559_945_3;
const LN2_HEAD21 = 0.693_147_182_464_599_6;
const LN2_TAIL21 = -1.904_654_299_957_768e-9;
/** 2^s overflows once s exceeds 1024 less this: log2 of the largest double plus half an ulp. */
const OVERFLOW_TAIL = 8.008_566_259_537_294e-17;

/**
 * x = k·ln2 + (hi − lo) with k the integer nearest x/ln2, for |x| ≥ ln2 / 2 and
 * |k| ≤ 1075. k · LN2_HI is exact and lies within a factor of two of x, so hi is
 * exact as well.
 */
function reduceByLn2(x: number): readonly [k: number, hi: number, lo: number] {
  const k = Math.trunc(INV_LN2 * x + (x < 0 ? -0.5 : 0.5));
  return [k, x - k * LN2_HI, k * LN2_LO];
}

/** c(r) = r − r²·P(r²) in fdlibm's exp(r) = 1 + r + r·c / (2 − c), for |r| ≤ ln2 / 2. */
function expCorrection(r: number): number {
  const t = r * r;
  return r - t * (P1 + t * (P2 + t * (P3 + t * (P4 + t * P5))));
}

/** e raised to x. */
export function exp(x: number): number {
  if (Number.isNaN(x)) {
    return x;
  }
  if (x > EXP_OVERFLOW) {
    return Number.POSITIVE_INFINITY;
  }
  if (x < EXP_UNDERFLOW) {
    return 0;
  }
  const magnitude = Math.abs(x);
  if (magnitude < HALF_LN2_BOUND) {
    if (magnitude < TWO_POW_MINUS_28) {
      return 1 + x;
    }
    const c = expCorrection(x);
    return 1 - ((x * c) / (c - 2) - x);
  }
  const [k, hi, lo] = reduceByLn2(x);
  const r = hi - lo;
  const c = expCorrection(r);
  return scaleByPowerOfTwo(1 - (lo - (r * c) / (2 - c) - hi), k);
}

/** 2^(high + low) for a sum inside (−1075, 1024), where low is below high's last bit. fdlibm pow's second half. */
function exp2Kernel(high: number, low: number): number {
  const sum = high + low;
  const n = Math.trunc(sum + (sum < 0 ? -0.5 : 0.5));
  const reduced = high - n;
  const t = head21(low + reduced);
  const u = t * LN2_HEAD21;
  const v = (low - (t - reduced)) * LN2 + t * LN2_TAIL21;
  const z = u + v;
  const w = v - (z - u);
  const c = expCorrection(z);
  const r = (z * c) / (c - 2) - (w + z * w);
  return scaleByPowerOfTwo(1 - (r - z), n);
}

/** 2^(high + low), overflowing and underflowing where the exact sum does. */
function exp2Extended(high: number, low: number): number {
  const sum = high + low;
  if (sum > 1024 || (sum === 1024 && low + OVERFLOW_TAIL > sum - high)) {
    return Number.POSITIVE_INFINITY;
  }
  if (sum < -1075 || (sum === -1075 && low <= sum - high)) {
    return 0;
  }
  return exp2Kernel(high, low);
}

/** 2 raised to x. */
export function exp2(x: number): number {
  return Number.isNaN(x) ? x : exp2Extended(x, 0);
}

// ---------------------------------------------------------------------------
// log, log2 and log10

/** fdlibm's Remez coefficients of R in log(1 + f) = 2s + s·R, s = f / (2 + f), |s| < 0.1716. */
const LG1 = 0.666_666_666_666_673_5;
const LG2 = 0.399_999_999_994_094_2;
const LG3 = 0.285_714_287_436_623_9;
const LG4 = 0.222_221_984_321_497_84;
const LG5 = 0.181_835_721_616_180_5;
const LG6 = 0.153_138_376_992_093_73;
const LG7 = 0.147_981_986_051_165_86;
const ONE_THIRD = 0.333_333_333_333_333_3;

/** fdlibm's top-20-fraction-bit thresholds: √2 for the reduction, and the band where log takes its other form. */
const SQRT2_FRACTION_BITS = 0x6_a0_9c;
const LOG_BAND_LOW = 0x6_14_7a;
const LOG_BAND_HIGH = 0x6_b8_51;
/** With fraction bits 0, or from this value up, |f| < 2^−20 and log takes its short series. */
const NEAR_POWER_OF_TWO_BELOW = 0xf_ff_fe;

/** 1/ln2 and 1/ln10 with 32-bit heads, and log10(2) with a 40-bit head, so each head product is exact. */
const INV_LN2_HI = 1.442_695_040_721_446_3;
const INV_LN2_LO = 1.675_171_316_488_651_2e-10;
const INV_LN10_HI = 0.434_294_481_878_168_9;
const INV_LN10_LO = 2.508_294_671_164_527_5e-11;
const LOG10_2_HI = 0.301_029_995_663_611_77;
const LOG10_2_LO = 3.694_239_077_158_931e-13;

interface LogReduced {
  readonly k: number;
  readonly f: number;
  readonly fractionBits: number;
}

/** x = 2^k · (1 + f) with 1 + f in [√2/2, √2), and the top 20 fraction bits of x's mantissa. */
function reduceForLog(x: number): LogReduced {
  const [mantissa, exponent] = decompose(x);
  const fractionBits = Math.floor((mantissa - 1) * TWO_POW_20);
  if (fractionBits >= SQRT2_FRACTION_BITS) {
    return { k: exponent + 1, f: mantissa / 2 - 1, fractionBits };
  }
  return { k: exponent, f: mantissa - 1, fractionBits };
}

/** fdlibm's R(s), where log(1 + f) = 2s + s·R and s = f / (2 + f). */
function logSeries(s: number): number {
  const z = s * s;
  const w = z * z;
  return z * (LG1 + w * (LG3 + w * (LG5 + w * LG7))) + w * (LG2 + w * (LG4 + w * LG6));
}

/** log, log2 and log10 at x ≤ 0, NaN and +Infinity, where IEEE defines the result exactly. */
function logOutsideDomain(x: number): number {
  if (x === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  return x === Number.POSITIVE_INFINITY ? x : Number.NaN;
}

/** The natural logarithm of x. */
export function log(x: number): number {
  if (!(x > 0 && x < Number.POSITIVE_INFINITY)) {
    return logOutsideDomain(x);
  }
  const { k, f, fractionBits } = reduceForLog(x);
  if (fractionBits === 0 || fractionBits >= NEAR_POWER_OF_TWO_BELOW) {
    const r = f * f * (0.5 - ONE_THIRD * f);
    return k * LN2_HI - (r - k * LN2_LO - f);
  }
  const s = f / (2 + f);
  const series = logSeries(s);
  if (fractionBits >= LOG_BAND_LOW && fractionBits <= LOG_BAND_HIGH) {
    const halfSquare = 0.5 * f * f;
    return k * LN2_HI - (halfSquare - (s * (halfSquare + series) + k * LN2_LO) - f);
  }
  return k * LN2_HI - (s * (f - series) - k * LN2_LO - f);
}

type LogParts = readonly [k: number, head: number, tail: number];

/**
 * x = 2^k · e^(head + tail). The head has 21 significant bits, so its products
 * with the 32-bit constant heads are exact.
 */
function logParts(x: number): LogParts {
  const { k, f } = reduceForLog(x);
  const halfSquare = 0.5 * f * f;
  const s = f / (2 + f);
  const r = s * (halfSquare + logSeries(s));
  const head = head21(f - halfSquare);
  return [k, head, f - head - halfSquare + r];
}

/** log2 of 2^k · e^(head + tail), adding k in extra precision. */
function log2OfParts([k, head, tail]: LogParts): number {
  const valueHead = head * INV_LN2_HI;
  const valueTail = (tail + head) * INV_LN2_LO + tail * INV_LN2_HI;
  const sum = k + valueHead;
  return valueTail + (k - sum + valueHead) + sum;
}

/** log10 of 2^k · e^(head + tail), adding k · log10(2) in extra precision. */
function log10OfParts([k, head, tail]: LogParts): number {
  const valueHead = head * INV_LN10_HI;
  const exponentHead = k * LOG10_2_HI;
  const valueTail = k * LOG10_2_LO + (tail + head) * INV_LN10_LO + tail * INV_LN10_HI;
  const sum = exponentHead + valueHead;
  return valueTail + (exponentHead - sum + valueHead) + sum;
}

/** The base-2 logarithm of x. */
export function log2(x: number): number {
  return x > 0 && x < Number.POSITIVE_INFINITY ? log2OfParts(logParts(x)) : logOutsideDomain(x);
}

/** The base-10 logarithm of x. */
export function log10(x: number): number {
  return x > 0 && x < Number.POSITIVE_INFINITY ? log10OfParts(logParts(x)) : logOutsideDomain(x);
}

// ---------------------------------------------------------------------------
// pow

/** fdlibm pow's coefficients of (3/2)(log x − 2s − (2/3)s³) in s². */
const L1 = 0.599_999_999_999_994_6;
const L2 = 0.428_571_428_578_550_2;
const L3 = 0.333_333_329_818_377_43;
const L4 = 0.272_728_123_808_534;
const L5 = 0.230_660_745_775_561_75;
const L6 = 0.206_975_017_800_338_42;
/** 2/(3 ln2) as a double, and as a 24-bit head with its tail. */
const CP = 0.961_796_693_925_975_6;
const CP_H = 0.961_796_700_954_437_3;
const CP_L = -7.028_461_650_952_758e-9;
/** log2(1.5) as a short head and its tail. */
const LOG2_ONE_AND_HALF_HI = 0.584_962_487_220_764_2;
const LOG2_ONE_AND_HALF_LO = 1.350_039_202_129_749e-8;
/** fdlibm's top-20-fraction-bit bounds for √(3/2) and √3, which pick the reference point 1 or 1.5. */
const SQRT_THREE_HALVES_FRACTION_BITS = 0x3_98_8e;
const SQRT_THREE_FRACTION_BITS = 0xb_b6_7a;
/** Beyond this |y| every x ≠ 1 overflows or underflows, and y is too large to split. */
const TWO_POW_64 = pow2(64);

interface PowInterval {
  readonly mantissa: number;
  readonly exponent: number;
  readonly reference: number;
  readonly logReferenceHi: number;
  readonly logReferenceLo: number;
}

/** x = mantissa · 2^exponent with the mantissa nearest the reference point 1 or 1.5. */
function powInterval(x: number): PowInterval {
  const [mantissa, exponent] = decompose(x);
  const fractionBits = Math.floor((mantissa - 1) * TWO_POW_20);
  if (fractionBits <= SQRT_THREE_HALVES_FRACTION_BITS) {
    return { mantissa, exponent, reference: 1, logReferenceHi: 0, logReferenceLo: 0 };
  }
  if (fractionBits < SQRT_THREE_FRACTION_BITS) {
    return {
      mantissa,
      exponent,
      reference: 1.5,
      logReferenceHi: LOG2_ONE_AND_HALF_HI,
      logReferenceLo: LOG2_ONE_AND_HALF_LO,
    };
  }
  return {
    mantissa: mantissa / 2,
    exponent: exponent + 1,
    reference: 1,
    logReferenceHi: 0,
    logReferenceLo: 0,
  };
}

/**
 * log2(x) in extra precision as head + tail, for a positive finite x. The head
 * has 21 significant bits, so its product with y's 21-bit head is exact.
 */
function log2Extended(x: number): readonly [head: number, tail: number] {
  const { mantissa, exponent, reference, logReferenceHi, logReferenceLo } = powInterval(x);
  const u = mantissa - reference;
  const v = 1 / (mantissa + reference);
  const s = u * v;
  const sHead = head21(s);
  const sumHead = head21(mantissa + reference);
  const sumTail = mantissa - (sumHead - reference);
  const sTail = v * (u - sHead * sumHead - sHead * sumTail);
  const s2 = s * s;
  let r = s2 * s2 * (L1 + s2 * (L2 + s2 * (L3 + s2 * (L4 + s2 * (L5 + s2 * L6)))));
  r += sTail * (sHead + s);
  const sHeadSquared = sHead * sHead;
  const polyHead = head21(3 + sHeadSquared + r);
  const polyTail = r - (polyHead - 3 - sHeadSquared);
  const productHead = sHead * polyHead;
  const productTail = sTail * polyHead + polyTail * s;
  const pHead = head21(productHead + productTail);
  const pTail = productTail - (pHead - productHead);
  const zHead = CP_H * pHead;
  const zTail = CP_L * pHead + pTail * CP + logReferenceLo;
  const head = head21(zHead + zTail + logReferenceHi + exponent);
  return [head, zTail - (head - exponent - logReferenceHi - zHead)];
}

/** Whether y is an odd integer; every double from 2^53 up is even. */
function isOddInteger(y: number): boolean {
  return Number.isInteger(y) && y % 2 !== 0;
}

/** pow when the base is ±0 or ±Infinity and the exponent is neither NaN nor 0. */
function powOfZeroOrInfinity(x: number, y: number): number {
  const magnitude = (x === 0) === y > 0 ? 0 : Number.POSITIVE_INFINITY;
  const negativeBase = x < 0 || Object.is(x, -0);
  return negativeBase && isOddInteger(y) ? -magnitude : magnitude;
}

/** pow when the exponent is ±Infinity and the base is finite and nonzero. */
function powToInfinity(x: number, y: number): number {
  const magnitude = Math.abs(x);
  if (magnitude === 1) {
    return Number.NaN;
  }
  return magnitude > 1 === y > 0 ? Number.POSITIVE_INFINITY : 0;
}

/** The result ECMAScript defines exactly for the pair, or undefined when x and y are finite and nonzero. */
function powSpecialCase(x: number, y: number): number | undefined {
  if (Number.isNaN(y) || y === 0) {
    return Number.isNaN(y) ? y : 1;
  }
  if (Number.isNaN(x)) {
    return x;
  }
  if (x === 0 || !Number.isFinite(x)) {
    return powOfZeroOrInfinity(x, y);
  }
  if (!Number.isFinite(y)) {
    return powToInfinity(x, y);
  }
  return x < 0 && !Number.isInteger(y) ? Number.NaN : undefined;
}

/** x^y for a positive finite x and a finite nonzero y. */
function powPositive(x: number, y: number): number {
  if (Math.abs(y) > TWO_POW_64) {
    if (x === 1) {
      return 1;
    }
    return x < 1 === y < 0 ? Number.POSITIVE_INFINITY : 0;
  }
  const [log2Head, log2Tail] = log2Extended(x);
  const yHead = head21(y);
  return exp2Extended(yHead * log2Head, (y - yHead) * log2Head + y * log2Tail);
}

/** x raised to y, with ECMAScript's exact results at NaN, zeros, infinities and ±1. */
export function pow(x: number, y: number): number {
  const special = powSpecialCase(x, y);
  if (special !== undefined) {
    return special;
  }
  const magnitude = powPositive(Math.abs(x), y);
  return x < 0 && isOddInteger(y) ? -magnitude : magnitude;
}

// ---------------------------------------------------------------------------
// tanh

/** fdlibm's expm1 coefficients, scaled for R(2z) where z = x²/2. */
const Q1 = -0.033_333_333_333_333_13;
const Q2 = 0.001_587_301_587_254_814_6;
const Q3 = -0.000_079_365_075_786_748_8;
const Q4 = 0.000_004_008_217_827_329_362;
const Q5 = -2.010_992_181_836_243_7e-7;
/** From here on tanh(x) rounds to ±1. */
const TANH_SATURATION = 22;

/** fdlibm expm1's correction term e and x²/2, for |x| ≤ ln2 / 2. */
function expm1Correction(x: number): readonly [e: number, halfSquare: number] {
  const halfX = 0.5 * x;
  const halfSquare = x * halfX;
  const r1 =
    1 +
    halfSquare * (Q1 + halfSquare * (Q2 + halfSquare * (Q3 + halfSquare * (Q4 + halfSquare * Q5))));
  const t = 3 - r1 * halfX;
  return [halfSquare * ((r1 - t) / (6 - x * t)), halfSquare];
}

/**
 * e^x − 1 rebuilt from the reduced r, its correction e and k, for k ≠ 0. fdlibm's
 * separate k = 1 form is left out: tanh never reaches it.
 */
function expm1Reconstruct(r: number, e: number, k: number): number {
  if (k === -1) {
    return 0.5 * (r - e) - 0.5;
  }
  const twoPowK = pow2(k);
  if (k <= -2 || k > 56) {
    return (1 - (e - r)) * twoPowK - 1;
  }
  if (k < 20) {
    return (1 - pow2(-k) - (e - r)) * twoPowK;
  }
  return (r - (e + pow2(-k)) + 1) * twoPowK;
}

/**
 * e^x − 1 over the arguments tanh passes: x in (−2, −2^−27] or [2, 44). fdlibm's
 * branches for arguments outside those ranges are left out.
 */
function tanhExpm1(x: number): number {
  if (Math.abs(x) < HALF_LN2_BOUND) {
    const [e, halfSquare] = expm1Correction(x);
    return x - (x * e - halfSquare);
  }
  const [k, hi, lo] = reduceByLn2(x);
  const r = hi - lo;
  const c = hi - r - lo;
  const [e, halfSquare] = expm1Correction(r);
  return expm1Reconstruct(r, r * (e - c) - c - halfSquare, k);
}

/** tanh of a magnitude in [2^−28, 22). */
function tanhOfMagnitude(magnitude: number): number {
  if (magnitude >= 1) {
    return 1 - 2 / (tanhExpm1(2 * magnitude) + 2);
  }
  const t = tanhExpm1(-2 * magnitude);
  return -t / (t + 2);
}

/** The hyperbolic tangent of x. */
export function tanh(x: number): number {
  const magnitude = Math.abs(x);
  if (Number.isNaN(x) || magnitude < TWO_POW_MINUS_28) {
    return x;
  }
  const value = magnitude >= TANH_SATURATION ? 1 : tanhOfMagnitude(magnitude);
  return x < 0 ? -value : value;
}
