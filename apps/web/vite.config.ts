import { defaultClientConditions, defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'path';
import { transformStreamdownSource } from './src/lib/platform/inline-streamdown-lazy-imports.ts';
import { resolveDeviceKeyStoreE2eVariant } from './src/lib/device-key-store-e2e-resolution.ts';
import { previewDirectoryIndexFallback } from './src/lib/platform/preview-directory-index-fallback.ts';
import { serviceWorkerBuildPlugin } from './src/lib/platform/service-worker-build-plugin.ts';
import { GROWTH_BEACON_PATH } from '../../packages/shared/src/growth/beacon.ts';
import { headersPlugin } from '../../scripts/lib/bundling/headers-vite-plugin.ts';
import { prePaintScriptsPlugin } from '../../scripts/lib/bundling/pre-paint-scripts-plugin.ts';
import { E2E_BUILD_FLAG_NAME, requiredE2eBuildFlagValue } from '../../scripts/verify-bundle.ts';
import { missingPortVariable } from '../../scripts/lib/stack/generated-port.ts';
import { stackModeFrom } from '../../scripts/lib/stack/stack-mode.ts';
import { buildEnvMode, frontendEnvFilePlugin } from '../../scripts/lib/bundling/build-mode.ts';
import {
  BUILD_TARGET,
  ORT_EXTERN_WASM_CONDITION,
  PREDICTION_WORKER_SCAN_ENTRY,
  TTS_WORKER_SCAN_ENTRY,
  WORKER_BUILD_OPTIONS,
  ortAssetsPlugin,
} from '../../scripts/lib/bundling/seam.ts';

const envDir = resolve(import.meta.dirname, '../..');

// Both halves of the end-to-end build flag — the env registry entry's name and
// the value an E2E build bakes for it — come from the bundle verifier, which is
// where each is declared and which decides from them which dists may carry the
// localStorage device-key store. Either half written down here instead would be
// a second declaration free to drift out of agreement with the verifier's while
// both files still pass.
const E2E_BUILD_FLAG_VALUE = requiredE2eBuildFlagValue();

/**
 * Whether a build minifies its output.
 *
 * The mode is one value doing two jobs here: it selects the frontend env file
 * Vite loads, and it decides this. Pointing an end-to-end build at its own env
 * file therefore also decides whether that bundle is readable, and the two
 * questions have different answers — both local stacks ship readable bytes (the
 * development build for the dev server, the e2e build because a failing spec is
 * read from the bytes it ran against), while a shipping build minifies.
 *
 * The end-to-end half keys on the baked flag rather than on a mode name, so it
 * holds for every mode that bakes an end-to-end frontend env — local and CI
 * alike, which arrive under different mode names.
 */
export function shouldMinify(mode: string, isE2eBuild: boolean): boolean {
  return mode !== 'development' && !isE2eBuild;
}

function apiPreconnectPlugin(apiUrl: string | undefined): Plugin {
  return {
    name: 'api-preconnect',
    transformIndexHtml() {
      if (!apiUrl) return [];
      try {
        const origin = new URL(apiUrl).origin;
        if (origin === 'http://localhost' || origin.startsWith('http://localhost:')) return [];
        return [
          {
            tag: 'link',
            attrs: { rel: 'preconnect', href: origin, crossorigin: true },
            injectTo: 'head',
          },
        ];
      } catch {
        return [];
      }
    },
  };
}

function marketingRedirectPlugin(): Plugin {
  const astroPort = process.env['HB_ASTRO_PORT']!;
  return {
    name: 'marketing-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (url === '/') {
          res.writeHead(301, { Location: `http://localhost:${astroPort}/welcome` });
          res.end();
          return;
        }
        if (
          url === '/welcome' ||
          url === '/welcome/' ||
          url === '/privacy' ||
          url === '/privacy/' ||
          url === '/terms' ||
          url === '/terms/'
        ) {
          res.writeHead(302, { Location: `http://localhost:${astroPort}${url}` });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

// E2E builds ({@link E2E_BUILD_FLAG_NAME} baked into the env files) swap the
// device-key store for its storageState-capturable localStorage variant at
// module-resolution time — never via a runtime env.isE2E dynamic import(),
// whose cancellable chunk fetch blanked guest share routes when a navigation
// raced it. `enforce: 'pre'` so the remap wins before Vite's own resolver
// handles the `@/` alias.
function deviceKeyStoreE2eVariantPlugin(): Plugin {
  const e2eModulePath = resolve(import.meta.dirname, 'src/lib/device-key-store.e2e.ts');
  return {
    name: 'device-key-store-e2e-variant',
    enforce: 'pre',
    resolveId(source, importer) {
      return resolveDeviceKeyStoreE2eVariant(source, importer, e2eModulePath);
    },
  };
}

function inlineStreamdownLazyImports(): Plugin {
  return {
    name: 'inline-streamdown-lazy-imports',
    apply: 'build',
    transform(code, id) {
      if (!id.includes('node_modules') || !id.includes('streamdown')) return null;
      const result = transformStreamdownSource(code);
      return result ? { code: result, map: null } : null;
    },
  };
}

function devAssetsPlugin(): Plugin {
  const assetsDir = resolve(import.meta.dirname, 'resources/assets');
  return {
    name: 'dev-assets',
    configureServer(server) {
      server.middlewares.use('/dev-assets', (req, res, next) => {
        const relativePath = (req.url ?? '').split('?')[0];
        if (!relativePath) return next();

        const filePath = resolve(assetsDir, `.${relativePath}`);
        if (!filePath.startsWith(assetsDir)) {
          res.statusCode = 403;
          res.end();
          return;
        }

        res.setHeader('Content-Type', 'image/png');
        createReadStream(filePath)
          .on('error', () => {
            res.statusCode = 404;
            res.end();
          })
          .pipe(res);
      });
    },
  };
}

function sharedFaviconPlugin(): Plugin {
  const faviconPath = resolve(import.meta.dirname, '../../packages/ui/src/assets/favicon.ico');
  return {
    name: 'shared-favicon',
    configureServer(server) {
      server.middlewares.use('/favicon.ico', (_req, res) => {
        res.setHeader('Content-Type', 'image/x-icon');
        createReadStream(faviconPath).pipe(res);
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'favicon.ico',
        source: readFileSync(faviconPath),
      });
    },
  };
}

// Serves the PWA manifest's app icon at a stable `/icon.png`, emitted from the
// single canonical app-icon source (shared with the native asset generator) so
// there is no committed duplicate. Mirrors sharedFaviconPlugin.
function pwaIconPlugin(): Plugin {
  const iconPath = resolve(import.meta.dirname, 'resources/assets/icon-only.png');
  return {
    name: 'pwa-icon',
    configureServer(server) {
      server.middlewares.use('/icon.png', (_req, res) => {
        res.setHeader('Content-Type', 'image/png');
        createReadStream(iconPath).pipe(res);
      });
    },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'icon.png', source: readFileSync(iconPath) });
    },
  };
}

