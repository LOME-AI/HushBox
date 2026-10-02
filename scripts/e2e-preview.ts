#!/usr/bin/env tsx
/**
 * Builds one e2e bundle and serves a private snapshot of it, as the command
 * behind a Playwright `webServer`. The build and the serve are one process
 * because the copy that separates them has to happen inside the build lease:
 * taken around the build alone, a concurrent writer could wipe the output
 * between the release and the copy, and taken around the serve as well it would
 * refuse every other writer for the length of the run.
 *
 * What the snapshot buys, and how it is reclaimed, is in
 * `scripts/lib/bundling/bundle-snapshot.ts`. The build scripts this runs take the
 * same lease themselves; they inherit this process's claim rather than meeting
 * it, so nesting them costs nothing.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { withBundleSnapshot } from './lib/bundling/bundle-snapshot.js';
import { isMainModule } from './lib/cli/is-main.js';
import { parseCommandLine, readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';
import type { BuildOutput } from './lib/bundling/lease.js';
import type { RamRootHost } from './lib/stack/ram-root.js';

export type PreviewApp = 'web' | 'admin';

interface AppPreview {
  readonly resource: BuildOutput;
  readonly packageName: string;
  /** The package script that builds the e2e bundle, lease and all. */
  readonly buildScript: string;
}

const APPS: Record<PreviewApp, AppPreview> = {
  web: { resource: 'web-dist', packageName: '@hushbox/web', buildScript: 'build:e2e' },
  admin: { resource: 'admin-dist', packageName: '@hushbox/admin', buildScript: 'build:e2e:admin' },
};

export const COMMAND_LINE = {
  command: 'tsx scripts/e2e-preview.ts',
  summary: "Builds one app's E2E bundle and serves a private snapshot of it.",
  flags: [
    {
      flag: '--app',
      kind: 'value',
      placeholder: '<app>',
      summary: 'Which app to build and serve.',
    },
    {
      flag: '--port',
      kind: 'value',
      placeholder: '<port>',
      summary: 'The port the snapshot is served on.',
    },
    {
      flag: '--prebuilt',
      kind: 'boolean',
      summary: 'Serve a bundle built elsewhere rather than building one.',
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

function flagValue(args: readonly string[], flag: '--app' | '--port'): string | undefined {
  const parsed = parseCommandLine(COMMAND_LINE, args);
  return parsed.kind === 'help' ? undefined : parsed.flags[flag];
}

function isPreviewApp(value: string | undefined): value is PreviewApp {
  return value !== undefined && value in APPS;
}

export function readApp(args: readonly string[]): PreviewApp {
  const value = flagValue(args, '--app');
  if (!isPreviewApp(value)) {
    throw new Error(
      `e2e-preview serves ${Object.keys(APPS).join(' or ')}, not \`${value ?? 'nothing'}\`.`
    );
  }
  return value;
}

export function readPort(args: readonly string[]): string {
  const value = flagValue(args, '--port');
  if (value === undefined || value === '') {
    throw new Error('e2e-preview requires the port to serve on');
  }
  return value;
}

/** Set by the caller that already downloaded a bundle built elsewhere. */
export function readPrebuilt(args: readonly string[]): boolean {
  const parsed = parseCommandLine(COMMAND_LINE, args);
  return parsed.kind === 'run' && parsed.flags['--prebuilt'];
}

export interface E2ePreviewOptions {
  readonly app: PreviewApp;
  readonly port: string;
  readonly prebuilt: boolean;
}

export interface E2ePreviewDeps {
  readonly exec: (file: string, args: readonly string[]) => Promise<number>;
  /** Where the checkout's RAM root is made, the machine's own RAM filesystem when not given. */
  readonly ramHost?: RamRootHost;
}

export async function runE2ePreview(
  repoRoot: string,
  options: E2ePreviewOptions,
  deps: E2ePreviewDeps
): Promise<number> {
  const app = APPS[options.app];
  return withBundleSnapshot(
    {
      repoRoot,
      resource: app.resource,
      source: path.join(repoRoot, 'apps', options.app, 'dist'),
      holder: `pnpm e2e (${options.app} bundle)`,
      ramHost: deps.ramHost,
      produce: async () => {
        if (options.prebuilt) return;
        const exitCode = await deps.exec('pnpm', [app.buildScript]);
        if (exitCode !== 0) {
          throw new Error(`\`pnpm ${app.buildScript}\` failed with exit code ${String(exitCode)}`);
        }
      },
    },
    (snapshot) =>
      deps.exec('pnpm', [
        '--filter',
        app.packageName,
        'preview',
        '--port',
        options.port,
        '--outDir',
        snapshot,
      ])
  );
}

/* v8 ignore start -- CLI entry point exercised via playwright.config.ts's webServer */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const repoRoot = path.resolve(scriptDir, '..');
    const args = process.argv.slice(2);
    if (readCommandLine(COMMAND_LINE, args) === null) return 0;
    return runE2ePreview(
      repoRoot,
      { app: readApp(args), port: readPort(args), prebuilt: readPrebuilt(args) },
      {
        exec: async (file, execArgs) => {
          const result = await execa(file, [...execArgs], {
            stdio: 'inherit',
            cwd: repoRoot,
            reject: false,
          });
          return result.exitCode ?? 1;
        },
      }
    );
  });
}
/* v8 ignore stop */
