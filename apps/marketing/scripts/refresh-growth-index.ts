import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'astro';
import { Destination, Mode, getDestinations, isSecret, resolveRaw } from '@hushbox/shared';
import { envConfig } from '@hushbox/shared/env.config';
import { escapeEnvValue } from '../../../scripts/generate-env.js';
import { buildEnvMode, frontendEnvFile } from '../../../scripts/lib/bundling/build-mode.js';
import { isMainModule } from '../../../scripts/lib/cli/is-main.js';
import { runMain } from '../../../scripts/lib/cli/run-main.js';
import { ENV_MODE_VARIABLE } from '../../../scripts/lib/stack/stack-mode.js';
import { INDEX_FILE, writeGrowthEventIndex } from './growth-index.js';
import type { VariableConfig } from '@hushbox/shared';
import type { AstroInlineConfig } from 'astro';

/**
 * `pnpm growth:index:refresh`: rebuilds the marketing site under production
 * and rewrites the committed growth index from that build, on any checkout.
 *
 * No production credential decides a click name, so every secret-typed value
 * the production build bakes is stood in for with that entry's development
 * value, and the build runs against a configuration that reads its env file
 * from, and writes its pages to, a scratch directory: the checkout's own
 * build output and production env file are never touched.
 */

const CURRENT_DIR = path.dirname(fileURLToPath(import.meta.url));
const MARKETING_ROOT = path.resolve(CURRENT_DIR, '..');
const REPO_ROOT = path.resolve(MARKETING_ROOT, '../..');

/** Where one refresh's site build reads and writes. */
export interface SiteBuild {
  readonly configFile: string;
  readonly envDir: string;
  readonly outDir: string;
}

export interface RefreshOptions {
  /** The directory the scratch directory is made in. */
  readonly scratchParent: string;
  readonly indexFile: string;
  /** Builds the site; a rejection means no build to extract from. */
  readonly build: (site: SiteBuild) => Promise<void>;
}

/**
 * The production frontend env file, with each secret-typed value replaced by
 * that entry's development value — a value the registry already holds in the
 * shape the build expects, and one no deploy ships.
 */
export function placeholderProductionEnv(
  registry: Readonly<Record<string, VariableConfig>>
): string {
  const lines = Object.entries(registry)
    .filter(([, config]) => getDestinations(config, Mode.Production).includes(Destination.Frontend))
    .map(([key, config]) => {
      const production = resolveRaw(config, Mode.Production);
      const value = isSecret(production) ? resolveRaw(config, Mode.Development) : production;
      if (typeof value !== 'string') {
        throw new TypeError(
          `${key} is secret in production and has no development literal to stand in for it`
        );
      }
      return `${key}=${escapeEnvValue(value, key)}`;
    });
  return `${lines.join('\n')}\n`;
}

/**
 * The source of a site configuration that is the package's own with three
 * changes: pages go to `outDir`, env files are read from `envDir`, and the
 * guard that fails a build whose env file is missing looks in `envDir` too.
 */
export function siteConfigModule(paths: {
  readonly packageConfig: string;
  readonly buildModeModule: string;
  readonly outDir: string;
  readonly envDir: string;
}): string {
  const envDir = JSON.stringify(paths.envDir);
  return [
    `import config from ${JSON.stringify(pathToFileURL(paths.packageConfig).href)};`,
    `import { frontendEnvFilePlugin } from ${JSON.stringify(pathToFileURL(paths.buildModeModule).href)};`,
    'export default {',
    '  ...config,',
    `  outDir: ${JSON.stringify(paths.outDir)},`,
    '  vite: {',
    '    ...config.vite,',
    `    envDir: ${envDir},`,
    '    plugins: config.vite.plugins.map((plugin) =>',
    `      plugin?.name === 'frontend-env-file' ? frontendEnvFilePlugin(${envDir}) : plugin`,
    '    ),',
    '  },',
    '};',
    '',
  ].join('\n');
}

/**
 * Removes from `env` every variable the bundler would bake over the env file's
 * value: it reads a prefixed variable from its own process before the file, and
 * a link's destination, which a click name is derived from, is one such value.
 */
export function dropBakedVariables(env: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(env)) {
    if (key.startsWith('VITE_') || key.startsWith('PUBLIC_')) Reflect.deleteProperty(env, key);
  }
}

/**
 * The site builder's options for `site`: the package as the root, under the
 * mode a production build resolves. The builder joins a configuration path
 * onto the root rather than resolving it, so the path is given relative to it.
 */
export function siteBuildOptions(site: SiteBuild): AstroInlineConfig {
  return {
    root: MARKETING_ROOT,
    configFile: path.relative(MARKETING_ROOT, site.configFile),
    mode: buildEnvMode({ [ENV_MODE_VARIABLE]: Mode.Production }),
  };
}

/**
 * Builds the site into a fresh scratch directory and extracts the index from
 * that build, only once the build has succeeded: a build that fails part way
 * leaves the pages it had already rendered, and an index taken from them
 * silently drops every page after the failure.
 */
export async function refreshGrowthIndex(options: RefreshOptions): Promise<void> {
  mkdirSync(options.scratchParent, { recursive: true });
  const scratch = mkdtempSync(path.join(options.scratchParent, 'growth-index-refresh-'));
  try {
    const site: SiteBuild = {
      configFile: path.join(scratch, 'site.config.mjs'),
      envDir: path.join(scratch, 'env'),
      outDir: path.join(scratch, 'dist'),
    };
    mkdirSync(site.envDir);
    writeFileSync(
      path.join(site.envDir, frontendEnvFile(Mode.Production)),
      placeholderProductionEnv(envConfig)
    );
    writeFileSync(
      site.configFile,
      siteConfigModule({
        packageConfig: path.join(MARKETING_ROOT, 'astro.config.mjs'),
        buildModeModule: path.join(REPO_ROOT, 'scripts', 'lib', 'bundling', 'build-mode.ts'),
        outDir: site.outDir,
        envDir: site.envDir,
      })
    );
    await options.build(site);
    writeGrowthEventIndex(site.outDir, options.indexFile);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/* v8 ignore start -- the CLI entry, run by `pnpm growth:index:refresh`; a test imports this module instead of executing it */
if (isMainModule(import.meta.url)) {
  await runMain(async () => {
    dropBakedVariables(process.env);
    await refreshGrowthIndex({
      // Inside the package, not the OS temp directory: the site builder moves
      // its prerendered assets into the output directory by rename, which
      // fails across filesystems.
      scratchParent: path.join(MARKETING_ROOT, 'node_modules', '.cache'),
      indexFile: path.join(REPO_ROOT, INDEX_FILE),
      build: async (site) => {
        await build(siteBuildOptions(site));
      },
    });
  });
}
/* v8 ignore stop */
