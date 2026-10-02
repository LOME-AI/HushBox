// Integer and `Math.imul` arithmetic only: every operation here is exact, so a
// key yields the same bits on every engine, machine and Node version. Sums stay
// below 2^53 before `>>> 0` wraps them to 32 bits.

const FNV_OFFSET_BASIS = 0x81_1c_9d_c5;
const FNV_PRIME = 0x01_00_01_93;
const UINT32_RANGE = 0x1_00_00_00_00;
const encoder = new TextEncoder();

/** FNV-1a over the key's UTF-8 bytes, as an unsigned 32-bit integer. */
export function hashKey(key: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (const byte of encoder.encode(key)) {
    hash = Math.imul(hash ^ byte, FNV_PRIME);
  }
  return hash >>> 0;
}

/** An sfc32 generator seeded from four derivations of the key, yielding values in [0, 1). */
export function rand(key: string): () => number {
  let a = hashKey(`${key}#0`);
  let b = hashKey(`${key}#1`);
  let c = hashKey(`${key}#2`);
  let d = hashKey(`${key}#3`);
  return () => {
    const t = (a + b + d) >>> 0;
    d = (d + 1) >>> 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) >>> 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) >>> 0;
    return t / UINT32_RANGE;
  };
}

/** The key's first value, scaled into [min, max). */
export function range(key: string, min: number, max: number): number {
  return min + rand(key)() * (max - min);
}

/** The item the key's first value indexes. */
export function pick<T>(key: string, items: readonly T[]): T {
  const item = items[Math.floor(rand(key)() * items.length)];
  if (item === undefined) {
    throw new RangeError(`pick("${key}") was given no items to choose from`);
  }
  return item;
}
