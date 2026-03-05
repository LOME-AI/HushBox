/* global process */
import { defineConfig } from 'astro/config';
import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';

const vitePort = process.env['HB_VITE_PORT'] ?? '5173';
const astroPort = process.env['HB_ASTRO_PORT'];

export default defineConfig({
  integrations: [react()],
  server: {
    port: Number(astroPort ?? 4321),
  },
  vite: {
    plugins: [
      tailwindcss(),
      {
        name: 'spa-redirect',
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            const url = req.url?.split('?')[0] ?? '';
            if (
              url === '/' ||
              url === '/login' ||
              url === '/login/' ||
              url === '/signup' ||
              url === '/signup/'
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
