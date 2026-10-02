#!/usr/bin/env tsx
/**
 * The marketing site's build, run under the mode the stack selector resolves.
 *
 * The site builder takes its mode from its command line alone: it merges its
 * own resolved mode into the bundler configuration it constructs, so a mode
 * written in that configuration is read too late to be the one it resolves.
 * Naming the mode here is therefore the only route the derivation has into a
 * site build — and the only route at all for the admin origin's framed copy,
 * whose task name is never a requested task name, so no pass-through argument
 * can reach it however it is invoked.
 */
import { execa } from 'execa';
import { buildEnvMode } from './lib/bundling/build-mode.js';
import { isMainModule } from './lib/cli/is-main.js';
import { readCommandLine, type CommandSpec } from './lib/cli/command-line.js';
import { runMain } from './lib/cli/run-main.js';

export const COMMAND_LINE = {
  command: 'pnpm --filter @hushbox/marketing build',
  summary: 'Builds the marketing site under the mode the stack selector resolves.',
  flags: [
    {
      flag: '--config',
      kind: 'value',
      placeholder: '<file>',
      summary: "The site configuration to build, when it is not the package's own.",
    },
  ],
  positionals: { kind: 'none' },
} as const satisfies CommandSpec;

/**
 * The site build's arguments: the configuration the caller named, under the
 * derived mode.
 *
 * No caller may name the mode — the grammar above declares no flag for it — so
 * the one written here is the only one the site builder sees. A second
 * spelling would decide which stack's file the build bakes, because the builder
 * takes the last of a repeated flag, and that is the failure this derivation
 * exists to remove.
 */
export function siteBuildArguments(
  configFile: string | undefined,
  env: NodeJS.ProcessEnv
): readonly string[] {
  const named = configFile === undefined ? [] : ['--config', configFile];
  return ['build', ...named, '--mode', buildEnvMode(env)];
}

/* v8 ignore start -- CLI entry point exercised via the marketing package scripts */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    const parsed = readCommandLine(COMMAND_LINE, process.argv.slice(2));
    if (parsed === null) return;
    await execa('astro', [...siteBuildArguments(parsed.flags['--config'], process.env)], {
      stdio: 'inherit',
    });
  });
}
/* v8 ignore stop */
