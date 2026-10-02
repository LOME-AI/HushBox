/** The number of distinct values one 32-bit draw can take. */
const UINT32_RANGE = 2 ** 32;

/**
 * Get a cryptographically secure random index for an array.
 * Uses crypto.getRandomValues() instead of Math.random() for security.
 */
export function getSecureRandomIndex(arrayLength: number): number {
  if (arrayLength <= 0) {
    throw new Error('Array length must be positive');
  }
  if (arrayLength > UINT32_RANGE) {
    throw new Error('Array length must not exceed the random draw space');
  }
  // Rejection sampling: draws are uniform over 2^32 values, which a bare modulus
  // would then fold unevenly onto a range that does not divide it. Discarding the
  // incomplete final bucket leaves an accepted space that is an exact multiple of
  // arrayLength, so every index keeps the same number of draws mapping onto it.
  const acceptedDrawSpace = UINT32_RANGE - (UINT32_RANGE % arrayLength);
  const randomBuffer = new Uint32Array(1);
  let randomValue: number;
  do {
    crypto.getRandomValues(randomBuffer);
    // Type assertion safe: Uint32Array(1) guarantees index 0 exists
    // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer explicit type over ! assertion
    randomValue = randomBuffer[0] as number;
  } while (randomValue >= acceptedDrawSpace);
  return randomValue % arrayLength;
}

/**
 * Get a random element from an array using cryptographically secure randomness.
 */
export function getSecureRandomElement<T>(array: readonly T[]): T {
  if (array.length === 0) {
    throw new Error('Cannot get random element from empty array');
  }
  return array[getSecureRandomIndex(array.length)] as T;
}
