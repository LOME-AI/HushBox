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
  server: {
    port: Number(astroPort ?? 4321),
  },
  vite: {
    // Read env files from the repo root (where `pnpm generate:env` writes
    // `.env.development`) instead of `apps/marketing/`. Mirrors the same
    // override in `apps/web/vite.config.ts` so both apps see the single
    // generated env file.
    envDir: '../..',
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
