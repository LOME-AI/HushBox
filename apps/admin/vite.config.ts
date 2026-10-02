import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { stripApiPrefix } from './src/lib/api-proxy.ts';
import { marketingPreviewIndexPlugin } from './src/lib/marketing-preview-index.ts';
import { headersPlugin } from '../../scripts/lib/bundling/headers-vite-plugin.ts';
import { prePaintScriptsPlugin } from '../../scripts/lib/bundling/pre-paint-scripts-plugin.ts';
import { BUILD_TARGET } from '../../scripts/lib/bundling/seam.ts';
import { generateAdminHeaders } from '../../scripts/generate-headers.ts';
import { appBundleOptions, verifyBundle } from '../../scripts/verify-bundle.ts';
import { missingPortVariable } from '../../scripts/lib/stack/generated-port.ts';
import { stackModeFrom } from '../../scripts/lib/stack/stack-mode.ts';
import { buildEnvMode, frontendEnvFilePlugin } from '../../scripts/lib/bundling/build-mode.ts';
import type { Plugin } from 'vite';

const rootDir = resolve(import.meta.dirname, '../..');
const distDir = resolve(import.meta.dirname, 'dist');

// After `vite build`, finish the dist: emit dist/_headers so the assets-only
// admin Worker serves the CSP + X-Frame-Options: DENY + HSTS stack on
// admin.hushbox.ai, then verify the finished bundle. Headers are built here
// (not a separate script step like the web bundle's) because admin has no
// marketing-merge to sequence around; `closeBundle` runs once the shell's inline
// pre-paint scripts are written, which generateAdminHeaders hashes into the CSP.
//
// Verification lives in this hook, not a second plugin, because the order is
// load-bearing: `_headers` is an emitted file and the Cloudflare Pages
// file-count check counts it, so it must exist before verifyBundle runs. One
// hook makes that ordering explicit instead of resting on how the bundler
// schedules `closeBundle` across plugins — which is not a fixed guarantee:
// Rollup starts parallel hooks together, Rolldown runs them sequentially.
function finalizeAdminDistPlugin(): Plugin {
  return {
    name: 'finalize-admin-dist',
    apply: 'build',
    async closeBundle() {
      await generateAdminHeaders({ distDir });
      await verifyBundle(appBundleOptions(rootDir, 'apps/admin'));
    },
  };
}

export default defineConfig(({ command }) => {
  // Every build bundles React's production build, the one users run: the
  // bundler reads NODE_ENV only after this runs, and an end-to-end build runs
  // with `development` in its environment. The dev server keeps development.
  if (command === 'build') process.env['NODE_ENV'] = 'production';

  // The mode is derived from the mode the environment names rather than taken
  // from a command line, so every way this app is built resolves one answer,
  // and a build that named none is refused rather than given a default.
  // Returned below as `mode`, which is what the bundler resolves its own
  // against: a config's mode beats the default and loses to a `--mode`
  // argument, and no command writes one
  // (`scripts/root-chain-stacks.test.ts` is where that is enforced).
  const mode = buildEnvMode(process.env);

  // Ports feed the dev server and the `vite preview` build; `vite build`
  // reads neither `server.*` nor `preview.*`. `vite preview` resolves config
  // with `command === 'serve'`, so this one guard covers dev and preview,
  // while the CI build job (`command === 'build'`) needs no generated env.
  const adminPort = Number(process.env['HB_ADMIN_PORT']);
  const apiPort = Number(process.env['HB_API_PORT']);
  if (command === 'serve' && (!Number.isFinite(adminPort) || adminPort <= 0)) {
    throw new Error(missingPortVariable('HB_ADMIN_PORT', stackModeFrom(process.env)));
  }
  if (command === 'serve' && (!Number.isFinite(apiPort) || apiPort <= 0)) {
    throw new Error(missingPortVariable('HB_API_PORT', stackModeFrom(process.env)));
  }

  // The SPA always calls relative `/api/*`. In production Cloudflare routes
  // `admin.hushbox.ai/api/*` to the product Worker; locally this proxy plays
  // that role, stripping the `/api` prefix so the Worker sees its real
  // root-mounted paths (`/admin/...`, `/dev/...`). Shared by the dev server
  // and the `vite preview` static build (the admin e2e suite targets the
  // preview), so both reach the Worker identically. See src/lib/api-client.ts
  // for the full mapping.
  const apiProxy = {
    '/api': {
      target: `http://localhost:${String(apiPort)}`,
      rewrite: stripApiPrefix,
      // The browser's origin is forwarded as-is: the Worker's CSRF Origin
      // check admits the configured ADMIN_URL (the local admin origin in
      // development mode). changeOrigin rewrites only the Host header to the
      // target — load-bearing, not cosmetic: wrangler dev rewrites an Origin
      // header that MATCHES the request Host (same-origin shape) to its
      // internal origin, which would fail the Worker's allowlist. With Host
      // rewritten, the true Origin survives to the CSRF check, same as
      // production.
      changeOrigin: true,
    },
  };

  return {
    mode,
    envDir: rootDir,
    build: {
      target: BUILD_TARGET,
    },
    plugins: [
      frontendEnvFilePlugin(rootDir),
      tailwindcss(),
      TanStackRouterVite({
        quoteStyle: 'single',
        routeFileIgnorePattern: '.*\\.test\\.tsx?$',
        autoCodeSplitting: true,
      }),
      react(),
      // Resolves a directory request under the preview prefix to that
      // directory's index file, so the development server answers the URL the
      // click overlay frames with the copied marketing page, as the preview
      // server and production already do. Writes no response header: the
      // framing policy is the generated `_headers` file's alone, and the
      // plugin's `apply: 'serve'` keeps it out of every build that writes one.
      marketingPreviewIndexPlugin(),
      prePaintScriptsPlugin(),
      finalizeAdminDistPlugin(),
      // Applies the generated _headers to `vite preview` responses, so the admin
      // E2E suite (which drives the preview build) enforces the production CSP —
      // the same mechanism the web bundle uses. Inert in dev (see plugin doc).
      headersPlugin(),
    ],
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, './src'),
      },
    },
    preview: {
      port: adminPort,
      strictPort: true,
      proxy: apiProxy,
    },
    server: {
      port: adminPort,
      strictPort: true,
      proxy: apiProxy,
    },
  };
});
