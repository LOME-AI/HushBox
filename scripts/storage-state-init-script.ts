/**
 * Convert the `origins` half of a Playwright storage state JSON into an
 * equivalent `addInitScript` body. Playwright applies origins by navigating
 * each new context to the origin and waiting for `load` before setting
 * localStorage — under parallel CI load this can take seconds (and on
 * firefox sometimes exceeds the per-test timeout). An init script runs
 * before any user script on every navigation, so injecting localStorage
 * this way is observably identical at constant CDP-level cost.
 *
 * Each setItem is guarded by `getItem === null` so persona values seed only
 * on first navigation; subsequent reloads preserve whatever the test wrote.
 * Without this, persona-seeded keys like `hushbox-model-storage` clobber
 * test mutations every reload, silently failing persistence assertions.
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
    o.localStorage.map((item) => {
      const name = JSON.stringify(item.name);
      const value = JSON.stringify(item.value);
      return (
        `if (location.origin === ${JSON.stringify(o.origin)} && ` +
        `window.localStorage.getItem(${name}) === null) ` +
        `window.localStorage.setItem(${name}, ${value});`
      );
    })
  );
  return lines.length === 0 ? null : lines.join('\n');
}
