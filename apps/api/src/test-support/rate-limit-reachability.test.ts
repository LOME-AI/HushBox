import { describe, expect, it } from 'vitest';
import { reachableFrom } from './rate-limit-reachability.js';

describe('reachableFrom', () => {
  it('reports a value the root holds', () => {
    const held = { marker: 'held' };

    expect(reachableFrom({ held })).toContain(held);
  });

  it('follows a non-enumerable property', () => {
    const hidden = { marker: 'hidden' };
    const root = {};
    Object.defineProperty(root, 'hidden', { value: hidden, enumerable: false });

    expect(reachableFrom(root)).toContain(hidden);
  });

  it('follows a symbol-keyed property', () => {
    const keyed = { marker: 'keyed' };

    expect(reachableFrom({ [Symbol('secret')]: keyed })).toContain(keyed);
  });

  it("descends into a function's own properties", () => {
    // Also the matched control for the function-intrinsics skip: hiding a
    // function's `length` and `name` must not hide what is hung off it, or a
    // cap reachable through a published callable would clear.
    const hung = { marker: 'hung' };
    const carrier = (): void => undefined;
    Object.assign(carrier, { hung });

    expect(reachableFrom({ carrier })).toContain(hung);
  });

  it('reports a value held in two places once', () => {
    const shared = { marker: 'shared' };

    const reachable = reachableFrom({ first: shared, second: shared });

    expect(reachable.filter((value) => value === shared)).toHaveLength(1);
  });

  it("reports neither a function's own length nor its own name", () => {
    const carrier = function named(a: number, b: number, c: number): number {
      return a + b + c;
    };

    const reachable = reachableFrom({ carrier });

    expect(reachable).not.toContain(3);
    expect(reachable).not.toContain('named');
  });

  it("descends into a function's prototype", () => {
    // A `prototype` is a fresh mutable object rather than a fact about the
    // signature, so skipping it would silently hide its whole subtree for any
    // callable published as a `function` declaration rather than an arrow.
    const parked = { maxAttempts: 1234 };
    const carrier = function named(): void {
      return undefined;
    };
    carrier.prototype.parked = parked;

    const reachable = reachableFrom({ carrier });

    expect(reachable).toContain(parked);
    expect(reachable).toContain(1234);
  });

  it("reports no array's own length", () => {
    const reachable = reachableFrom({ layers: [{ marker: 'a' }, { marker: 'b' }] });

    expect(reachable).not.toContain(2);
  });

  it('reports a cap parked in an array element, despite skipping the array length', () => {
    // The matched control for the length skip. It is the case both defects
    // this helper exists to prevent would have cleared: a walk that stopped at
    // an array would answer "no cap reachable" for a cap held in a list.
    const parked = { maxAttempts: 7 };

    const reachable = reachableFrom({ layers: [parked] });

    expect(reachable).toContain(parked);
    expect(reachable).toContain(7);
  });
});
