/**
 * Serialize a value as a `<script>`-safe JSON literal: `<` is escaped so the
 * emitted text can never contain a `</script>` sequence, keeping it safe
 * wherever JSON is embedded in markup — a script element's body, or an external
 * script a page may inline.
 *
 * `JSON.stringify` alone is not enough: it escapes nothing HTML cares about, and
 * neither Astro's `set:html` nor a hand-built script body escapes on the way
 * out, so the closing tag inside a string terminates the element early and the
 * rest of the JSON is parsed as markup.
 *
 * Reached through the `@hushbox/shared/script-safe-json` subpath, never the
 * barrel: one caller is the credential-free sandbox origin, whose bundle a
 * barrel import would fill with the backend environment registry.
 */
export function scriptSafeJson(value: unknown): string {
  return JSON.stringify(value).replaceAll('<', String.raw`\u003c`);
}
