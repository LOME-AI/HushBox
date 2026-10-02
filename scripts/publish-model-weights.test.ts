import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  modelWeightsArtifacts,
  predictionArtifacts,
  ttsArtifacts,
} from './lib/model-weights/manifest.js';
import {
  artifactsFor,
  parsePublishArgs,
  resolveRun,
  runInApiDir,
  seedReceiptPath,
} from './publish-model-weights.js';
import { wranglerPersistPath } from './wrangler-dev.js';

/**
 * The biggest object published, read from the manifest so the bound tracks the
 * artifact set rather than a number typed here once. Its size is the point: it
 * is past what execa will buffer, so a command emitting this much survives only
 * because {@link runInApiDir} discards stdout at the pipe.
 */
const LARGEST_ARTIFACT_BYTES = Math.max(
  ...modelWeightsArtifacts().map((artifact) => artifact.bytes)
);

/** A subprocess that writes exactly that many bytes to stdout, then exits cleanly. */
const WRITE_LARGEST_ARTIFACT = [
  'const chunk = Buffer.alloc(1 << 20);',
  `let left = ${String(LARGEST_ARTIFACT_BYTES)};`,
  'while (left > 0) { process.stdout.write(chunk.subarray(0, Math.min(left, chunk.length))); left -= chunk.length; }',
].join('\n');

describe('what the entry point is asked to do', () => {
  it('seeds the local simulator with the full artifact set when no target is named', () => {
    expect(parsePublishArgs([])).toEqual({ remote: false, e2e: false, prediction: false });
  });

  it('publishes to the production bucket only when asked in as many words', () => {
    expect(parsePublishArgs(['--remote'])).toEqual({ remote: true, e2e: false, prediction: false });
  });

  it('narrows to the E2E speech-only subset only when asked in as many words', () => {
    expect(parsePublishArgs(['--e2e'])).toEqual({ remote: false, e2e: true, prediction: false });
  });

  it('narrows to the prediction-only subset only when asked in as many words', () => {
    expect(parsePublishArgs(['--prediction'])).toEqual({
      remote: false,
      e2e: false,
      prediction: true,
    });
  });

  it('refuses an argument it does not define rather than guessing a target', () => {
    expect(() => parsePublishArgs(['--verbose'])).toThrow(/--verbose/);
  });

  it('answers a help request with nothing to run', () => {
    expect(parsePublishArgs(['--help'], () => {})).toBeNull();
  });
});

describe('what one invocation resolves to before any work starts', () => {
  const CREDENTIALS = {
    CLOUDFLARE_ACCOUNT_ID: 'account-under-test',
    R2_ACCESS_KEY_ID: 'key-under-test',
    R2_SECRET_ACCESS_KEY: 'secret-under-test',
  };

  it('resolves a local run without reading an R2 credential, so it can sign nothing', () => {
    expect(resolveRun({ remote: false, e2e: false, prediction: false }, {})).toEqual({
      kind: 'seed',
      scope: 'full',
    });
  });

  it('resolves an E2E-scoped local run without reading an R2 credential', () => {
    expect(resolveRun({ remote: false, e2e: true, prediction: false }, {})).toEqual({
      kind: 'seed',
      scope: 'e2e',
    });
  });

  it('resolves a prediction-scoped local run without reading an R2 credential', () => {
    expect(resolveRun({ remote: false, e2e: false, prediction: true }, {})).toEqual({
      kind: 'seed',
      scope: 'prediction',
    });
  });

  it('refuses a local run naming both subsets rather than silently seeding one of them', () => {
    expect(() => resolveRun({ remote: false, e2e: true, prediction: true }, {})).toThrow(
      '--e2e and --prediction'
    );
  });

  it('refuses a remote run with no credentials once, rather than once per object', () => {
    expect(() => resolveRun({ remote: true, e2e: false, prediction: false }, {})).toThrow(
      'R2_ACCESS_KEY_ID'
    );
  });

  it('carries the credentials a remote run signs with', () => {
    expect(resolveRun({ remote: true, e2e: false, prediction: false }, CREDENTIALS)).toEqual({
      kind: 'publish',
      config: {
        accountId: 'account-under-test',
        accessKeyId: 'key-under-test',
        secretAccessKey: 'secret-under-test',
      },
    });
  });

  it('publishes the production bucket even when a subset flag is also passed, since production always carries the full set', () => {
    expect(resolveRun({ remote: true, e2e: true, prediction: true }, CREDENTIALS)).toEqual({
      kind: 'publish',
      config: {
        accountId: 'account-under-test',
        accessKeyId: 'key-under-test',
        secretAccessKey: 'secret-under-test',
      },
    });
  });
});

describe('what a scope fills the store with', () => {
  it('fills the full store with both models, since a developer stack serves both features', () => {
    expect(artifactsFor('full')).toEqual(modelWeightsArtifacts());
  });

  it('fills an E2E store with the speech model alone', () => {
    expect(artifactsFor('e2e')).toEqual(ttsArtifacts());
  });

  it('fills a prediction store with the prediction model alone', () => {
    expect(artifactsFor('prediction')).toEqual(predictionArtifacts());
  });
});

describe('where a completed local seed is recorded', () => {
  it.each([['development'], ['e2e']] as const)(
    'sits in the %s store itself, so emptying that store takes the record with it',
    (stackMode) => {
      const store = wranglerPersistPath(stackMode);

      expect(path.dirname(seedReceiptPath(store))).toBe(store);
    }
  );

  it('records a seed of each stack at a different path, since each fills its own store', () => {
    expect(seedReceiptPath(wranglerPersistPath('development'))).not.toBe(
      seedReceiptPath(wranglerPersistPath('e2e'))
    );
  });

  it('records the full-set seed and the E2E-scoped seed at different paths', () => {
    expect(seedReceiptPath('/store', 'full')).not.toBe(seedReceiptPath('/store', 'e2e'));
  });

  it('records each narrowed scope at its own path, so one does not invalidate another', () => {
    const paths = [
      seedReceiptPath('/store', 'full'),
      seedReceiptPath('/store', 'e2e'),
      seedReceiptPath('/store', 'prediction'),
    ];

    expect(new Set(paths).size).toBe(paths.length);
  });

  it('defaults to the full-set path when no scope is given', () => {
    expect(seedReceiptPath('/store')).toBe(seedReceiptPath('/store', 'full'));
  });
});

describe("running a command against wrangler's configuration directory", () => {
  it('lets a subprocess writing the largest artifact to stdout run to completion', async () => {
    expect(await runInApiDir('node', ['-e', WRITE_LARGEST_ARTIFACT])).toEqual({
      exitCode: 0,
      stderr: '',
    });
  });
});
