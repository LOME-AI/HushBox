/**
 * Shapes for the lint plugins that ship no declarations of their own.
 *
 * Each is declared at the surface this repository's flat config actually
 * reaches — the plugin object it registers and the named config it spreads —
 * rather than at the plugin's full published API. Declaring the config records
 * as index signatures was tried and rejected: under `noUncheckedIndexedAccess`
 * every lookup then carries `undefined`, which widens the inferred element type
 * of the whole config array and rejects every entry in it, not just the lookup.
 */

declare module 'eslint-plugin-jsx-a11y' {
  import type { ESLint, Linter } from 'eslint';

  const plugin: ESLint.Plugin & {
    readonly flatConfigs: { readonly recommended: Linter.Config };
  };
  export default plugin;
}

declare module 'eslint-plugin-promise' {
  import type { ESLint, Linter } from 'eslint';

  const plugin: ESLint.Plugin & {
    readonly configs: { readonly 'flat/recommended': Linter.Config };
  };
  export default plugin;
}
