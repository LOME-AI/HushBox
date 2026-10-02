import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  createAuditFixture,
  FIXTURE_AUDIT_DATE,
  FIXTURE_AUDIT_HEADER,
  type AuditFixture,
} from '../test-utils/audit-fixture';
import { fakeRequest, fakeResponse, type FakeResponse } from '../test-utils/fake-http';
import { docketApiPlugin } from './api-plugin';
import type { IdleTimer } from './idle-timer';
import type { SignalShutdownOptions } from './shutdown';

type Middleware = (req: unknown, res: unknown, next: () => void) => void;

interface FakeServer {
  readonly middlewares: Middleware[];
  readonly closeHandlers: (() => void)[];
  readonly close: ReturnType<typeof vi.fn>;
}

let fixture: AuditFixture;

beforeEach(async () => {
  fixture = await createAuditFixture();
});

afterEach(async () => {
  await fixture.cleanup();
});

async function mount(
  argv: readonly string[] = [],
  overrides: {
    exit?: (code: number) => void;
    repoRoot?: string;
    log?: (message: string) => void;
    httpServer?: boolean;
  } = {}
): Promise<{
  server: FakeServer;
  timers: { minutes: number; timer: IdleTimer & { touches: number } }[];
  shutdowns: { options: SignalShutdownOptions; uninstall: ReturnType<typeof vi.fn> }[];
}> {
  const middlewares: Middleware[] = [];
  const closeHandlers: (() => void)[] = [];
  const close = vi.fn(async () => {});
  const timers: { minutes: number; timer: IdleTimer & { touches: number } }[] = [];
  const shutdowns: { options: SignalShutdownOptions; uninstall: ReturnType<typeof vi.fn> }[] = [];

  const plugin = docketApiPlugin({
    repoRoot: overrides.repoRoot ?? fixture.root,
    argv,
    log: overrides.log ?? ((): undefined => undefined),
    exit: overrides.exit ?? ((): void => undefined),
    installShutdown: (options) => {
      const uninstall = vi.fn();
      shutdowns.push({ options, uninstall });
      return uninstall;
    },
    startTimer: ({ minutes, onExpire }) => {
      const timer = {
        touches: 0,
        touch(): void {
          timer.touches += 1;
        },
        stop: vi.fn(),
        expire: onExpire,
      };
      timers.push({ minutes, timer });
      return timer;
    },
  });

  const server = {
    middlewares: { use: (middleware: Middleware) => middlewares.push(middleware) },
    httpServer:
      overrides.httpServer === false
        ? null
        : { on: (_event: string, handler: () => void) => closeHandlers.push(handler) },
    close,
  };
  await (plugin.configureServer as (server: unknown) => Promise<void>)(server);

  return { server: { middlewares, closeHandlers, close }, timers, shutdowns };
}

/** A second audit in the fixture, dated so that it is the one served by default. */
async function plantNewerAudit(name: string): Promise<void> {
  const dir = path.join(fixture.root, 'docs', 'audits', name);
  await fs.mkdir(path.join(dir, 'findings'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'audit.md'),
    FIXTURE_AUDIT_HEADER.replace(FIXTURE_AUDIT_DATE, name)
  );
}

/**
 * Mounts with the process-state seams left at their defaults, so a test can see
 * what the plugin installs when nothing is injected.
 */
async function mountWithDefaultSeams(
  argv: readonly string[]
): Promise<{ closeHandlers: (() => void)[] }> {
  const closeHandlers: (() => void)[] = [];
  const plugin = docketApiPlugin({
    repoRoot: path.join(fixture.root, 'empty'),
    argv,
    log: (): undefined => undefined,
    exit: (): undefined => undefined,
  });
  await (plugin.configureServer as (server: unknown) => Promise<void>)({
    middlewares: { use: (): undefined => undefined },
    httpServer: { on: (_event: string, handler: () => void) => closeHandlers.push(handler) },
    close: () => Promise.resolve(),
  });

  return { closeHandlers };
}

