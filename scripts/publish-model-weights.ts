/**
 * Mirrors the two on-device models — the prediction model and the speech model —
 * out of their upstream repositories and into R2, so the browser fetches every
 * weight, tokenizer, config and voice blob from our own origin.
 *
 * With `--remote` it publishes to the production bucket, skipping anything
 * already there. Without it, it fills the local R2 simulator that the local
 * Worker runtime serves, which is what makes the feature work on a plain
 * `pnpm dev`.
 *
 * Every decision lives in the tested helpers under `lib/model-weights/`; this
 * file is the wiring plus the argument surface.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { execa } from 'execa';
import { createEnvUtilities } from '@hushbox/shared';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { stackModeFrom } from './with-env.js';
import { wranglerPersistPath } from './wrangler-dev.js';
import { runMain } from './lib/cli/run-main.js';
import { r2PutArgs } from './lib/wrangler/r2.js';
import {
  MODEL_WEIGHTS_CACHE_ROOT,
  modelWeightsArtifacts,
  predictionArtifacts,
  ttsArtifacts,
} from './lib/model-weights/manifest.js';
import {
  createRemoteProbe,
  emptyStoreNotice,
  publishToR2,
  readRemoteProbeConfig,
  seedLocalStore,
} from './lib/model-weights/publish.js';
import type { EnvContext } from '@hushbox/shared';
import type { Artifact } from './lib/model-weights/manifest.js';
import type { RemoteProbeConfig } from './lib/model-weights/publish.js';
import type { R2Target } from './lib/wrangler/r2.js';

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPTS_DIR, '..');

/** Where wrangler's configuration, and so its local persistence, lives. */
const API_DIR = path.join(REPO_ROOT, 'apps', 'api');

export interface CommandRun {
  readonly exitCode: number | undefined;
  readonly stderr: string;
}

/**
 * Runs one command against wrangler's configuration directory, reporting the
 * only two things anything here reads.
 *
 * stdout is discarded at the pipe rather than captured. Nothing here reads it,
 * and captured output past execa's buffer cap makes execa kill the subprocess —
 * a failure indistinguishable from the command's own. The OTA bundle guard
 * discards it in shell for the same reason.
 */
export async function runInApiDir(file: string, args: readonly string[]): Promise<CommandRun> {
  const result = await execa(file, args, { cwd: API_DIR, reject: false, stdout: 'ignore' });
  return { exitCode: result.exitCode, stderr: result.stderr };
}

export interface PublishArgs {
  readonly remote: boolean;
  readonly e2e: boolean;
  readonly prediction: boolean;
}

