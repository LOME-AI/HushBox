/* global process */
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

import { defaultClientConditions } from 'vite';

import path from 'node:path';

import { GROWTH_BEACON_PATH } from '../../packages/shared/src/growth/beacon.ts';
import { frontendEnvFilePlugin } from '../../scripts/lib/bundling/build-mode.ts';
import {
  BUILD_TARGET,
  ORT_EXTERN_WASM_CONDITION,
  TTS_WORKER_SCAN_ENTRY,
  WORKER_BUILD_OPTIONS,
  ortAssetsPlugin,
} from '../../scripts/lib/bundling/seam.ts';

/**
 * A generated port, read fail-fast. `pnpm generate:env` writes one variable per
 * declared port key, so an absent variable means the environment was never
 * generated or the command ran outside `scripts/with-env.ts`; resolving that to
 * a literal default is the silent env fallback CODE-RULES bans.
 */
function requirePort(name) {
  const port = Number(process.env[name]);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`${name} is not set — run pnpm generate:env first`);
  }
  return port;
}

/**
 * Binds the dev and preview servers to the generated port. It rides an
 * integration rather than a static `server.port` because this file is evaluated
 * for `astro build` too, which serves nothing and runs in a CI job that
 * generates no env — the same split `apps/web/vite.config.ts` makes on Vite's
 * `serve` command.
 */
export const serverPortIntegration = {
  name: 'hushbox-server-port',
  hooks: {
    'astro:config:setup'({ command, updateConfig }) {
      if (command !== 'dev' && command !== 'preview') return;
      updateConfig({ server: { port: requirePort('HB_ASTRO_PORT') } });
    },
  },
};

/**
 * Puts the beacon path on the page's OWN origin under `astro dev`.
 *
 * The marketing pages' anonymous counter posts to that path on whatever origin
 * served the page: in production a zone route puts it on the product Worker, and
 * a PROXY — never a redirect — is what reproduces that locally. The proxy's own
 * contribution is that the post stays same-origin: the browser addresses the
 * page's own origin, and the hop to the Worker is the dev server's own request
 * rather than a second browser one, which is what a redirect would produce; it
 * is no credential filter, and a post sent with credentials traverses it
 * carrying the session cookie. What keeps the count anonymous is the sender
 * and the cookie's scope: the beacon posts `credentials: 'omit'`
 * (`packages/ui/src/components/growth/init-script.ts`), and the production
 * session cookie declares no domain attribute, so it is host-only on the API
 * host. `changeOrigin` rewrites only the Host header, so the page's `Origin`
 * still reaches the Worker's check. Without this the counter posts into nothing
 * on every development stack.
 *
 * A regular expression rather than the path: Vite matches a string key by
 * PREFIX, so the bare path would also swallow every future page whose path
 * starts with those bytes.
 *
 * It rides an integration, and reads the port inside the hook, for the reason
 * {@link serverPortIntegration} does: this file is evaluated for `astro build`
 * too, which proxies nothing and runs in a CI job that generates no env.
 */
export const beaconProxyIntegration = {
  name: 'hushbox-beacon-proxy',
  hooks: {
    'astro:config:setup'({ command, updateConfig }) {
      if (command !== 'dev') return;
      const apiPort = requirePort('HB_API_PORT');
      updateConfig({
        vite: {
          server: {
            proxy: {
              [String.raw`^${GROWTH_BEACON_PATH}(\?.*)?$`]: {
                target: `http://localhost:${apiPort}`,
                changeOrigin: true,
              },
            },
          },
        },
      });
    },
  },
};

// Paths the marketing dev server hands off to the Vite app: SPA routes the real
// app owns (auth, chat) plus `/demo`, the embedded product-demo SPA. Production
// uses the generated `_headers` instead of this dev-only redirect.
const SPA_REDIRECT_PATHS = new Set([
  '/login',
  '/login/',
  '/signup',
  '/signup/',
  '/chat',
  '/chat/',
  '/demo',
  '/demo/',
]);

/**
 * Hands {@link SPA_REDIRECT_PATHS} to the Vite app's dev server. The app's port
 * is read per redirect rather than when the server is configured, because
 * `astro build` creates a Vite server of its own for its sync step — so
 * `configureServer` runs in the CI build job, which generates no env, while a
 * redirect only ever happens under `astro dev`.
 */
export function spaRedirectPlugin() {
  return {
    name: 'spa-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (SPA_REDIRECT_PATHS.has(url)) {
          const vitePort = requirePort('HB_VITE_PORT');
          res.writeHead(302, { Location: `http://localhost:${vitePort}${url}` });
          res.end();
          return;
        }
        next();
      });
    },
  };
}