async function request(
  server: FakeServer,
  method: string,
  url: string,
  body?: unknown
): Promise<{ res: FakeResponse; nexts: number }> {
  const res = fakeResponse();
  let nexts = 0;
  for (const middleware of server.middlewares) {
    middleware(fakeRequest(method, url, body), res, () => {
      nexts += 1;
    });
  }
  // An event stream never ends, so a written chunk counts as answered too.
  await vi.waitFor(() => {
    expect(res.ended || nexts > 0 || res.chunks.length > 0).toBe(true);
  });
  return { res, nexts };
}

describe('docketApiPlugin', () => {
  it('serves the api from the dev server', async () => {
    const { server } = await mount();

    const { res } = await request(server, 'GET', '/api/audit');

    expect(res.statusCode).toBe(200);
    expect((res.json() as { findings: unknown[] }).findings).toHaveLength(2);
  });

  it('hands a non-api request back to vite', async () => {
    const { server } = await mount();

    const { nexts, res } = await request(server, 'GET', '/');

    expect(nexts).toBe(1);
    expect(res.ended).toBe(false);
  });

  it('starts the idle window at thirty minutes by default', async () => {
    const { timers } = await mount();

    expect(timers).toHaveLength(1);
    expect(timers[0]?.minutes).toBe(30);
  });

  it('honors an idle window given on the command line', async () => {
    const { timers } = await mount(['--idle', '5']);

    expect(timers[0]?.minutes).toBe(5);
  });

  it('starts no timer at all under --no-idle', async () => {
    const { timers } = await mount(['--no-idle']);

    expect(timers).toEqual([]);
  });

  it('refreshes the idle window on every api request', async () => {
    const { server, timers } = await mount();

    await request(server, 'GET', '/api/ping');
    await request(server, 'GET', '/api/ping');

    expect(timers[0]?.timer.touches).toBe(2);
  });

  it('does not let an open event stream hold the server open', async () => {
    const { server, timers } = await mount();

    await request(server, 'GET', `/api/audits/${FIXTURE_AUDIT_DATE}/events`);

    expect(timers[0]?.timer.touches).toBe(0);
  });

  it('closes the server and exits when the idle window expires', async () => {
    const exit = vi.fn();
    const { server, timers } = await mount([], { exit });

    await (timers[0]?.timer as unknown as { expire: () => Promise<void> }).expire();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('arranges its own end for a termination signal', async () => {
    const { shutdowns } = await mount();

    expect(shutdowns).toHaveLength(1);
  });

  it('closes the server when a termination signal arrives', async () => {
    const { server, shutdowns } = await mount();

    await shutdowns[0]?.options.close();

    expect(server.close).toHaveBeenCalledTimes(1);
  });

  it('ends the process through its own exit when a signalled close hangs', async () => {
    const exit = vi.fn();
    const { shutdowns } = await mount([], { exit });

    shutdowns[0]?.options.forceExit?.(0);

    expect(exit).toHaveBeenCalledWith(0);
  });

  it('stops listening for signals when the http server closes', async () => {
    const { server, shutdowns } = await mount();

    for (const handler of server.closeHandlers) handler();

    expect(shutdowns[0]?.uninstall).toHaveBeenCalledTimes(1);
  });

  it('stops the timer when the http server closes', async () => {
    const { server, timers } = await mount();

    for (const handler of server.closeHandlers) handler();

    expect(timers[0]?.timer.stop).toHaveBeenCalledTimes(1);
  });

  it('mounts even when vite reports no http server', async () => {
    const { server } = await mount([], { httpServer: false });

    const { res } = await request(server, 'GET', '/api/ping');

    expect(res.statusCode).toBe(200);
  });

  it('serves the api with the idle window switched off', async () => {
    const { server, timers } = await mount(['--no-idle']);

    const { res } = await request(server, 'GET', '/api/ping');

    expect(res.statusCode).toBe(200);
    expect(timers).toEqual([]);
  });

  it('runs on its own defaults when the caller injects nothing', async () => {
    const middlewares: Middleware[] = [];
    const closeHandlers: (() => void)[] = [];
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const argv = process.argv;
    // With no argv passed, the plugin reads the launcher's own flags.
    process.argv = ['node', 'start.ts', '--no-idle'];
    const plugin = docketApiPlugin({ repoRoot: fixture.root });
    process.argv = argv;
    await (plugin.configureServer as (server: unknown) => Promise<void>)({
      middlewares: { use: (middleware: Middleware) => middlewares.push(middleware) },
      httpServer: { on: (_event: string, handler: () => void) => closeHandlers.push(handler) },
      close: () => Promise.resolve(),
    });

    const { res } = await request(
      { middlewares, closeHandlers, close: vi.fn() },
      'GET',
      '/api/ping'
    );
    // Releases the real thirty-minute timer this mount started.
    for (const handler of closeHandlers) handler();

    expect(res.statusCode).toBe(200);
    stdout.mockRestore();
  });

  it('reports through its own logger when nothing is injected', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const middlewares: Middleware[] = [];
    const closeHandlers: (() => void)[] = [];
    const plugin = docketApiPlugin({
      repoRoot: path.join(fixture.root, 'empty'),
      argv: ['--no-idle'],
    });
    await (plugin.configureServer as (server: unknown) => Promise<void>)({
      middlewares: { use: (middleware: Middleware) => middlewares.push(middleware) },
      httpServer: { on: (_event: string, handler: () => void) => closeHandlers.push(handler) },
      close: () => Promise.resolve(),
    });

    // A repository with no audit refuses the snapshot, which is what the
    // uninjected logger is left to report.
    await request({ middlewares, closeHandlers, close: vi.fn() }, 'GET', '/api/audit');

    await vi.waitFor(() => {
      expect(stdout.mock.calls.flat().join(' ')).toContain('GET /api/audit failed');
    });
    // Releases the real signal listener this mount installed.
    for (const handler of closeHandlers) handler();
    stdout.mockRestore();
  });

  it('listens for termination signals when no installer is injected', async () => {
    const before = process.listenerCount('SIGTERM');

    const { closeHandlers } = await mountWithDefaultSeams(['--no-idle']);
    const during = process.listenerCount('SIGTERM');
    for (const handler of closeHandlers) handler();

    expect(during).toBe(before + 1);
  });

  it('arms the idle window when no timer is injected', async () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();

    const { closeHandlers } = await mountWithDefaultSeams(['--idle', '1']);
    const during = vi.getTimerCount();
    for (const handler of closeHandlers) handler();
    vi.useRealTimers();

    expect(during).toBe(before + 1);
  });

  it('can be constructed by a tool whose own argv it knows nothing about', () => {
    const argv = process.argv;
    // Tooling loads vite.config.ts in its own process: knip does it with
    // `--no-progress` on the command line. Constructing the plugin must not
    // read, let alone reject, another program's flags.
    process.argv = ['node', 'knip', '--no-progress'];

    try {
      expect(() => docketApiPlugin({ repoRoot: fixture.root })).not.toThrow();
    } finally {
      process.argv = argv;
    }
  });

  /**
   * A request is served from an unawaited promise, so anything it throws is an
   * unhandled rejection and Node ends the process: the reader loses the console
   * mid-session, and with it every undo token it was holding.
   */
  describe('a request that throws', () => {
    const noAudit = (): { repoRoot: string } => ({ repoRoot: path.join(fixture.root, 'empty') });

    it('is answered rather than left to end the process', async () => {
      const { server } = await mount([], noAudit());

      const { res } = await request(server, 'GET', '/api/audit');

      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: { code: 'internal' } });
    });

    it('tells the reader the request did not finish', async () => {
      const { server } = await mount([], noAudit());

      const { res } = await request(server, 'GET', '/api/audit');

      expect((res.json() as { error: { message: string } }).error.message).toBe(
        'The console hit an unexpected error and did not finish. Its log has the detail, and a reload is the way back.'
      );
    });

    it('logs what failed, which is where the detail the reader is spared belongs', async () => {
      const log = vi.fn();
      const { server } = await mount([], { ...noAudit(), log });

      await request(server, 'GET', '/api/audit');

      const logged = log.mock.calls.flat().find((line) => String(line).includes('GET /api/audit'));
      expect(logged).toContain('no audit directory under');
    });

    it('stays alive when answering the failure throws in its turn', async () => {
      const log = vi.fn();
      const { server } = await mount([], { log });
      const res = fakeResponse();
      // A socket that has gone away takes the answer with it.
      res.end = (): never => {
        throw new Error('socket gone');
      };
      // A connect request carries no method of its own here, which the console
      // reads the way the routes do.
      const req = fakeRequest('GET', '/api/audit');
      delete (req as { method?: string }).method;

      for (const middleware of server.middlewares) {
        middleware(req, res, vi.fn());
      }

      await vi.waitFor(() => {
        expect(log).toHaveBeenCalledTimes(2);
      });
      expect(log.mock.calls.flat().join(' ')).toContain('could not be answered');
    });

    it('leaves a response it has already begun answering alone', async () => {
      const log = vi.fn();
      const { server } = await mount([], { ...noAudit(), log });
      const res = fakeResponse();
      Object.assign(res, { headersSent: true });

      for (const middleware of server.middlewares) {
        middleware(fakeRequest('GET', '/api/audit'), res, vi.fn());
      }
      await vi.waitFor(() => {
        expect(log.mock.calls.flat().join(' ')).toContain('GET /api/audit');
      });

      expect(res.ended).toBe(false);
      expect(res.statusCode).toBe(0);
    });
  });

  /**
   * A default the console cannot serve would leave every request that names no
   * audit 404ing against a server that came up looking healthy, so it is a
   * launch failure instead.
   */
  describe('an --audit the console cannot serve', () => {
    it('names the flag, the value and the audits that do exist', async () => {
      const log = vi.fn();

      await mount(['--audit', 'scratch-notes'], { log });

      expect(log.mock.calls.flat().join(' ')).toBe(
        'docket: --audit "scratch-notes" is not an audit this console serves; it serves 2026-07-30'
      );
    });

    it('says so plainly when the repository holds no audit at all', async () => {
      const log = vi.fn();

      await mount(['--audit', '2026-07-30'], {
        log,
        repoRoot: path.join(fixture.root, 'empty'),
      });

      expect(log.mock.calls.flat().join(' ')).toBe(
        'docket: --audit "2026-07-30" is not an audit this console serves; it serves no audits at all'
      );
    });

    it('ends the process rather than serving', async () => {
      const exit = vi.fn();

      const { server } = await mount(['--audit', 'scratch-notes'], { exit });

      expect(exit).toHaveBeenCalledWith(1);
      expect(server.middlewares).toEqual([]);
      expect(server.closeHandlers).toEqual([]);
    });

    it('starts no idle timer and installs no signal handler', async () => {
      const { timers, shutdowns } = await mount(['--audit', 'scratch-notes']);

      expect(timers).toEqual([]);
      expect(shutdowns).toEqual([]);
    });
  });

  it('serves the audit named on the command line by default', async () => {
    // A newer audit is what a console reading no flag would serve, so without
    // one on disk the flag and the default cannot be told apart.
    await plantNewerAudit('2099-01-01');

    const { server } = await mount(['--audit', FIXTURE_AUDIT_DATE]);

    const { res } = await request(server, 'GET', '/api/audit');

    expect((res.json() as { audit: { date: string } }).audit.date).toBe(FIXTURE_AUDIT_DATE);
  });
});