export const COMMAND_LINE = {
  command: 'pnpm weights:seed',
  summary: 'Fills the model-weight store, locally by default.',
  flags: [
    {
      flag: '--e2e',
      kind: 'boolean',
      summary: 'Seed the speech model alone, which is all an E2E build reaches.',
    },
    {
      flag: '--prediction',
      kind: 'boolean',
      summary: 'Seed the prediction model alone, which is all a runtime check loads.',
    },
    {
      flag: '--remote',
      kind: 'boolean',
      summary: 'Publish to the production bucket instead of seeding locally.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

export function parsePublishArgs(
  argv: readonly string[],
  write?: (text: string) => void
): PublishArgs | null {
  const parsed = readCommandLine(COMMAND_LINE, argv, write);
  if (parsed === null) return null;
  return {
    remote: parsed.flags['--remote'],
    e2e: parsed.flags['--e2e'],
    prediction: parsed.flags['--prediction'],
  };
}

/**
 * Which artifact set a local seed fills the store with. `full` is both models,
 * for `pnpm dev`. `e2e` is the speech model alone: no E2E build ever reaches
 * the prediction model (a deterministic stub stands in for it there).
 * `prediction` is the mirror image, for an environment that checks the
 * sentence-completion runtime and loads no voice. Each narrowed scope exists so
 * a run spends no bytes on a model nothing in it fetches.
 */
export type SeedScope = 'full' | 'e2e' | 'prediction';

/**
 * What one invocation does. A remote publish resolves its signing credentials
 * here, before any object is reached; a local seed resolves none, because it
 * addresses wrangler's own store and signs nothing. `--e2e` has no effect on
 * a remote publish — production always carries the full set, since it serves
 * both the deployed prediction feature and the deployed speech feature.
 */
export type PublishRun =
  | { readonly kind: 'seed'; readonly scope: SeedScope }
  | { readonly kind: 'publish'; readonly config: RemoteProbeConfig };

export function resolveRun(
  args: PublishArgs,
  env: Readonly<Record<string, string | undefined>>
): PublishRun {
  if (args.remote) return { kind: 'publish', config: readRemoteProbeConfig(env) };
  return { kind: 'seed', scope: seedScopeOf(args) };
}

/**
 * The subset one local invocation names. Two subsets at once is refused rather
 * than resolved: either answer fills a store the caller did not ask for, and
 * the features these objects serve answer 404 without a sound.
 */
function seedScopeOf(args: PublishArgs): SeedScope {
  if (args.e2e && args.prediction) {
    throw new Error(
      'model weights: --e2e and --prediction name two different subsets; pass one of them, ' +
        'or neither to seed both models'
    );
  }
  if (args.e2e) return 'e2e';
  if (args.prediction) return 'prediction';
  return 'full';
}

/** The artifacts one scope seeds, which is the whole of what a scope decides. */
export function artifactsFor(scope: SeedScope): readonly Artifact[] {
  if (scope === 'e2e') return ttsArtifacts();
  if (scope === 'prediction') return predictionArtifacts();
  return modelWeightsArtifacts();
}

/**
 * The record of a completed local seed, in the store it describes.
 *
 * It sits *inside* miniflare's persistence root rather than under
 * `scripts/.cache/` or one level above that root, so that emptying the local
 * store by any route — the whole `.wrangler/` directory, the `state/` tree that
 * holds every stack's, or one stack's own — takes the record with it. A record
 * that outlived the store it describes would report "already seeded" over
 * nothing, and the feature it feeds degrades silently. Each stack persists to
 * its own root, so each stack records its own seed.
 *
 * Every scope records at its own path: alternating between `pnpm dev` (full
 * set) and a narrowed seed in the same checkout must not have each one's seed
 * invalidate the other's — sharing one receipt would make the policies thrash,
 * re-seeding on every switch.
 */
const RECEIPT_NAMES: Readonly<Record<SeedScope, string>> = {
  full: 'model-weights-seed.json',
  e2e: 'model-weights-seed-e2e.json',
  prediction: 'model-weights-seed-prediction.json',
};

export function seedReceiptPath(persistRoot: string, scope: SeedScope = 'full'): string {
  return path.join(persistRoot, RECEIPT_NAMES[scope]);
}

/* v8 ignore start -- real-IO wiring; every decision lives in lib/model-weights */

/**
 * The process environment as the env utilities read it. Each variable is
 * carried only when it is set: an explicit `undefined` is a different thing
 * from an absent key, and `createEnvUtilities` fails fast on an absent
 * NODE_ENV, which is the behaviour wanted here.
 */
function processEnvContext(): EnvContext {
  const { NODE_ENV, CI, E2E } = process.env;
  return {
    ...(NODE_ENV === undefined ? {} : { NODE_ENV }),
    ...(CI === undefined ? {} : { CI }),
    ...(E2E === undefined ? {} : { E2E }),
  };
}

/** The persistence root of the stack this invocation runs under. */
function localStore(): string {
  return wranglerPersistPath(stackModeFrom(process.env));
}

async function upload(objectPath: string, filePath: string, target: R2Target): Promise<void> {
  const result = await runInApiDir('pnpm', [
    'exec',
    'wrangler',
    ...r2PutArgs(objectPath, filePath, target),
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`wrangler could not write ${objectPath}: ${result.stderr}`);
  }
}

async function cachedBytes(filePath: string): Promise<number | null> {
  try {
    const stats = await stat(filePath);
    return stats.size;
  } catch {
    return null;
  }
}

async function download(url: string, filePath: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(
      `model weights: ${url} answered ${String(response.status)} ${response.statusText}`
    );
  }
  await mkdir(path.dirname(filePath), { recursive: true });
  await pipeline(response.body, createWriteStream(filePath));
}

function report(message: string): void {
  console.log(message);
}

async function readReceipt(scope: SeedScope): Promise<string | null> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(seedReceiptPath(localStore(), scope), 'utf8')
    );
    const fingerprint =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { fingerprint?: unknown }).fingerprint
        : undefined;
    return typeof fingerprint === 'string' ? fingerprint : null;
  } catch {
    return null;
  }
}

async function writeReceipt(fingerprint: string, scope: SeedScope): Promise<void> {
  const receipt = seedReceiptPath(localStore(), scope);
  await mkdir(path.dirname(receipt), { recursive: true });
  await writeFile(receipt, `${JSON.stringify({ fingerprint }, null, 2)}\n`);
}

/**
 * A local seed that cannot finish leaves the feature indistinguishable from one
 * that is merely still downloading, so a `full` seed reports the cause and lets
 * the rest of the stack come up rather than taking `pnpm dev` down with it.
 *
 * A narrowed seed never degrades that way: it feeds a check that must fail
 * loudly when the weights are missing, not a developer reading a console
 * notice, and `NODE_ENV`/`CI` alone cannot tell a local run of one apart from
 * local dev — both see `isLocalDev`. So every scope but `full` rethrows,
 * regardless of `isLocalDev`.
 */
async function seed(scope: SeedScope): Promise<void> {
  // Resolved before the seed runs, so a missing NODE_ENV fails on its own terms
  // rather than replacing whatever the seed was actually reporting.
  const envUtilities = createEnvUtilities(processEnvContext());
  try {
    await seedLocalStore(
      MODEL_WEIGHTS_CACHE_ROOT,
      {
        cachedBytes,
        download,
        upload: (objectPath, filePath) => upload(objectPath, filePath, stackModeFrom(process.env)),
        report,
        readReceipt: () => readReceipt(scope),
        writeReceipt: (fingerprint) => writeReceipt(fingerprint, scope),
      },
      artifactsFor(scope)
    );
  } catch (error: unknown) {
    if (scope !== 'full' || !envUtilities.isLocalDev) throw error;
    console.warn(emptyStoreNotice(error instanceof Error ? error.message : String(error)));
  }
}

if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const args = parsePublishArgs(process.argv.slice(2));
    if (args === null) return 0;
    const run = resolveRun(args, process.env);
    if (run.kind === 'seed') return seed(run.scope);
    return publishToR2(MODEL_WEIGHTS_CACHE_ROOT, {
      probe: createRemoteProbe(run.config, fetch),
      cachedBytes,
      download,
      upload: (objectPath, filePath) => upload(objectPath, filePath, 'remote'),
      report,
    });
  });
}
/* v8 ignore stop */
