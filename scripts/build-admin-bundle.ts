#!/usr/bin/env tsx
/**
 * The single admin-bundle build path for E2E: regenerate the env files for the
 * e2e mode, then build the admin SPA. Consumed by CI's admin e2e build and by
 * `scripts/e2e-preview.ts` (both via `pnpm build:e2e:admin`).
 *
 * It takes the web bundle's env method verbatim. `generateEnvFiles(...,
 * Mode.E2E|CiE2E)` bakes `VITE_E2E` (localhost API, sandbox tokens), and the
 * stack named in the build's environment is what the admin bundler derives its
 * mode from, picking which Vite env file loads (from `envDir` in
 * `apps/admin/vite.config.ts`) — so the static build keeps the dev-JWT
 * self-auth path (`computeDevAuthEnabled`). The mode changes which values are
 * inlined and nothing else, so an admin build is minified in every mode.
 *
 * It reuses `selectE2eEnvMode` and `generateEnvFiles` verbatim from the web
 * path; everything it does differently is admin-specific — the turbo filter
 * (`@hushbox/admin`), the absence of the marketing merge (admin is a
 * standalone SPA on its own origin with no marketing content), the stack named
 * in the environment. Admin's own security headers (CSP +
 * `X-Frame-Options` + HSTS) are emitted by the admin Vite build's dist-finalize
 * plugin (`apps/admin/vite.config.ts`), not assembled here — and so is the
 * bundle guard, which is why this script does not run one: the deployed
 * `admin-dist` never comes near this file.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { generateEnvFiles } from './generate-env.js';
import { selectE2eEnvMode } from './build-web-bundle.js';
import { ENV_MODE_VARIABLE } from './lib/stack/stack-mode.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import type { Mode, createEnvUtilities } from '@hushbox/shared';

type EnvContext = Parameters<typeof createEnvUtilities>[0];

export interface BuildAdminBundleDeps {
  readonly generateEnv: (rootDir: string, mode: Mode, options?: { skipBackend?: boolean }) => void;
  readonly exec: (
    file: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>
  ) => Promise<unknown>;
}

export async function buildAdminBundle(
  rootDir: string,
  env: EnvContext,
  deps: BuildAdminBundleDeps
): Promise<void> {
  const envMode = selectE2eEnvMode(env);

  // Frontend-only: the build reads the frontend env file, never the backend
  // dev-vars, so skipping the backend env means the server secrets are never
  // required by this build.
  deps.generateEnv(rootDir, envMode, { skipBackend: true });

  // The mode named in the build's environment is what every bundler in this
  // run derives its mode from, resolving it to the frontend env file just
  // written under it. No marketing merge here; admin's CSP `_headers` are
  // emitted by the admin Vite build's own plugin.
  //
  // Naming the mode in the environment rather than on the command line is what
  // reaches the marketing site's second build — the one the admin origin's
  // framed copy comes from, which runs as a dependency under a name no request
  // ever carries, so no passthrough argument can reach it. `with-env` resolves
  // the name to the files this run just generated, and the task runner hashes
  // the variable, so a build for one mode cannot replay from another's cache
  // entry.
  await deps.exec('turbo', ['build', '--filter=@hushbox/admin'], {
    [ENV_MODE_VARIABLE]: envMode,
  });
}

export const COMMAND_LINE = {
  command: 'pnpm build:e2e:admin',
  summary: 'Builds the admin bundle the E2E suite serves.',
  flags: [],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/* v8 ignore start -- CLI entry point exercised via the build:* package scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    if (readCommandLine(COMMAND_LINE, process.argv.slice(2)) === null) return;
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    await buildAdminBundle(repoRoot, process.env, {
      generateEnv: generateEnvFiles,
      exec: (file, args, env) => execa(file, [...args], { stdio: 'inherit', cwd: repoRoot, env }),
    });
  });
}
/* v8 ignore stop */
