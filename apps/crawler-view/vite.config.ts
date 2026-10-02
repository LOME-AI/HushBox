import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { crawlerApiPlugin } from './src/server/crawler-api-plugin.ts';

const envDir = resolve(import.meta.dirname, '../..');

export default defineConfig(({ command }) => {
  // The port only feeds the dev server; this app is never built (no `build`
  // script), so guard `serve` only.
  const crawlerPort = Number(process.env['HB_CRAWLER_VIEW_PORT']);
  if (command === 'serve' && (!Number.isFinite(crawlerPort) || crawlerPort <= 0)) {
    throw new Error('HB_CRAWLER_VIEW_PORT is not set — run pnpm generate:env first');
  }

  return {
    envDir,
    plugins: [tailwindcss(), react(), crawlerApiPlugin()],
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, './src'),
      },
    },
    // No `host`, so Vite binds loopback. That binding is what makes the
    // unrestricted fetch proxy in `apps/crawler-view/src/server/handlers.ts` an accepted risk
    // rather than a network-reachable one; a `host` here or a `--host` on the
    // `dev` script reopens it. Both are pinned by
    // `apps/crawler-view/src/server/loopback-binding.test.ts`.
    server: {
      port: crawlerPort,
      strictPort: true,
    },
  };
});
