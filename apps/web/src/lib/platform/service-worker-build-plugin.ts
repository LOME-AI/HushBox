import path from 'node:path';
import { build } from 'vite';
import type { Plugin, ResolvedConfig } from 'vite';

/**
 * Builds the push-only service worker as a SECOND, self-contained bundle
 * emitted to a STABLE unhashed `sw.js` — the SW URL is its identity, so a
 * hashed name is unusable, and it must be one file (a service worker cannot
 * import sibling hashed chunks). A separate Vite lib build (IIFE, inlined) runs
 * after the main bundle is written; `emptyOutDir: false` so it lands alongside
 * it in the same output directory that Pages and `cap sync` consume.
 *
 * Every input comes from the resolved config rather than from this module's own
 * location, so the worker follows the build it belongs to: the per-platform OTA
 * builds each pass their own `--outDir`, and a second copy of the outer build's
 * output directory, browser target or minify setting here would be free to
 * disagree with the one the app bundle was built under.
 */
export function serviceWorkerBuildPlugin(entry: string): Plugin {
  let config: ResolvedConfig;
  return {
    name: 'service-worker-build',
    apply: 'build',
    configResolved(resolved) {
      config = resolved;
    },
    async closeBundle() {
      await build({
        configFile: false,
        root: config.root,
        mode: config.mode,
        logLevel: 'warn',
        resolve: { alias: { '@': path.resolve(config.root, './src') } },
        build: {
          // Vite leaves `build.outDir` as written, so it is resolved here.
          outDir: path.resolve(config.root, config.build.outDir),
          emptyOutDir: false,
          minify: config.build.minify,
          target: config.build.target,
          lib: {
            entry,
            formats: ['iife'],
            name: 'hushboxServiceWorker',
            fileName: () => 'sw.js',
          },
          rolldownOptions: {
            // The worker imports only the notification schemas from the
            // `@hushbox/shared` barrel; treat modules as side-effect-free so the
            // rest of the barrel (billing, estimate, ...) tree-shakes out instead
            // of shipping in the worker bundle.
            treeshake: { moduleSideEffects: false },
          },
        },
      });
    },
  };
}
