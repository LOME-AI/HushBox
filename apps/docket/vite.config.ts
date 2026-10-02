import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'path';
import { prePaintScriptsPlugin } from '../../scripts/lib/bundling/pre-paint-scripts-plugin.ts';
import { docketApiPlugin } from './src/server/api-plugin.ts';

const repoRoot = resolve(import.meta.dirname, '../..');

export default defineConfig(({ command }) => {
  // The port only feeds the dev server; this app is never built (no `build`
  // script), so guard `serve` only.
  const docketPort = Number(process.env['HB_DOCKET_PORT']);
  if (command === 'serve' && (!Number.isFinite(docketPort) || docketPort <= 0)) {
    throw new Error('HB_DOCKET_PORT is not set — run pnpm generate:env first');
  }

  return {
    envDir: repoRoot,
    plugins: [tailwindcss(), react(), prePaintScriptsPlugin(), docketApiPlugin({ repoRoot })],
    resolve: {
      alias: {
        '@': resolve(import.meta.dirname, './src'),
      },
    },
    server: {
      port: docketPort,
      strictPort: true,
    },
  };
});
