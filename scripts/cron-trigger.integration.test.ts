import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SCHEDULED_TRIGGER_PATH, fireCron } from './cron-trigger.js';
import { apiWorkerStartInput, startWorkerRuntime } from './wrangler-dev.js';
import type { Server } from 'node:http';
import type { RuntimeWorker } from './wrangler-dev.js';

/**
 * What a green scheduled request does and does not prove, against the Worker
 * start every local stack uses (the launcher's runtime start, as the ticker
 * `pnpm dev` arms reaches it).
 *
 * The probe Worker below dispatches the way `cronEntriesFor` does — exact
 * equality on the expression — and its entry's only observable effect is an
 * outbound request to a Node server this test owns. So the run of an entry is
 * observed through something the entry itself produced, and the case that fires
 * an unregistered expression shows the same 200 with no entry having run.
 *
 * It also pins {@link SCHEDULED_TRIGGER_PATH} to the installed wrangler: the
 * path moved once already, and a rename is invisible from the status code
 * alone in every other test.
 */

const REGISTERED_CRON = '*/15 * * * *';
const UNREGISTERED_CRON = '7 7 * * *';

/**
 * What the fixture's whole hook may spend: the sink binding a port, the probe's
 * files being written, and the local Worker runtime starting until it serves.
 */
const RUNTIME_BOOT_HOOK_BUDGET_MS = 120_000;

interface Sink {
  readonly server: Server;
  readonly port: number;
  readonly hits: string[];
}

async function startSink(): Promise<Sink> {
  const hits: string[] = [];
  const server = createServer((request, response) => {
    hits.push(request.url ?? '');
    response.end('recorded');
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('sink has no tcp port');
  return { server, port: address.port, hits };
}

function writeProbeWorker(directory: string, sinkPort: number): void {
  writeFileSync(
    path.join(directory, 'worker.js'),
    [
      'export default {',
      '  fetch() { return new Response("probe"); },',
      '  async scheduled(controller, env) {',
      '    if (controller.cron !== env.REGISTERED_CRON) return;',
      '    await fetch(`http://127.0.0.1:${env.SINK_PORT}/entry-ran`);',
      '  },',
      '};',
      '',
    ].join('\n')
  );
  writeFileSync(
    path.join(directory, 'wrangler.toml'),
    [
      'name = "cron-trigger-probe"',
      'main = "worker.js"',
      'compatibility_date = "2026-01-01"',
      '',
      '[vars]',
      `SINK_PORT = "${String(sinkPort)}"`,
      `REGISTERED_CRON = "${REGISTERED_CRON}"`,
      '',
      '[triggers]',
      `crons = ["${REGISTERED_CRON}"]`,
      '',
    ].join('\n')
  );
}

describe('the scheduled trigger against the local Worker runtime', () => {
  let sink: Sink;
  let directory: string;
  let worker: RuntimeWorker | undefined;
  let baseUrl: string;

  beforeAll(async () => {
    sink = await startSink();
    directory = mkdtempSync(path.join(os.tmpdir(), 'cron-trigger-probe-'));
    writeProbeWorker(directory, sink.port);

    // The development stack's own start — the one the ticker fires against —
    // re-pointed at the probe, with free ports and a store inside the probe's
    // directory, so the run shares no port or store with any stack.
    const stackInput = apiWorkerStartInput('development', { port: 0, inspectorPort: 0 });
    worker = await startWorkerRuntime({
      ...stackInput,
      config: path.join(directory, 'wrangler.toml'),
      envFiles: [],
      dev: { ...stackInput.dev, persist: path.join(directory, 'state') },
    });
    const url = await worker.url;
    baseUrl = url.href;
  }, RUNTIME_BOOT_HOOK_BUDGET_MS);

  afterAll(async () => {
    try {
      await worker?.dispose();
    } finally {
      await new Promise<void>((resolve) => {
        sink.server.close(() => {
          resolve();
        });
      });
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the entry the matched expression selects, while both requests answer 200', async () => {
    const unmatched = await fireCron(baseUrl, UNREGISTERED_CRON, globalThis.fetch);

    expect(unmatched.status).toBe(200);
    expect(sink.hits).toEqual([]);

    const matched = await fireCron(baseUrl, REGISTERED_CRON, globalThis.fetch);

    expect(matched.status).toBe(200);
    expect(sink.hits).toEqual(['/entry-ran']);
  });
});
