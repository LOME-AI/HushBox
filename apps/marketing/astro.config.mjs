/* global process */
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';
import react from '@astrojs/react';
import sitemap from '@astrojs/sitemap';
import tailwindcss from '@tailwindcss/vite';

const vitePort = process.env['HB_VITE_PORT'] ?? '5173';
const astroPort = process.env['HB_ASTRO_PORT'];

export default defineConfig({
  site: 'https://hushbox.ai',
  integrations: [mdx(), react(), sitemap()],
  // CSP hashes for inline scripts are produced by `scripts/generate-headers.ts`,
  // which walks built HTML directly and hashes every <script> body (Astro-emitted
  // and `is:inline` project scripts alike). Astro's own `experimental.csp` is
  // deliberately NOT enabled: it only hashes scripts it owns and skips
  // `<script is:inline>`, so the four project-authored bootstrap scripts
  // (theme, a11y, menu toggle, scroll arrow) would be missing hashes and
  // blocked in production. Doing all hashing in the generator gives us one
  // source of truth and covers every inline script regardless of how it was
  // emitted.
  //
  // TODO: code blocks in MDX go through Shiki, which emits per-token inline
  // style="color:#..." attributes that cannot be hashed. No blog post
  // currently uses code fences. Adding one will fail the e2e regression test
  // once style-src drops 'unsafe-inline'.
  server: {
    port: Number(astroPort ?? 4321),
  },
  vite: {
    // Read env files from the repo root (where `pnpm generate:env` writes
    // `.env.development`) instead of `apps/marketing/`. Mirrors the same
    // override in `apps/web/vite.config.ts` so both apps see the single
    // generated env file.
    envDir: '../..',
    // Astro 5 overrides Vite's default `envPrefix` from `VITE_` to `PUBLIC_`,
    // which would skip `VITE_API_URL` substitution in client islands. Restore
    // `VITE_` alongside `PUBLIC_` so the var defined in envConfig (and shared
    // with `apps/web`) reaches browser code. See
    // node_modules/astro/dist/core/create-vite.js:147.
    envPrefix: ['PUBLIC_', 'VITE_'],
    plugins: [
      tailwindcss(),
      {
        name: 'spa-redirect',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url?.split('?')[0] ?? '';
            if (
              url === '/login' ||
              url === '/login/' ||
              url === '/signup' ||
              url === '/signup/' ||
              url === '/chat' ||
              url === '/chat/'
            ) {
              res.writeHead(302, { Location: `http://localhost:${vitePort}${url}` });
              res.end();
              return;
            }
            next();
          });
        },
      },
    ],
  },
  outDir: 'dist',
  build: {
    format: 'directory',
  },
});
