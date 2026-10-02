export function constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (const [index, element] of a.entries()) {
    result |= element ^ (b[index] ?? 0);
  }
  return result === 0;
}
