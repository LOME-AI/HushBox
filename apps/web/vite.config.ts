import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { TanStackRouterVite } from '@tanstack/router-plugin/vite';
import tailwindcss from '@tailwindcss/vite';
import { createReadStream, readFileSync } from 'node:fs';
import { resolve } from 'path';
import { transformStreamdownSource } from './src/lib/inline-streamdown-lazy-imports';

const envDir = resolve(__dirname, '../..');

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
  return {
    name: 'marketing-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        if (
          url === '/privacy' ||
          url === '/privacy/' ||
          url === '/terms' ||
          url === '/terms/'
        ) {
          res.writeHead(302, { Location: `http://localhost:4321${url}` });
          res.end();
          return;
        }
        next();
      });
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

function sharedFaviconPlugin(): Plugin {
  const faviconPath = resolve(__dirname, '../../packages/ui/src/assets/favicon.ico');
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

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, envDir, 'VITE_');

  return {
    envDir,
    plugins: [
      tailwindcss(),
      TanStackRouterVite({
        quoteStyle: 'single',
        routeFileIgnorePattern: '.*\\.test\\.tsx?$',
      }),
      react(),
      apiPreconnectPlugin(env['VITE_API_URL']),
      inlineStreamdownLazyImports(),
      sharedFaviconPlugin(),
      marketingRedirectPlugin(),
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, './src'),
      },
    },
    server: {
      proxy: {
        '/api/ws': {
          target: 'http://localhost:8787',
          ws: true,
        },
      },
    },
  };
});
