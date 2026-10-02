import { describe, it, expect, afterEach, vi } from 'vitest';
import { crawlerApiPlugin } from './crawler-api-plugin';
import type { RequestLike, ResponseLike } from './http';
import type { Plugin, ViteDevServer } from 'vite';

/** What `vi.stubEnv` is handed to leave a port variable absent rather than empty. */
const UNSET: string | undefined = undefined;

interface Registered {
  path: string;
  handler: (req: RequestLike, res: ResponseLike) => void;
}

interface FakeRes extends ResponseLike {
  headers: Record<string, string>;
  body: string | undefined;
  ended: boolean;
}

function makeRes(): FakeRes {
  return {
    statusCode: 0,
    headers: {},
    body: undefined,
    ended: false,
    setHeader(name: string, value: string): void {
      this.headers[name.toLowerCase()] = value;
    },
    end(chunk?: string): void {
      this.body = chunk;
      this.ended = true;
    },
  };
}

/**
 * `configureServer` reads one member of `ViteDevServer` — `middlewares.use` — and the
 * handlers it registers read only the `RequestLike`/`ResponseLike` members `./handlers`
 * declares. Satisfying the full `ViteDevServer` surface honestly means starting a dev
 * server, which would bind a port from a unit test, so the recorder is asserted into the
 * parameter type instead.
 */
function recordingServer(registered: Registered[]): ViteDevServer {
  return {
    middlewares: {
      use(path: string, handler: (req: RequestLike, res: ResponseLike) => void): void {
        registered.push({ path, handler });
      },
    },
  } as unknown as ViteDevServer;
}

/**
 * Vite types `configureServer` as a method whose `this` is a plugin context only the real
 * bundler can build; this hook's body uses none of it, so it is read as the plain function
 * it is rather than standing up a bundler to obtain a context.
 */
function serverConfigurer(plugin: Plugin): (server: ViteDevServer) => unknown {
  const { configureServer } = plugin;
  if (typeof configureServer !== 'function') {
    throw new TypeError('the plugin must expose configureServer as a plain function hook');
  }
  return configureServer as unknown as (server: ViteDevServer) => unknown;
}

function configureRoutes(): Registered[] {
  const registered: Registered[] = [];
  serverConfigurer(crawlerApiPlugin())(recordingServer(registered));
  return registered;
}

function routeHandler(path: string): (req: RequestLike, res: ResponseLike) => void {
  const route = configureRoutes().find((entry) => entry.path === path);
  if (route === undefined) {
    throw new Error(`no middleware registered for ${path}`);
  }
  return route.handler;
}

function alwaysMissing(): typeof fetch {
  return () => Promise.resolve(new Response('', { status: 404 }));
}

interface SitemapTarget {
  label: string;
  origin: string;
  urls: string[];
  unreachable?: true;
}

async function readSitemapTargets(): Promise<SitemapTarget[]> {
  const res = makeRes();
  routeHandler('/api/sitemap')({ url: '/', method: 'GET', headers: {} }, res);
  await vi.waitFor(() => {
    expect(res.ended).toBe(true);
  });
  const body = JSON.parse(res.body ?? '') as { targets: SitemapTarget[] };
  return body.targets;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('crawlerApiPlugin', () => {
  it('registers the crawl and sitemap routes on the dev server middleware stack', () => {
    expect(crawlerApiPlugin().name).toBe('hushbox:crawler-api');
    expect(configureRoutes().map((entry) => entry.path)).toEqual(['/api/crawl', '/api/sitemap']);
  });

  it('serves the crawl route through the handler that validates the url', async () => {
    const res = makeRes();

    routeHandler('/api/crawl')({ url: '/', method: 'GET', headers: {} }, res);

    await vi.waitFor(() => {
      expect(res.ended).toBe(true);
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body ?? '')).toMatchObject({ error: { code: 'invalid_url' } });
  });

  it('serves the sitemap route for both dev origins read from the environment', async () => {
    vi.stubEnv('HB_ASTRO_PORT', '4321');
    vi.stubEnv('HB_VITE_PORT', '5173');
    vi.stubGlobal('fetch', alwaysMissing());

    expect(await readSitemapTargets()).toEqual([
      { label: 'marketing', origin: 'http://localhost:4321', urls: [] },
      { label: 'web', origin: 'http://localhost:5173', urls: [] },
    ]);
  });

  it('omits a target whose port variable is unset or empty', async () => {
    vi.stubEnv('HB_ASTRO_PORT', UNSET);
    vi.stubEnv('HB_VITE_PORT', '');
    vi.stubGlobal('fetch', alwaysMissing());

    expect(await readSitemapTargets()).toEqual([]);
  });

  it('omits a target whose port variable is not a number', async () => {
    vi.stubEnv('HB_ASTRO_PORT', 'not-a-port');
    vi.stubEnv('HB_VITE_PORT', UNSET);
    vi.stubGlobal('fetch', alwaysMissing());

    expect(await readSitemapTargets()).toEqual([]);
  });

  it('omits a target whose port variable is not positive', async () => {
    vi.stubEnv('HB_ASTRO_PORT', '0');
    vi.stubEnv('HB_VITE_PORT', '-1');
    vi.stubGlobal('fetch', alwaysMissing());

    expect(await readSitemapTargets()).toEqual([]);
  });
});
