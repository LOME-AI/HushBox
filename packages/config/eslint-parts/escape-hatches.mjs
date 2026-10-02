// @ts-check

/**
 * The double-cast ban: `no-restricted-syntax` selectors refusing a cast
 * laundered through `unknown` or `never`, in the spellings the parser reads as
 * the same thing.
 *
 * A single cast claims a type the compiler can still contradict. A pair of them
 * defeats that check outright — the first widens the value to something every
 * type is assignable from, the second lands wherever the author wanted — so the
 * compiler reports nothing and the claim is never checked by anything.
 *
 * Parentheses are not nodes, so `(x as unknown) as T` and `x as unknown as T`
 * are one AST and one selector. The angle-bracket spelling of the inner half is
 * a different node and takes the second selector; the angle-bracket spelling of
 * the OUTER half is refused by `@typescript-eslint/consistent-type-assertions`
 * instead, which is why that rule is declared alongside these.
 *
 * Exported separately because flat config replaces (never merges) a rule key:
 * any config entry that sets `no-restricted-syntax` for files these also cover
 * must re-list them or the ban silently vanishes for those files.
 *
 * @type {{selector: string, message: string}[]}
 */
export const doubleCastRestrictedSyntax = [
  {
    selector: 'TSAsExpression > TSAsExpression[typeAnnotation.type=/^TS(Unknown|Never)Keyword$/]',
    message:
      'Never launder a cast through unknown/never — it asserts what nothing checks. Parse the value with a Zod schema, narrow it with a type guard, or give the stub or factory producing it a declared return type.',
  },
  {
    selector: 'TSAsExpression > TSTypeAssertion',
    message:
      'Never launder a cast through unknown/never — it asserts what nothing checks. Parse the value with a Zod schema, narrow it with a type guard, or give the stub or factory producing it a declared return type.',
  },
];

/**
 * Where a module lives, or what it is called, when it exists only so tests can
 * run — the spellings that carry no `.test.` marker of their own and so sit
 * outside the shared test-file declaration.
 *
 * Such a module stands in for a type it cannot construct: a partial of a
 * vendor's client, a response shape with the two fields under test. The cast is
 * how it says so, and the test it serves is what checks the claim.
 */
export const TEST_SUPPORT_GLOBS = [
  '**/test-support/**',
  '**/test-utils/**',
  '**/__test-fixtures-*__/**',
  '**/*-test-support.{ts,tsx}',
];