export default defineConfig({
  site: 'https://hushbox.ai',
  integrations: [mdx(), react(), sitemap(), serverPortIntegration, beaconProxyIntegration],
  // Set explicitly because Astro's default changed to `'jsx'`, which drops
  // inter-element whitespace that contains a newline, per JSX rules: a
  // `<span>a</span>` and `<em>b</em>` written on separate lines render as `ab`,
  // while the same two on one line keep their space. Since markup is wrapped
  // for readability, that silently closes up rendered text. `true` keeps the
  // whitespace-preserving collapse the marketing HTML was written against.
  // Changing this is a visual decision about the site, not a default to inherit.
  compressHTML: true,
  // CSP hashes for inline scripts are produced by `scripts/generate-headers.ts`,
  // which walks built HTML directly and hashes every inline <script> body,
  // however it was emitted. Astro's own `experimental.csp` is deliberately NOT
  // enabled: it only hashes scripts it owns and skips `<script is:inline>`, so
  // every project-authored inline script would be missing its hash and blocked
  // in production. Doing all hashing in the generator gives one source of truth.
  //
  // Known limitation: code blocks in MDX go through Shiki, which emits
  // per-token inline style="color:#..." attributes that cannot be hashed.
  // No blog post currently uses code fences. Adding one will fail the e2e
  // regression test once style-src drops 'unsafe-inline'.
  vite: {
    // Astro's `server` option carries no strictPort of its own, and Vite's
    // default is to walk up to the next free port: an orphaned dev server keeps
    // this one, the replacement binds elsewhere without complaint, and the web
    // dev server goes on redirecting to the stale origin while crawler-view
    // goes on fetching it. Fail on the taken port instead, so a leftover
    // process is reported rather than served.
    server: { strictPort: true },
    // Read env files from the repo root, where `pnpm generate:env` writes the
    // frontend ones, instead of from `apps/marketing/`. Mirrors the same
    // override in `apps/web/vite.config.ts`, so a build given a mode resolves
    // the same file for both apps.
    envDir: '../..',
    // Astro overrides Vite's default `envPrefix` from `VITE_` to `PUBLIC_`,
    // which would skip `VITE_API_URL` substitution in client islands. Restore
    // `VITE_` alongside `PUBLIC_` so the var defined in envConfig (and shared
    // with `apps/web`) reaches browser code.
    envPrefix: ['PUBLIC_', 'VITE_'],
    build: {
      // The syntax floor this site's client chunks are lowered to. Astro sets
      // `esnext` in the config it merges ours into, so without this the pages
      // that get merged into the web bundle ship at whatever the toolchain
      // happens to allow, while the app's own chunks stay at the pinned floor —
      // and the merged origin is served to the same iOS WebView either way.
      // Astro applies this to its server build too; that code only ever runs
      // under Node at build time, where lowered syntax is inert.
      //
      // The floor also drives CSS prefixing, so the emitted stylesheet is not
      // the same at a higher target: Safari below 18 understands only
      // `-webkit-backdrop-filter`, so `backdrop-blur-*` renders as a no-op on
      // iOS 16.4-17 unless this floor emits that prefixed form.
      //
      // Tailwind scans this file, so a bare utility name written here emits a
      // real rule into the shipped stylesheet.
      target: BUILD_TARGET,
    },
    // ES-format workers keep `new.target` intact, which the TTS worker's
    // transformers dependency needs to load at all (see the constant).
    worker: WORKER_BUILD_OPTIONS,
    optimizeDeps: {
      // Prebundles kokoro-js at startup instead of on the first Listen click,
      // which would otherwise force a full-page reload (see the constant).
      // Unlike plain Vite, this does not replace a default: Astro sets its own
      // srcDir scan entry in the inline config it merges ours into, and Vite's
      // config merge concatenates arrays, so both entries survive.
      entries: [TTS_WORKER_SCAN_ENTRY],
    },
    resolve: {
      // Picks onnxruntime-web's extern-wasm build variant so the blog TTS
      // worker does not drag a bundled ~21 MB wasm copy into the output
      // alongside the self-hosted one ortAssetsPlugin emits (see the
      // constant's own comment). `conditions` REPLACES Vite's defaults, so the
      // spread is load-bearing: without it, module/browser resolution breaks
      // across the whole site. Astro passes user `resolve.conditions` through
      // untouched (its own create-vite.js sets none).
      conditions: [ORT_EXTERN_WASM_CONDITION, ...defaultClientConditions],
    },
    plugins: [
      // The mode this build resolves is named on its command line by
      // `scripts/build-marketing-site.ts`, derived there from the stack the
      // environment names; the site builder merges that resolved mode into the
      // bundler configuration it constructs, which is how this guard sees it.
      frontendEnvFilePlugin(path.resolve(import.meta.dirname, '../..')),
      tailwindcss(),
      // Self-hosts the onnxruntime-web WASM runtime same-origin (under
      // ORT_WASM_PATH) so the blog "Listen" TTS engine loads under the CSP
      // with no third-party CDN. Shared with the web (Vite) build.
      ortAssetsPlugin(),
      spaRedirectPlugin(),
    ],
  },
  outDir: 'dist',
  build: {
    format: 'directory',
  },
});
