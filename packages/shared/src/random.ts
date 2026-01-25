/**
 * Get a cryptographically secure random index for an array.
 * Uses crypto.getRandomValues() instead of Math.random() for security.
 */
export function getSecureRandomIndex(arrayLength: number): number {
  if (arrayLength <= 0) {
    throw new Error('Array length must be positive');
  }
  const randomBuffer = new Uint32Array(1);
  crypto.getRandomValues(randomBuffer);
  // Type assertion safe: Uint32Array(1) guarantees index 0 exists
  // eslint-disable-next-line @typescript-eslint/non-nullable-type-assertion-style -- prefer explicit type over ! assertion
  const randomValue = randomBuffer[0] as number;
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
