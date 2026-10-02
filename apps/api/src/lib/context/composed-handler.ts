import { COMPOSED_HANDLER } from 'hono/utils/constants';

/**
 * Hono's `.route()` wraps a sub-app's handlers when the sub-app carries its
 * own error handler, storing the original under `COMPOSED_HANDLER`. Unwrap so
 * handler-attached declarations survive composition regardless of how a
 * sub-router was built.
 */
export function unwrapComposedHandler(handler: unknown): unknown {
  let current = handler;
  while (typeof current === 'function') {
    const composed: unknown = Reflect.get(current, COMPOSED_HANDLER);
    if (composed === undefined) return current;
    current = composed;
  }
  return current;
}
