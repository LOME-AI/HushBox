import { describe, it, expect } from 'vitest';
import { assertNever } from './assert-never.js';

describe('assertNever', () => {
  it('throws with the runtime value when called (defensive — should be unreachable at compile time)', () => {
    // We deliberately bypass TypeScript's exhaustiveness check to exercise the
    // runtime branch. In real call sites this is unreachable.
    const value = 'rogue' as never;
    expect(() => assertNever(value)).toThrow(/exhaustiveness/i);
    expect(() => assertNever(value)).toThrow(/rogue/);
  });

  it('serializes object inputs in the error message', () => {
    const value = { kind: 'unknown' } as never;
    expect(() => assertNever(value)).toThrow(/unknown/);
  });
});
