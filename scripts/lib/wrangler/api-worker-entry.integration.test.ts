import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { unstable_startWorker } from 'wrangler';
import { apiWorkerStartInput, startWorkerRuntime, watchesSource } from '../../wrangler-dev.js';
import { STACK_MODES } from '../stack/port-plan.js';
import { TMPFS_MAGIC, prepareRamRoot } from '../stack/ram-root.js';
import type { ApiWorkerStartInput, RuntimeWorker } from '../../wrangler-dev.js';
import type { StackMode } from '../stack/port-plan.js';

/**
 * Facts about the installed wrangler that nothing else in the repo checks,
 * measured against its real runtime on every run.
 *
 * Wrangler's worker-start input is typed `any` here, so a bump that renames or
 * stops reading `dev.watch` compiles cleanly and quietly re-arms the file
 * watchers on the E2E Worker. A reload that never happens cannot be awaited, so
 * what is measured is the reload mechanism itself — the watcher handles the
 * process holds — beside a watching arm that shows the count can rise.
 *
 * Miniflare's per-request trace collector is switched off only by an
 * environment variable the launcher sets; a rename of that variable leaves the
 * launcher's own test green, so the store the collector writes is looked for
 * directly, beside an arm with the variable unset that shows it appears.
 *
 * The stack's env file reaches the Worker only through the input's `envFiles`
 * key, and a key wrangler does not read falls back to the `.dev.vars` beside
 * the config — the development stack's file — so the value the Worker sees is
 * asked of the Worker itself, beside an arm with the key misspelled that shows
 * the fallback answering instead.
 *
 * The config's `[build]` command is cleared only by the input's
 * `build.custom.command`, and wrangler takes the config's command wherever that
 * key goes unread, so whether a build ran is asked of a marker the fixture's
 * command writes, beside an arm with the key left out that shows it written.
 *
 * workerd fsyncs every Durable Object commit on its only JavaScript thread, so
 * the E2E Worker keeps its state on a RAM filesystem; which filesystem a
 * Durable Object's database actually lands on is asked of the database a
 * fixture object creates, in a scratch directory beside the E2E root and never
 * in the live persist root. That directory is the persist root of a RAM root
 * the resolver makes for the case's own scratch checkout, so its owner file
 * names a checkout that is gone once the case ends, however it ends.
 */

/** What one arm may spend starting a real runtime, serving a request and stopping it. */
const RUNTIME_ARM_BUDGET_MS = 120_000;

let root: string;
let worker: RuntimeWorker | undefined;
let observabilityBefore: string | undefined;
let scratchRamRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'api-worker-entry-'));
  mkdirSync(path.join(root, 'src'));
  writeFileSync(
    path.join(root, 'src', 'index.js'),
    [
      'export default {',
      '  fetch(request, env) {',
      '    const { pathname } = new URL(request.url);',
      '    return new Response(pathname === "/env-source" ? String(env.ENV_SOURCE) : "probe");',
      '  },',
      '};',
      '',
    ].join('\n')
  );
  writeFileSync(
    path.join(root, 'mark-built.cjs'),
    "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'built.marker'), '');\n"
  );
  writeFileSync(
    path.join(root, 'wrangler.toml'),
    [
      'name = "api-worker-entry-probe"',
      'main = "src/index.js"',
      'compatibility_date = "2026-01-01"',
      '',
      // Run through node so the command means the same on every platform; the
      // working directory is named because wrangler otherwise runs it in its own.
      '[build]',
      'command = "node mark-built.cjs"',
      `cwd = ${JSON.stringify(root)}`,
      '',
    ].join('\n')
  );
  observabilityBefore = process.env['X_LOCAL_OBSERVABILITY'];
});

