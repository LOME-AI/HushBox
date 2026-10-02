import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSandboxOrigin } from '@hushbox/shared/sandbox-origin';
import { buildSandboxConfigScript } from './config.js';
import { createRequestListener, resolveDevPort } from './dev-server.js';

// `pnpm dev` bootstrap for the sandbox origin. The environment read here and by
// config.ts is loaded by scripts/with-env.ts before `turbo dev` fans out, and
// inherited here. All testable logic lives in the modules this file imports; it
// only wires them to a listening socket.

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = resolveDevPort(process.env);
const listener = createRequestListener({
  publicDir: path.join(packageRoot, 'public'),
  configScript: buildSandboxConfigScript(process.env),
  servedOrigin: resolveSandboxOrigin(process.env['SANDBOX_ORIGIN_URL']),
  // This server only ever serves a local stack; production is the assets Worker
  // serving the committed `public/_headers`.
  isProduction: false,
});

createServer(listener).listen(port, () => {
  console.log(`sandbox origin serving on http://localhost:${String(port)}`);
});
