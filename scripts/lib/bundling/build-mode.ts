/**
 * The mode a frontend build resolves, and the file that mode names.
 *
 * Both bundlers resolve a mode and load the generated frontend env file named
 * after it. Nothing prefixed reaches a build's process any more, so that file
 * is a build's sole supply: a mode naming a file that is not there bakes
 * nothing at all and still exits zero, which is invisible until a user meets
 * the bundle. {@link frontendEnvFilePlugin} is what makes it loud.
 *
 * Reachable from a Vite configuration, which constrains what it may import: the
 * env wrapper reaches an untyped native dependency, so it is not imported here.
 * The stack modules are, for the reason their own docblock gives.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { ENV_MODE_VARIABLE, ENV_MODES, envModeFrom, frontendModeFor } from '../stack/stack-mode.ts';
import type { EnvMode } from '@hushbox/shared';
import type { Plugin } from 'vite';

/** The repair a build is handed when nothing named the mode it is for. */
function unnamedBuildMode(): string {
  return `${ENV_MODE_VARIABLE} names no mode, so this build has nothing to bake. Name the mode it is for — \`${ENV_MODE_VARIABLE}=production\` for a shipping build — or run it through a pnpm script that names one, such as \`pnpm build:e2e\`. Valid: ${ENV_MODES.join(', ')}.`;
}

/**
 * The mode a build resolves: the one the selector names, under the name of the
 * generated frontend file that mode's values were written to.
 *
 * Every build names its mode, and a selector naming none is refused rather than
 * defaulted. Production is reachable only by being named: it is the one mode
 * that runs no stack, so nothing local writes the selector for it, and a build
 * that resolved it from absence would bake production values for an invocation
 * that had merely forgotten to say what it was building — silently, because a
 * bundle looks the same either way.
 *
 * The loader's own reader in `scripts/lib/stack/stack-mode.ts` does keep an
 * absence default, and states there why it must. A build is reached only once
 * an environment has been settled, so nothing here is circular.
 */
export function buildEnvMode(env: NodeJS.ProcessEnv): EnvMode {
  const mode = envModeFrom(env);
  if (mode === undefined) throw new Error(unnamedBuildMode());
  return frontendModeFor(mode);
}

/** The generated frontend env file a mode names, relative to the repo root. */
export function frontendEnvFile(mode: string): string {
  return `.env.${mode}`;
}

/**
 * The repair a developer is handed when the file a build's mode names is
 * absent, phrased as the missing-port message is and deriving the mode it
 * prints from the mode the bundler resolved rather than naming one.
 *
 * Production carries one clause the other modes do not: writing its file needs
 * the production secrets, so a developer who meant a local stack would read the
 * repair as unreachable. The clause names the selector that sent the build
 * there, which is the thing they can actually change.
 */
export function missingFrontendEnvFile(mode: string, file: string): string {
  const selected =
    mode === 'production'
      ? `${ENV_MODE_VARIABLE} names production, so name a stack's mode there to build for a stack instead, or `
      : '';
  return `${file} is not there, so the ${mode} build has no environment file to bake — ${selected}run \`pnpm generate:env --mode=${mode}\` to write it`;
}

/**
 * Fails a build whose mode names a file that is not there.
 *
 * It reads the mode the bundler resolved rather than one computed ahead of the
 * build, which is the whole question: the site builder merges its own resolved
 * mode into the bundler configuration it constructs, so this hook sees the same
 * mode string under every app.
 */
export function frontendEnvFilePlugin(rootDir: string): Plugin {
  return {
    name: 'frontend-env-file',
    config(_config, { command, mode }) {
      if (command !== 'build') return;
      const file = frontendEnvFile(mode);
      if (!existsSync(path.join(rootDir, file))) {
        throw new Error(missingFrontendEnvFile(mode, file));
      }
    },
  };
}