export default defineConfig(({ command }) => {
  // Every build bundles React's production build, the one users run: the
  // bundler reads NODE_ENV only after this runs, and an end-to-end build runs
  // with `development` in its environment. The dev server keeps development.
  if (command === 'build') process.env['NODE_ENV'] = 'production';

  // The mode is derived from the mode the environment names rather than taken
  // from a command line, so every way this app is built — the task runner, the
  // native workflows, the mobile loop — resolves one answer, and a build that
  // named none is refused rather than given a default. Returned below as
  // `mode`, which is what the bundler resolves its own against: a config's mode
  // beats the default and loses to a `--mode` argument, and no command writes
  // one (`scripts/root-chain-stacks.test.ts` is where that is enforced).
  const mode = buildEnvMode(process.env);
  const env = loadEnv(mode, envDir, 'VITE_');

  // The port only feeds the dev server; `vite build` never reads `server.port`.
  // Guard `serve` only, so the CI build job needs no generated env.
  const vitePort = Number(process.env['HB_VITE_PORT']);
  if (command === 'serve' && (!Number.isFinite(vitePort) || vitePort <= 0)) {
    throw new Error(missingPortVariable('HB_VITE_PORT', stackModeFrom(process.env)));
  }

  // The Worker's port, for the beacon proxy below. `vite preview` resolves its
  // config with `command === 'serve'` too, so this one guard covers both
  // servers and the CI build job still needs no generated env.
  const apiPort = Number(process.env['HB_API_PORT']);
  if (command === 'serve' && (!Number.isFinite(apiPort) || apiPort <= 0)) {
    throw new Error(missingPortVariable('HB_API_PORT', stackModeFrom(process.env)));
  }

  const isE2eBuild = env[E2E_BUILD_FLAG_NAME] === E2E_BUILD_FLAG_VALUE;

  return {
    mode,
    envDir,
    // Not Vite's default: any server rooted in this app that names no cache resolves that
    // default, and one started there with a different config deletes its pre-bundled deps,
    // leaving this server answering 504 for every one it had not yet served.
    cacheDir: resolve(import.meta.dirname, 'node_modules/.vite/dev'),
    plugins: [
      frontendEnvFilePlugin(envDir),
      ...(isE2eBuild ? [deviceKeyStoreE2eVariantPlugin()] : []),
      tailwindcss(),
      TanStackRouterVite({
        quoteStyle: 'single',
        routeFileIgnorePattern: '.*\\.test\\.tsx?$',
        autoCodeSplitting: true,
      }),
      react(),
      apiPreconnectPlugin(env['VITE_API_URL']),
      prePaintScriptsPlugin(),
      inlineStreamdownLazyImports(),
      sharedFaviconPlugin(),
      pwaIconPlugin(),
      serviceWorkerBuildPlugin(resolve(import.meta.dirname, 'src/sw/sw.ts')),
      // Self-hosts the onnxruntime-web WASM runtime same-origin (under
      // ORT_WASM_PATH) so the on-device engines that load through it — the TTS
      // voice and the sentence-completion predictor — run under the CSP with no
      // third-party CDN. Shared with the marketing (Astro) build.
      ortAssetsPlugin(),
      devAssetsPlugin(),
      marketingRedirectPlugin(),
      // Must run BEFORE previewDirectoryIndexFallback so we match against the
      // original request URL (/welcome) rather than the rewritten one
      // (/welcome/index.html).
      headersPlugin(),
      previewDirectoryIndexFallback(),
    ],
    build: {
      minify: shouldMinify(mode, isE2eBuild),
      target: BUILD_TARGET,
    },
    // ES-format workers keep `new.target` intact, which the TTS worker's
    // transformers dependency needs to load at all (see the constant).
    worker: WORKER_BUILD_OPTIONS,
    optimizeDeps: {
      // Setting `entries` REPLACES Vite's default `**/*.html` glob, so the
      // default is restated here: dropping it silently shrinks the cold-start
      // dep cache by an order of magnitude (only the workers' own subtrees get
      // prebundled) with no error, just a slower dev server. One entry per
      // worker, because the scanner crosses neither one's `new Worker(new
      // URL(…))` edge and each keeps its own library out of late discovery
      // (see the constants).
      entries: ['**/*.html', TTS_WORKER_SCAN_ENTRY, PREDICTION_WORKER_SCAN_ENTRY],
    },
    resolve: {
      // Picks onnxruntime-web's extern-wasm build variant so the TTS worker
      // does not drag a bundled ~21 MB wasm copy into the output alongside the
      // self-hosted one ortAssetsPlugin emits (see the constant's own comment).
      // `conditions` REPLACES Vite's defaults, so the spread is load-bearing:
      // without it, module/browser resolution breaks across the whole app.
      conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions],
      alias: {
        // An E2E build takes its sentence-completion predictor from the
        // deterministic variant instead of the production module, which offers
        // none — so a rendered check can drive the composer's hint without a
        // model, a network or a clock. Selected here rather than by a runtime
        // branch so a production bundle cannot contain the variant at all.
        // Alias entries are matched in order and `@` prefix-matches everything
        // under it, so this one only works while it sits above `@`.
        ...(isE2eBuild
          ? {
              '@/lib/prediction/prompt-predictor': resolve(
                import.meta.dirname,
                'src/lib/prediction/prompt-predictor.e2e.ts'
              ),
            }
          : {}),
        '@': resolve(import.meta.dirname, './src'),
      },
    },
    preview: {
      strictPort: true,
      // The marketing pages' anonymous counter posts to this path on the page's
      // OWN origin: in production a zone route puts it on the product Worker.
      // This proxy plays that role for the merged bundle `vite preview` serves,
      // so a beacon counts locally exactly as it does deployed — without it the
      // counter is silent on every local stack and no end-to-end check of it
      // can exist. `changeOrigin` rewrites only the Host header, leaving the
      // page's Origin for the Worker's own check (the admin proxy states the
      // same reason).
      //
      // What keeps the count anonymous on every stack is the sender omitting credentials. The
      // session cookie declares no domain attribute, so in production it is host-only on the API
      // host, not the apex the zone route is claimed on; on a localhost stack it is in scope.
      //
      // A regular expression rather than the path: Vite matches a string key by
      // PREFIX, so `/e` would also swallow every future page whose path starts
      // with those bytes.
      proxy: {
        [`^${GROWTH_BEACON_PATH}(\\?.*)?$`]: {
          target: `http://localhost:${String(apiPort)}`,
          changeOrigin: true,
        },
      },
    },
    server: {
      port: vitePort,
      strictPort: true,
      proxy: {
        '/api/ws': {
          target: env['VITE_API_URL']!,
          ws: true,
        },
      },
    },
  };
});
