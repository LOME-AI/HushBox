/**
 * The shared assertion vocabulary for shape-contract and compile-time-proof test sites.
 *
 * The assertion helpers assert through the runner's own `expect` rather than throwing directly, and
 * that is load-bearing beyond failure formatting: `sonarjs/assertions-in-tests` resolves a
 * callee's declaration through the TypeScript program and fails any `it()` body in which it
 * finds no `expect` call. A helper that threw would be invisible to it, so every caller would
 * need an assertion of its own beside the call — which is the vacuity this vocabulary exists
 * to retire. Replacing an `expect` here with a `throw` reddens the lint of every calling
 * package.
 *
 * Test-only, reached through the `@hushbox/shared/test-assertions` subpath.
 */

import { expect } from 'vitest';

/**
 * Asserts that `subject` exposes each named property as a function.
 *
 * This is the shape-contract vocabulary for barrel and factory tests: it claims that a
 * named API is present, and nothing about which branch produced it.
 *
 * At least one name is required: a zero-name call would assert nothing and pass whatever
 * the subject is, which is the defect this vocabulary exists to retire.
 */
export function expectExposes(subject: object, ...names: [string, ...string[]]): void {
  for (const name of names) {
    expect(name in subject, `expectExposes: "${name}" is not exposed`).toBe(true);
    const value = (subject as Record<string, unknown>)[name];
    expect(
      typeof value === 'function',
      `expectExposes: "${name}" is exposed as ${typeof value}, not a function`
    ).toBe(true);
  }
}

/**
 * Asserts that a compile-time proof's thunk is callable.
 *
 * The real assertion at such a site is the adjacent `@ts-expect-error`, which the
 * typechecker checks; this runtime call exists only to keep the symbol referenced against
 * TypeScript erasure. The thunk is never invoked.
 */
export function expectCompileTimeProof(thunk: () => unknown): void {
  expect(
    typeof thunk === 'function',
    'expectCompileTimeProof: the proof thunk is not callable'
  ).toBe(true);
}

/**
 * The members of a plugin-option union that a lookup can report: those carrying a `name`,
 * less any whose only property is `name`.
 *
 * Vite's option union admits a bare `{ name: string }` beside its plugin type, and that
 * shape is itself a valid plugin — so dropping it loses a caller nothing and leaves the
 * result the plugin type, where an unfiltered extraction would report a union whose other
 * member carries no hooks and would need annotating away at every call site.
 */
type NamedOption<T> = T extends { name: string } ? (keyof T extends 'name' ? never : T) : never;

/**
 * The option a plugin list carries under `name`, or `undefined`.
 *
 * Generic over the element type rather than written against a bundler's own, so the
 * package this lives in depends on no bundler while a caller still reads its plugin type
 * back. An option can also be a nested list, a promise, or a falsy placeholder; none of
 * those carries a name, so the property test is the whole narrowing.
 */
export function pluginNamed<T>(
  options: readonly T[] | undefined,
  name: string
): NamedOption<T> | undefined {
  return (options ?? []).find(
    (option): option is NamedOption<T> =>
      option !== null && typeof option === 'object' && 'name' in option && option.name === name
  );
}
