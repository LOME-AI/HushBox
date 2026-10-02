const bitsView = new DataView(new ArrayBuffer(8));

/** A double's position in the ordered sequence of all doubles, with −0 and +0 at the same place. */
function orderedBits(value: number): bigint {
  bitsView.setFloat64(0, value);
  const bits = bitsView.getBigInt64(0);
  return bits < 0n ? -(bits & 0x7f_ff_ff_ff_ff_ff_ff_ffn) : bits;
}

/** How many representable doubles apart two values are: their distance in ulps. */
export function ulpDistance(a: number, b: number): number {
  const distance = orderedBits(a) - orderedBits(b);
  return Number(distance < 0n ? -distance : distance);
}
