import { readdirSync } from 'node:fs';
import path from 'node:path';

import { webpack } from '@remotion/bundler';
import { enableTailwind } from '@remotion/tailwind-v4';

import { discoverFilms, discoverTakes } from '../film/discover.js';

import { pieceModuleMap } from './piece-modules.js';

import type { WebpackConfiguration } from '@remotion/bundler';

/**
 * The directory the registry's module context opens, under the package root:
 * `src/root.tsx` calls `require.context('.', …)` from it.
 */
const REGISTRY_DIRECTORY = 'src';

/** A pattern matching `text` exactly. */
function exactly(text: string): RegExp {
  const literal = text.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);
  return new RegExp(`^${literal}$`);
}

/** The POSIX-separated path of `dir` under `root`. */
function underRoot(root: string, dir: string): string {
  return path.relative(root, dir).split(path.sep).join('/');
}

/**
 * Hands the registry's module context the modules of the pieces `piecesOf`
 * lists under the bundle's root, as an explicit map. Webpack then lists no
 * directory to find them: the context's own walk would read every directory
 * under the package, `node_modules` and the workspace packages it links to
 * included, and fail on a directory removed mid-walk. The context is the
 * registry's own directory, which holds no subdirectory, so the snapshot
 * webpack takes of it reads that one directory alone.
 */
function registryOf(piecesOf: (root: string) => readonly string[]): webpack.WebpackPluginInstance {
  return {
    apply(compiler) {
      const root = compiler.context;
      const registry = path.join(root, REGISTRY_DIRECTORY);
      new webpack.ContextReplacementPlugin(
        exactly(registry),
        registry,
        pieceModuleMap(root, piecesOf(root))
      ).apply(compiler);
    },
  };
}

/**
 * Keeps every films bundle off webpack's persistent cache. The cache is not
 * keyed on the registry's map, so a warm one serves a piece list that no
 * longer matches discovery. Remotion sets `cache` after the override has run,
 * and Studio never reads the config's caching setting, so the override cannot
 * clear it; a plugin can, because webpack applies plugins before it installs
 * the cache the `cache` option asks for.
 */
const NO_PERSISTENT_CACHE: webpack.WebpackPluginInstance = {
  apply(compiler) {
    compiler.options.cache = false;
  },
};

/** The loader that compiles a stylesheet through Tailwind and scans for its utilities. */
const TAILWIND_LOADER = /@tailwindcss[/\\]webpack/;

/** Whether `dir` holds render products: any `out/`, and the public directory under `root`. */
function isRenderOutput(root: string, dir: string): boolean {
  return path.basename(dir) === 'out' || dir === path.join(root, 'public');
}

/**
 * The fewest directories that cover everything under `dir` but render output:
 * `dir` itself when nothing under it is render output, otherwise the same for
 * each of its subdirectories. Files directly inside a split directory are left
 * to the file dependencies the scan records for each file it read.
 */
function outputFree(root: string, dir: string): string[] {
  if (isRenderOutput(root, dir)) return [];
  const children = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
  const covers = children.map((child) => outputFree(root, child));
  const whole = covers.every((cover, index) => cover.length === 1 && cover[0] === children[index]);
  return whole ? [dir] : covers.flat();
}

/**
 * Keeps render output out of the directories the Tailwind scan asks webpack to
 * watch. The loader adds each scanned base as a context dependency, and webpack
 * hashes a context dependency's whole tree, `out/` included, so a render product
 * deleted mid-hash crashed the bundle. Tailwind's `source()` and `@source not`
 * cannot prevent it: a negated source only skips its own glob, and any glob that
 * reaches a piece's own files has a base at or above the piece's `out/`. Each
 * such base is replaced, before webpack snapshots it, by the directories under
 * it that hold no render output.
 */
const SCAN_WITHOUT_RENDER_OUTPUT: webpack.WebpackPluginInstance = {
  apply(compiler) {
    compiler.hooks.compilation.tap('films-scan-without-render-output', (compilation) => {
      webpack.NormalModule.getCompilationHooks(compilation).beforeSnapshot.tap(
        'films-scan-without-render-output',
        (module) => {
          const contexts = module.buildInfo?.contextDependencies;
          if (!contexts || !module.loaders.some(({ loader }) => TAILWIND_LOADER.test(loader))) {
            return;
          }
          const kept = [...contexts].flatMap((dir) => outputFree(compiler.context, dir));
          contexts.clear();
          contexts.addAll(kept);
        }
      );
    });
  },
};

/** The films override, registering the pieces `piecesOf` lists. */
function overrideFor(
  config: WebpackConfiguration,
  piecesOf: (root: string) => readonly string[]
): WebpackConfiguration {
  const withTailwind = enableTailwind(config);
  return {
    ...withTailwind,
    plugins: [
      ...(withTailwind.plugins ?? []),
      registryOf(piecesOf),
      NO_PERSISTENT_CACHE,
      SCAN_WITHOUT_RENDER_OUTPUT,
    ],
    resolve: {
      ...withTailwind.resolve,
      extensionAlias: {
        ...withTailwind.resolve?.extensionAlias,
        '.js': ['.ts', '.tsx', '.js'],
      },
    },
  };
}

/** Every film, engine fixture and take discovery lists under `root`, POSIX-separated. */
function everyPiece(root: string): string[] {
  return [...discoverFilms(root), ...discoverTakes(root)].map(({ dir }) => underRoot(root, dir));
}

/**
 * The films bundle's webpack override, shared by Studio, the Remotion CLI (through
 * `remotion.config.ts`) and every programmatic `bundle()` call, which never reads
 * that config file and must pass an override itself. It registers every piece
 * discovery lists under the package.
 *
 * Every stylesheet compiles through Tailwind, because the brand stylesheet a film
 * imports is Tailwind source; the fonts it pulls in stay with the bundler's own
 * asset rules.
 *
 * Source imports use ESM `.js` specifiers that name `.ts`/`.tsx` files on disk;
 * TypeScript resolves them natively, webpack only through `extensionAlias`.
 */
export function filmsWebpackOverride(config: WebpackConfiguration): WebpackConfiguration {
  return overrideFor(config, everyPiece);
}

/**
 * The films override for a render's bundle, registering only the piece in
 * `pieceDir` (POSIX-separated, under the package), so a piece mid-edit
 * elsewhere under the package never enters the bundle.
 */
export function pieceWebpackOverride(
  pieceDir: string
): (config: WebpackConfiguration) => WebpackConfiguration {
  return (config) => overrideFor(config, () => [pieceDir]);
}
