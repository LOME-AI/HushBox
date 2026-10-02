import { describe, it, expect } from 'vitest';
import { COMPOSED_HANDLER } from 'hono/utils/constants';
import { unwrapComposedHandler } from './composed-handler.js';

describe('unwrapComposedHandler', () => {
  it('returns an unwrapped handler unchanged', () => {
    const handler = (): void => {};
    expect(unwrapComposedHandler(handler)).toBe(handler);
  });

  it('returns a non-function value unchanged', () => {
    expect(unwrapComposedHandler('not-a-handler')).toBe('not-a-handler');
  });

  it('unwraps a composed handler to the original', () => {
    const original = (): void => {};
    const composed = Object.assign(() => {}, { [COMPOSED_HANDLER]: original });
    expect(unwrapComposedHandler(composed)).toBe(original);
  });

  it('unwraps repeatedly nested composition', () => {
    const original = (): void => {};
    const inner = Object.assign(() => {}, { [COMPOSED_HANDLER]: original });
    const outer = Object.assign(() => {}, { [COMPOSED_HANDLER]: inner });
    expect(unwrapComposedHandler(outer)).toBe(original);
  });
});
