import { describe, it, expect, vi } from 'vitest';
import { startConsole } from './start';
import type { Mock } from 'vitest';

interface FakeServer {
  listen: Mock<() => Promise<void>>;
  resolvedUrls: { local: string[]; network: string[] } | null;
}

function fakeVite(urls: string[] | null = ['http://localhost:9201/']): {
  server: FakeServer;
  create: Mock<() => Promise<FakeServer>>;
  listen: Mock<() => Promise<void>>;
} {
  const listen = vi.fn(() => Promise.resolve());
  const server = { listen, resolvedUrls: urls === null ? null : { local: urls, network: [] } };
  return { server, create: vi.fn(() => Promise.resolve(server)), listen };
}

describe('startConsole', () => {
  it('starts the dev server and prints where the console is', async () => {
    const { create, listen } = fakeVite();
    const log = vi.fn();

    await startConsole([], { create, log });

    expect(create).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.flat().join(' ')).toContain('http://localhost:9201/');
  });

  it('passes a port override into vite rather than the generated one', async () => {
    const { create } = fakeVite();

    await startConsole(['--port', '9999'], { create, log: vi.fn() });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ server: { port: 9999 } }));
  });

  it('leaves the generated port in charge when no override is given', async () => {
    const { create } = fakeVite();

    await startConsole([], { create, log: vi.fn() });

    expect(create).toHaveBeenCalledWith({});
  });

  it('still says something useful when vite reports no url', async () => {
    const { create } = fakeVite(null);
    const log = vi.fn();

    await startConsole([], { create, log });

    expect(log).toHaveBeenCalled();
  });

  it('fails fast on an unusable flag instead of starting a server', async () => {
    const { create } = fakeVite();

    await expect(startConsole(['--idle', 'later'], { create, log: vi.fn() })).rejects.toThrow(
      '--idle needs a positive number'
    );
    expect(create).not.toHaveBeenCalled();
  });
});
