/**
 * Asserts a build-time frontend variable carries a value, returning it or
 * throwing a message that names it.
 *
 * The caller reads the variable and passes the value: bundlers resolve
 * `import.meta.env` by statically replacing literal key access, so a helper
 * that indexed it with a name passed as an argument would read nothing. In
 * Astro's build-time frontmatter the runtime object holds no `VITE_*` key at
 * all, and `vi.stubEnv` likewise reaches only literal access, so such a helper
 * would break the marketing build and leave every failure-path test passing
 * without testing the failure. Hence the value parameter.
 *
 * `value` is `unknown` because that is what `import.meta.env` indexing yields;
 * narrowing it here rather than asserting a type at each call site keeps the
 * callers free of casts.
 */
export function requireEnv(name: string, value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} is required. Check envConfig and run pnpm generate:env.`);
  }
  return value;
}