afterEach(async () => {
  try {
    await worker?.dispose();
  } finally {
    worker = undefined;
    if (observabilityBefore === undefined) delete process.env['X_LOCAL_OBSERVABILITY'];
    else process.env['X_LOCAL_OBSERVABILITY'] = observabilityBefore;
    rmSync(root, { recursive: true, force: true });
    if (scratchRamRoot !== undefined) rmSync(scratchRamRoot, { recursive: true, force: true });
    scratchRamRoot = undefined;
  }
});

/** The stack's own start, re-pointed at the fixture: its watch and log level are the builder's. */
function fixtureInput(stackMode: StackMode): ApiWorkerStartInput {
  const built = apiWorkerStartInput(stackMode, { port: 0, inspectorPort: 0 });
  return {
    ...built,
    config: path.join(root, 'wrangler.toml'),
    envFiles: [],
    dev: { ...built.dev, persist: path.join(root, 'state') },
  };
}

/** The file-watch handles this process holds: chokidar watches through `fs.watch`. */
function watchHandles(): number {
  return process.getActiveResourcesInfo().filter((resource) => resource === 'FSEventWrap').length;
}

async function turnOfTheEventLoop(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

async function servedOneRequest(started: RuntimeWorker): Promise<void> {
  const response = await started.fetch('http://fixture.test/');
  expect(await response.text()).toBe('probe');
}

function buildMarker(): string {
  return path.join(root, 'built.marker');
}

function observabilityStore(): string {
  return path.join(root, 'state', 'v3', 'observability');
}

/**
 * The stack's env file and, beside the config, the `.dev.vars` wrangler falls
 * back to — each naming itself as the source — returning the stack file's path.
 */
function writeEnvSources(): string {
  writeFileSync(path.join(root, '.dev.vars'), 'ENV_SOURCE=dev-vars\n');
  const stackEnvFile = path.join(root, 'stack.env');
  writeFileSync(stackEnvFile, 'ENV_SOURCE=stack-env-file\n');
  return stackEnvFile;
}

async function envSource(started: RuntimeWorker): Promise<string> {
  const response = await started.fetch('http://fixture.test/env-source');
  return response.text();
}

describe('the API Worker started for a stack', () => {
  it(
    'holds no file watcher in the E2E stack',
    async () => {
      const baseline = watchHandles();

      worker = await startWorkerRuntime(fixtureInput('e2e'));
      await worker.ready;

      expect(watchesSource('e2e')).toBe(false);
      expect(worker.config.dev.watch).toBe(false);
      expect(watchHandles()).toBeLessThanOrEqual(baseline);
    },
    RUNTIME_ARM_BUDGET_MS
  );

  it(
    'arms file watchers in the development stack, so the handle count can see one',
    async () => {
      const baseline = watchHandles();

      worker = await startWorkerRuntime(fixtureInput('development'));
      await worker.ready;
      while (watchHandles() <= baseline) await turnOfTheEventLoop();

      expect(worker.config.dev.watch).not.toBe(false);
      expect(watchHandles()).toBeGreaterThan(baseline);
    },
    RUNTIME_ARM_BUDGET_MS
  );

  it.each(STACK_MODES)(
    'runs no build command in the %s stack',
    async (stackMode) => {
      worker = await startWorkerRuntime(fixtureInput(stackMode));
      await worker.ready;

      expect(existsSync(buildMarker())).toBe(false);
    },
    RUNTIME_ARM_BUDGET_MS
  );

  it(
    'runs the config’s build command when the input leaves it in effect, so the marker can appear',
    async () => {
      const { config, envFiles, dev } = fixtureInput('e2e');

      worker = await unstable_startWorker({ config, envFiles, dev });
      await worker.ready;

      expect(existsSync(buildMarker())).toBe(true);
    },
    RUNTIME_ARM_BUDGET_MS
  );

  it(
    'writes no trace store with the collector switched off',
    async () => {
      process.env['X_LOCAL_OBSERVABILITY'] = 'false';

      worker = await startWorkerRuntime(fixtureInput('e2e'));
      await servedOneRequest(worker);

      expect(existsSync(observabilityStore())).toBe(false);
    },
    RUNTIME_ARM_BUDGET_MS
  );

  it(
    'writes a trace store with the switch unset, so the switch is what keeps it absent',
    async () => {
      delete process.env['X_LOCAL_OBSERVABILITY'];

      worker = await startWorkerRuntime(fixtureInput('e2e'));
      await servedOneRequest(worker);

      expect(existsSync(observabilityStore())).toBe(true);
    },
    RUNTIME_ARM_BUDGET_MS
  );

  it(
    'binds the variables of the env file the start input names',
    async () => {
      const stackEnvFile = writeEnvSources();

      worker = await startWorkerRuntime({ ...fixtureInput('e2e'), envFiles: [stackEnvFile] });

      expect(await envSource(worker)).toBe('stack-env-file');
    },
    RUNTIME_ARM_BUDGET_MS
  );

  it(
    'binds the .dev.vars beside the config when the env-file key goes unread, so the key is what selects the file',
    async () => {
      const stackEnvFile = writeEnvSources();
      const { config, dev } = fixtureInput('e2e');

      worker = await unstable_startWorker({ config, envFile: [stackEnvFile], dev });

      expect(await envSource(worker)).toBe('dev-vars');
    },
    RUNTIME_ARM_BUDGET_MS
  );
});

/** A fixture Worker with one Durable Object class, whose fetch writes one value. */
function writeDurableObjectFixture(): string {
  writeFileSync(
    path.join(root, 'src', 'room.js'),
    [
      'export class Room {',
      '  constructor(state) {',
      '    this.state = state;',
      '  }',
      '  async fetch() {',
      '    await this.state.storage.put("written", true);',
      '    return new Response("stored");',
      '  }',
      '}',
      'export default {',
      '  fetch(request, env) {',
      '    return env.ROOM.get(env.ROOM.idFromName("probe")).fetch(request);',
      '  },',
      '};',
      '',
    ].join('\n')
  );
  const config = path.join(root, 'room.toml');
  writeFileSync(
    config,
    [
      'name = "api-worker-entry-room"',
      'main = "src/room.js"',
      'compatibility_date = "2026-01-01"',
      '',
      '[durable_objects]',
      'bindings = [{ name = "ROOM", class_name = "Room" }]',
      '',
      '[[migrations]]',
      'tag = "v1"',
      'new_classes = ["Room"]',
      '',
    ].join('\n')
  );
  return config;
}

/** The SQLite databases a Worker's Durable Objects keep under a persist root. */
function durableObjectDatabases(persist: string): string[] {
  const store = path.join(persist, 'v3', 'do');
  return readdirSync(store, { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.sqlite'))
    .map((entry) => path.join(store, entry));
}

describe('the E2E Worker’s Durable Object storage', () => {
  it.runIf(process.platform === 'linux')(
    'lands on the RAM filesystem the E2E root is on',
    async () => {
      const config = writeDurableObjectFixture();
      const built = apiWorkerStartInput('e2e', { port: 0, inspectorPort: 0 });
      // The case needs no room beyond one small database, so the refusal it
      // can meet is the one for a root that is not in RAM.
      const scratch = await prepareRamRoot(root, 0);
      scratchRamRoot = scratch?.root;
      const persist = scratch?.persist ?? '';

      worker = await startWorkerRuntime({
        ...built,
        config,
        envFiles: [],
        dev: { ...built.dev, persist },
      });
      const response = await worker.fetch('http://fixture.test/');
      expect(await response.text()).toBe('stored');

      const [database] = durableObjectDatabases(persist);
      const filesystem = await statfs(path.dirname(database ?? ''));

      expect(path.dirname(scratchRamRoot ?? '')).toBe(
        path.dirname(path.dirname(built.dev.persist))
      );
      expect(database).toBeDefined();
      expect(filesystem.type).toBe(TMPFS_MAGIC);
    },
    RUNTIME_ARM_BUDGET_MS
  );
});
