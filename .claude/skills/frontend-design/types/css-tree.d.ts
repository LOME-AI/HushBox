/**
 * The css-tree surface the static engine drives. The package ships no
 * declarations, and the shape here is the one the cascade actually calls —
 * declared at that surface rather than at the library's whole API, so a
 * declaration that drifts from the package fails here instead of widening to
 * an untyped import.
 */
declare module 'css-tree' {
  export function parse(text: string, options?: unknown): unknown;
  export function generate(node: unknown): string;
}
