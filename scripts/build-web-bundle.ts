#!/usr/bin/env tsx
/**
 * The e2e web-bundle build sequence: build web + marketing, merge marketing's
 * output on top of web's, then generate the CSP `_headers`. Two callers, both
 * via `pnpm build:e2e`: `scripts/e2e-preview.ts`, which serves a snapshot of
 * what this writes, and CI's `e2e-build` job. It builds no other kind of
 * bundle.
 *
 * Self-contained: regenerates the env files before building, so the bundle
 * always bakes the right `VITE_*` values (`VITE_E2E`, localhost API, sandbox
 * tokens). The env mode decides everything: it names the file the generator
 * writes, and it names the stack in the build's environment, from which each
 * bundler derives the mode it loads that same file under — so the file written
 * and the file loaded cannot name different stacks.
 *
 * Turbo orchestrates the two app builds: it runs them in parallel and restores
 * `dist/**` from cache when inputs are unchanged. Cache correctness holds across
 * the stacks a build can be run for (the variable naming one is hashed) and
 * across workspace-package
 * source edits (folded into the dependent app's hash); the env files this script
 * regenerates are a build input, declared root-anchored in `turbo.json` because
 * that is where they are written, so a regenerated env with different values
 * busts the cache rather than serving a stale bundle.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { Mode, createEnvUtilities } from '@hushbox/shared';
import { generateEnvFiles } from './generate-env.js';
import { ENV_MODE_VARIABLE } from './lib/stack/stack-mode.js';
import { mergeMarketingIntoWeb } from './merge-marketing-into-web.js';
import { appBundleOptions, verifyBundle } from './verify-bundle.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import type { VerifyBundle } from './verify-bundle.js';

type BuildTarget = 'e2e';

type EnvContext = Parameters<typeof createEnvUtilities>[0];

export const COMMAND_LINE = {
  command: 'pnpm build:e2e',
  summary: 'Builds the web bundle the E2E suite serves.',
  flags: [
    {
      flag: '--target',
      kind: 'value',
      placeholder: '<target>',
      summary: 'Which bundle to build. `e2e` is the only one this builds.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/**
 * Validates `--target` rather than dispatching on it: `e2e` is the only bundle
 * this script builds, so any other value has to fail loudly instead of silently
 * yielding an e2e bundle to a caller that asked for something else.
 */
export function assertE2eTarget(value: string | undefined): BuildTarget {
  if (value === 'e2e') return value;
  throw new Error(`build-web-bundle requires --target=e2e (got: ${value ?? 'none'})`);
}

/**
 * The e2e env mode, split on CI: CI adds the Helcim sandbox secrets the test env
 * expects (`CiE2E` extends `E2E`). Uses the shared `envUtils` detector — never a
 * direct `process.env.CI` check.
 */
export function selectE2eEnvMode(env: EnvContext): Mode {
  return createEnvUtilities(env).isCI ? Mode.CiE2E : Mode.E2E;
}

export interface BuildWebBundleDeps {
  readonly generateEnv: (rootDir: string, mode: Mode, options?: { skipBackend?: boolean }) => void;
  readonly exec: (
    file: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>
  ) => Promise<unknown>;
  readonly merge: (options: { repoRoot: string }) => Promise<unknown>;
  readonly verify: VerifyBundle;
}

export async function buildWebBundle(
  rootDir: string,
  env: EnvContext,
  deps: BuildWebBundleDeps
): Promise<void> {
  const envMode = selectE2eEnvMode(env);

  // Skipping the backend env means this build never generates the server
  // secrets and never requires them. It does not keep the backend dev-vars out
  // of the build's environment: the marketing package's build script wraps
  // itself in `with-env`, which loads an existing dev-vars file with override.
  // The end-to-end preparation writes one locally; the pipeline never does.
  deps.generateEnv(rootDir, envMode, { skipBackend: true });

  // `^build` is free here (workspace packages have no build script); the filter
  // keeps a future buildable app out of the web bundle.
  //
  // The mode is named in the build's environment rather than passed through on
  // the command line. Each bundler derives its mode from that one variable and
  // resolves it to the frontend env file `generateEnvFiles` has just written
  // under that same mode, so the file written and the file loaded cannot disagree —
  // and a task no requested task name reaches, which a passthrough can never
  // supply, derives the same answer. The task runner hashes the variable, so a
  // build for one mode cannot replay from another's cache entry. The mode also
  // drives `build.minify` in `apps/web/vite.config.ts`; the e2e bundle stays
  // unminified there through the flag the env file bakes, not through this.
  const modeEnv = { [ENV_MODE_VARIABLE]: envMode };
  await deps.exec(
    'turbo',
    ['build', '--filter=@hushbox/web', '--filter=@hushbox/marketing'],
    modeEnv
  );

  await deps.merge({ repoRoot: rootDir });

  // Under with-env, and under the same stack the build ran for, so the
  // freshly generated VITE_API_URL / minio port reach the CSP generator.
  await deps.exec('tsx', ['scripts/with-env.ts', 'tsx', 'scripts/generate-headers.ts'], modeEnv);

  // Last, because the defects it catches only exist once marketing's output has
  // landed on top of web's — a stray ORT copy, or a file count past the Pages
  // limit — and because it asserts the `_headers` the step above writes.
  //
  // The mode goes with it so the bundle is checked against the stack this
  // command named, rather than only against itself: everything above derives
  // one answer from this one mode, and a bundle baking another stack's
  // addresses is invisible until someone loads it.
  await deps.verify(appBundleOptions(rootDir, 'apps/web', undefined, envMode));
}

/* v8 ignore start -- CLI entry point exercised via the build:e2e package script */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
    if (parsed === null) return;
    assertE2eTarget(parsed.flags['--target']);
    await buildWebBundle(repoRoot, process.env, {
      generateEnv: generateEnvFiles,
      exec: (file, args, env) => execa(file, [...args], { stdio: 'inherit', cwd: repoRoot, env }),
      merge: mergeMarketingIntoWeb,
      verify: verifyBundle,
    });
  });
}
/* v8 ignore stop */
