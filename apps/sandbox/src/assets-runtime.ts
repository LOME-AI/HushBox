import { unstable_startWorker } from 'wrangler';

/** The running-worker handle `unstable_startWorker` resolves to. */
type AssetsRuntimeWorker = Awaited<ReturnType<typeof unstable_startWorker>>;

/**
 * Starts Cloudflare's real assets runtime over the `wrangler.toml` at
 * `configPath`, serving `assetsDirectory`.
 *
 * The one start shape every assets-runtime suite uses.
 * `assets-runtime-persistence.test.ts` asserts a property of this call — that
 * it leaves no store beside the config — and a second spelling of the call
 * would let the one under test drift out from under that assertion.
 */
export async function startAssetsRuntime(
  configPath: string,
  assetsDirectory: string
): Promise<AssetsRuntimeWorker> {
  return unstable_startWorker({
    config: configPath,
    assets: assetsDirectory,
    // Deliberately not the config's own compatibility date: the pinned wrangler
    // carries whatever workerd its release shipped with, and a compatibility
    // date newer than that binary refuses to start. Nothing these suites assert
    // is compatibility-date governed — `_headers` matching and html handling are
    // asset-router behaviour — so the runtime is given a date it can always run
    // and the config supplies the rest.
    compatibilityDate: '2026-06-18',
    // Nothing here reads a store, and persistence left at its default fills one
    // beside the config on every run of the suite — which, pointed at this
    // package's own config, is inside the checkout.
    dev: { server: { port: 0 }, inspector: false, remote: false, persist: false },
  });
}
