/**
 * Convert the `origins` half of a Playwright storage state JSON into an
 * equivalent `addInitScript` body. Playwright applies origins by navigating
 * each new context to the origin and waiting for `load` before setting
 * localStorage — under parallel CI load this can take seconds (and on
 * firefox sometimes exceeds the per-test timeout). An init script runs
 * before any user script on every navigation, so injecting localStorage
 * this way is observably identical at constant CDP-level cost.
 *
 * `null` return means there is nothing to inject (no origins, or all
 * origins have empty localStorage).
 */

export interface StorageStateOrigin {
  readonly origin: string;
  readonly localStorage: readonly { name: string; value: string }[];
}

export interface RawStorageState {
  readonly cookies: unknown[];
  readonly origins?: readonly StorageStateOrigin[];
}

export function buildStorageInitScript(raw: RawStorageState): string | null {
  const origins = raw.origins ?? [];
  const lines = origins.flatMap((o) =>
    o.localStorage.map(
      (item) =>
        `if (location.origin === ${JSON.stringify(o.origin)}) ` +
        `window.localStorage.setItem(${JSON.stringify(item.name)}, ${JSON.stringify(item.value)});`
    )
  );
  return lines.length === 0 ? null : lines.join('\n');
}
