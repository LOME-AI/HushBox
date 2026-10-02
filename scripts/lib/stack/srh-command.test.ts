import { createServer, type RequestListener, type Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';

import rootConfig from '@hushbox/config/vitest';

import {
  redisCommand,
  REQUEST_BOUND_MS,
  REQUESTS_PER_ISOLATION_CASE,
  RUNNER_CASE_BUDGET_MS,
} from './srh-command.js';

import type { AddressInfo } from 'node:net';

/**
 * The two reachability failures a proxy can hand a caller are driven here by a
 * stand-in the case starts, because neither can be produced on demand from the
 * real one: a refusal needs a port nothing is listening on, and a hang needs a
 * listener that takes the connection and never writes.
 */

const TOKEN = 'a-pool-token';

let listener: Server | undefined;

async function listen(handler: RequestListener): Promise<string> {
  const created = createServer(handler);
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', resolve);
  });
  listener = created;
  return `http://127.0.0.1:${String((created.address() as AddressInfo).port)}`;
}

async function stopListening(): Promise<void> {
  const running = listener;
  listener = undefined;
  if (running === undefined) return;
  await new Promise<void>((resolve) => {
    running.closeAllConnections();
    running.close(() => {
      resolve();
    });
  });
}

/** A URL nothing answers on: a listener taken and given back, so the port is free. */
async function refusingUrl(): Promise<string> {
  const url = await listen((_request, response) => {
    response.end('{}');
  });
  await stopListening();
  return url;
}

/** A URL that takes the connection and never writes an answer. */
function hangingUrl(): Promise<string> {
  return listen(() => {
    // Deliberately no response: this is the shape the bound exists to name.
  });
}

/** A URL that writes an answer's head and a first chunk, then stalls forever. */
function stallingMidAnswerUrl(): Promise<string> {
  return listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"result":"PON');
    // Deliberately never ended: the answer begins and does not complete.
  });
}

/** A URL that writes an answer's head and a first chunk, then drops the connection. */
function resettingMidAnswerUrl(): Promise<string> {
  return listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.write('{"result":"PON', () => {
      response.socket?.destroy();
    });
  });
}

async function messageFrom(call: Promise<unknown>): Promise<string> {
  try {
    await call;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error('the command resolved, so there is no failure message to read');
}

afterEach(stopListening);

describe('a command the proxy does not answer', () => {
  it('reports the request as unanswered, naming the bound it waited', async () => {
    const url = await hangingUrl();

    const message = await messageFrom(redisCommand(url, TOKEN, ['PING'], 50));

    expect(message).toContain('no answer arrived within 50ms');
    expect(message).toContain('unanswered');
  });
});

describe('a command the transport never carries', () => {
  it('reports the request as unreachable, naming the transport code', async () => {
    const url = await refusingUrl();

    const message = await messageFrom(redisCommand(url, TOKEN, ['PING'], 2000));

    expect(message).toContain('ECONNREFUSED');
    expect(message).toContain('unreachable');
  });
});

describe('a transport failure carrying no cause', () => {
  it('is reported by the failure itself, still as unreachable', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('the transport named no cause')));

    const message = await messageFrom(redisCommand('http://127.0.0.1', TOKEN, ['PING'], 2000));

    expect(message).toContain('the transport named no cause');
    expect(message).toContain('unreachable');
  });
});

describe('the two reachability failures', () => {
  it('are reported in messages neither of which reads as the other', async () => {
    const refused = await messageFrom(redisCommand(await refusingUrl(), TOKEN, ['PING'], 2000));
    const unanswered = await messageFrom(redisCommand(await hangingUrl(), TOKEN, ['PING'], 50));

    expect(refused).not.toBe(unanswered);
    expect(refused).not.toContain('no answer arrived within');
    expect(unanswered).not.toContain('ECONNREFUSED');
  });
});

describe('a command the proxy answers', () => {
  it('returns the result it answered with', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"result":"PONG"}');
    });

    await expect(redisCommand(url, TOKEN, ['PING'], 2000)).resolves.toBe('PONG');
  });

  it('reports an error it answered with', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"error":"WRONGTYPE Operation against a key"}');
    });

    const message = await messageFrom(redisCommand(url, TOKEN, ['GET'], 2000));

    expect(message).toContain('WRONGTYPE Operation against a key');
  });

  it('reports a refusing status with no error body by its status', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end('{}');
    });

    const message = await messageFrom(redisCommand(url, TOKEN, ['GET'], 2000));

    expect(message).toContain('401');
  });

  it('reports a body that is not JSON as answered rather than as a transport failure', async () => {
    const url = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('');
    });

    const message = await messageFrom(redisCommand(url, TOKEN, ['GET'], 2000));

    expect(message).toContain('answered 200');
    expect(message).not.toContain('unreachable');
    expect(message).not.toContain('unanswered');
  });
});

describe('a command whose answer begins and does not finish', () => {
  it('reports a stall after the answer head as unanswered, naming the bound it waited', async () => {
    const url = await stallingMidAnswerUrl();

    const message = await messageFrom(redisCommand(url, TOKEN, ['PING'], 50));

    expect(message).toContain('Redis REST PING');
    expect(message).toContain('50ms');
    expect(message).toContain('unanswered');
  });

  it('reports a connection dropped after the answer head as unreachable, naming the transport failure', async () => {
    const url = await resettingMidAnswerUrl();

    const message = await messageFrom(redisCommand(url, TOKEN, ['PING'], 2000));

    expect(message).toContain('Redis REST PING');
    expect(message).toContain('while the answer was being read');
    expect(message).toContain('other side closed');
    expect(message).toContain('unreachable');
  });
});

describe('the bound a caller names nothing for', () => {
  it('reports an unanswered request rather than waiting on the runner', async () => {
    const url = await hangingUrl();

    const message = await messageFrom(redisCommand(url, TOKEN, ['PING']));

    expect(message).toContain(`no answer arrived within ${String(REQUEST_BOUND_MS)}ms`);
  });

  it('leaves the runner budget unreached even if every request in a case hangs', () => {
    expect(REQUESTS_PER_ISOLATION_CASE * REQUEST_BOUND_MS).toBeLessThan(RUNNER_CASE_BUDGET_MS);
  });

  it('is derived from a budget the shared runner config still gives a case', () => {
    expect(rootConfig.test?.testTimeout).toBeGreaterThanOrEqual(RUNNER_CASE_BUDGET_MS);
  });
});
