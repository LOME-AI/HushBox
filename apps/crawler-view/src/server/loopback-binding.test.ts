import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import viteConfig from '../../vite.config';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_JSON = path.resolve(HERE, '../../package.json');

/**
 * `/api/crawl` fetches any http(s) URL a caller supplies and returns the body,
 * and that is accepted rather than fixed on the strength of the dev server
 * never leaving loopback. Vite binds `localhost` when `server.host` is
 * undefined, and the only other way to widen the binding is a `--host` flag on
 * the command line, so both halves are asserted here.
 */
describe('crawler-view dev server binding', () => {
  it('declares no server.host, so Vite binds loopback', () => {
    const resolved = viteConfig({ command: 'serve', mode: 'development' });

    expect(resolved.server).toBeDefined();
    expect(Object.keys(resolved.server ?? {})).not.toContain('host');
  });

  it('starts the dev server with no flags, so no --host can widen the binding', () => {
    const manifest = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as {
      scripts: Record<string, string>;
    };

    expect(manifest.scripts['dev']).toBe('vite');
  });
});
