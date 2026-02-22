/**
 * Generates a Uint8Array filled with random bytes.
 * For test factories only — not cryptographically secure.
 */
export const placeholderBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    // eslint-disable-next-line sonarjs/pseudo-random -- test factory, not cryptographic use
    bytes[index] = Math.floor(Math.random() * 256);
  }
  return bytes;
};
