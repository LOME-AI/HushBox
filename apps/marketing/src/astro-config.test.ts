import { describe, it, expect, vi, afterEach } from 'vitest';
import { GROWTH_BEACON_PATH } from '@hushbox/shared';
import config, {
  beaconProxyIntegration,
  serverPortIntegration,
  spaRedirectPlugin,
} from '../astro.config.mjs';

const setupHook = serverPortIntegration.hooks['astro:config:setup'];
const beaconProxyHook = beaconProxyIntegration.hooks['astro:config:setup'];

interface ProxyEntry {
  readonly target?: string;
  readonly changeOrigin?: boolean;
}

interface ViteUpdate {
  readonly vite?: { readonly server?: { readonly proxy?: Record<string, ProxyEntry> } };
}

/** The proxy table the beacon integration installs for a command. */
function beaconProxy(command: string): Record<string, ProxyEntry> {
  const updates: ViteUpdate[] = [];
  beaconProxyHook({ command, updateConfig: (update: ViteUpdate) => updates.push(update) });
  const proxy = updates[0]?.vite?.server?.proxy;
  if (proxy === undefined) throw new Error('the integration installed no beacon proxy');
  return proxy;
}

/** The one key that table is written under, read back rather than spelled again here. */
function beaconKey(): string {
  const keys = Object.keys(beaconProxy('dev'));
  if (keys.length !== 1) throw new Error(`expected one proxy entry, found ${String(keys.length)}`);
  return keys[0]!;
}

type Middleware = (req: { url: string }, res: unknown, next: () => void) => void;

/** The SPA-redirect middleware, as the plugin registers it on a dev server. */
function redirectMiddleware(): Middleware {
  let middleware: Middleware | undefined;
  spaRedirectPlugin().configureServer({
    middlewares: {
      use: (registered: Middleware) => {
        middleware = registered;
      },
    },
  });
  if (middleware === undefined) throw new Error('the plugin registered no middleware');
  return middleware;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('marketing dev server', () => {
  it('refuses to start on a port other than the one it was given', () => {
    expect(config.vite?.server?.strictPort).toBe(true);
  });

  it.each(['dev', 'preview'])('takes the %s server port from the generated env', (command) => {
    vi.stubEnv('HB_ASTRO_PORT', '4399');
    const updates: unknown[] = [];

    setupHook({ command, updateConfig: (update: unknown) => updates.push(update) });

    expect(updates).toStrictEqual([{ server: { port: 4399 } }]);
  });

  it('reports the missing variable instead of falling back to a default port', () => {
    vi.stubEnv('HB_ASTRO_PORT', '');

    expect(() => {
      setupHook({ command: 'dev', updateConfig: () => undefined });
    }).toThrow('HB_ASTRO_PORT');
  });

  it('leaves the build alone, which runs without a generated env', () => {
    vi.stubEnv('HB_ASTRO_PORT', '');
    const updates: unknown[] = [];

    setupHook({ command: 'build', updateConfig: (update: unknown) => updates.push(update) });

    expect(updates).toStrictEqual([]);
  });
});

describe('marketing SPA redirect', () => {
  it('sends an app route to the app dev server on its generated port', () => {
    vi.stubEnv('HB_VITE_PORT', '5199');
    const headers: Record<string, string>[] = [];
    const res = {
      writeHead: (_status: number, value: Record<string, string>) => headers.push(value),
      end: () => undefined,
    };

    redirectMiddleware()({ url: '/login' }, res, () => undefined);

    expect(headers).toStrictEqual([{ Location: 'http://localhost:5199/login' }]);
  });

  it('reports the missing variable instead of redirecting to a default port', () => {
    vi.stubEnv('HB_VITE_PORT', '');
    const middleware = redirectMiddleware();

    expect(() => {
      middleware({ url: '/login' }, {}, () => undefined);
    }).toThrow('HB_VITE_PORT');
  });

  it('leaves a route it does not own to the next middleware', () => {
    vi.stubEnv('HB_VITE_PORT', '');
    let passed = false;

    redirectMiddleware()({ url: '/blog' }, {}, () => {
      passed = true;
    });

    expect(passed).toBe(true);
  });
});

describe('marketing beacon proxy', () => {
  it('sends a beacon post to the Worker on its generated port', () => {
    vi.stubEnv('HB_API_PORT', '5299');

    expect(beaconProxy('dev')[beaconKey()]?.target).toBe('http://localhost:5299');
  });

  it('rewrites the host alone, leaving the page origin the Worker checks', () => {
    vi.stubEnv('HB_API_PORT', '5299');

    expect(beaconProxy('dev')[beaconKey()]?.changeOrigin).toBe(true);
  });

  it.each([GROWTH_BEACON_PATH, `${GROWTH_BEACON_PATH}?c=launch`])(
    'claims %s, which the beacon sends',
    (url) => {
      vi.stubEnv('HB_API_PORT', '5299');

      expect(new RegExp(beaconKey()).test(url)).toBe(true);
    }
  );

  it('leaves a page whose path merely starts with the same bytes to the site', () => {
    vi.stubEnv('HB_API_PORT', '5299');

    expect(new RegExp(beaconKey()).test(`${GROWTH_BEACON_PATH}vents`)).toBe(false);
  });

  it('reports the missing variable instead of proxying to a default port', () => {
    vi.stubEnv('HB_API_PORT', '');

    expect(() => beaconProxy('dev')).toThrow('HB_API_PORT');
  });

  it('leaves the build alone, which runs without a generated env', () => {
    vi.stubEnv('HB_API_PORT', '');
    const updates: unknown[] = [];

    beaconProxyHook({ command: 'build', updateConfig: (update: unknown) => updates.push(update) });

    expect(updates).toStrictEqual([]);
  });

  it('is registered on the site, so a page served by the dev server counts', () => {
    expect(config.integrations).toContain(beaconProxyIntegration);
  });

  it('is not handed to the redirect that serves the app routes', () => {
    vi.stubEnv('HB_VITE_PORT', '');
    let passed = false;

    redirectMiddleware()({ url: GROWTH_BEACON_PATH }, {}, () => {
      passed = true;
    });

    expect(passed).toBe(true);
  });
});
