/**
 * Exhaustiveness helper for discriminated unions.
 *
 * Place at the bottom of a `switch` (or `case default`) to force TypeScript
 * to error if a new variant is added but not handled. Throws at runtime if
 * unreachable code is somehow reached — which is a programmer bug, not a
 * recoverable error.
 *
 * @example
 *   switch (request.modality) {
 *     case 'text': return handleText(request);
 *     case 'image': return handleImage(request);
 *     default: assertNever(request);
 *   }
 */
export function assertNever(value: never): never {
  const serialized = typeof value === 'object' ? JSON.stringify(value) : String(value);
  throw new Error(`Exhaustiveness check failed: unexpected value ${serialized}`);
}
