import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BundlerInternals, bundle, webpack } from '@remotion/bundler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { withFilmBundle } from './film-browser.driver.js';
import { FILMS_ROOT } from './films.driver.js';

import type { BundleOptions } from '@remotion/bundler';
import type { DiscoveredFilm } from '../film/discover.js';

vi.mock('@remotion/bundler', async (importOriginal) => {
  const original: object = await importOriginal();
  return { ...original, bundle: vi.fn() };
});

/** The piece the bundle is for, as discovery lists it. */
const PIECE_DIR = 'engine/fixtures/fixture';

const FILM: DiscoveredFilm = {
  id: 'fixture',
  dir: path.join(FILMS_ROOT, ...PIECE_DIR.split('/')),
};

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'films-film-browser-'));
});

afterEach(() => {
  vi.mocked(bundle).mockReset();
  rmSync(root, { recursive: true, force: true });
});

/** The options `withFilmBundle` hands the bundler. */
async function bundleOptions(): Promise<BundleOptions> {
  vi.mocked(bundle).mockResolvedValue('serve-url');
  await withFilmBundle(FILM, () => Promise.resolve());
  const options = vi.mocked(bundle).mock.calls[0]?.[0];
  if (options === undefined || typeof options === 'string') {
    throw new Error('withFilmBundle did not call bundle() with an options object');
  }
  return options;
}

/** Runs a webpack configuration to completion, the compiler closed, so any persistent cache is written. */
async function compile(configuration: webpack.Configuration): Promise<void> {
  const compiler = webpack.webpack(configuration);
  await new Promise<void>((resolve, reject) => {
    compiler.run((error) => {
      compiler.close((closeError) => {
        const failure = error ?? closeError;
        if (failure) reject(failure);
        else resolve();
      });
    });
  });
}

describe('withFilmBundle', () => {
  it("writes no webpack cache file under the configuration Remotion's bundler builds from its options", async () => {
    const options = await bundleOptions();
    mkdirSync(path.join(root, ...PIECE_DIR.split('/')), { recursive: true });
    mkdirSync(path.join(root, 'src'));
    writeFileSync(path.join(root, 'src', 'index.js'), 'module.exports = 1;\n');
    const [, configuration] = await BundlerInternals.webpackConfig({
      entry: path.join(root, 'src', 'index.js'),
      userDefinedComponent: options.entryPoint,
      outDir: path.join(root, 'bundle'),
      environment: 'production',
      webpackOverride: options.webpackOverride ?? ((config) => config),
      enableCaching: options.enableCaching ?? true,
      maxTimelineTracks: null,
      remotionRoot: root,
      keyboardShortcutsEnabled: true,
      bufferStateDelayInMilliseconds: null,
      poll: null,
      askAIEnabled: true,
      interactivityEnabled: true,
      experimentalClientSideRenderingEnabled: false,
      extraPlugins: [],
    });
    const { cache } = configuration;
    if (typeof cache !== 'object' || cache.type !== 'filesystem') {
      throw new Error("the bundler's configuration does not ask for webpack's filesystem cache");
    }
    const cacheDirectory = path.join(root, 'cache');

    await compile({
      ...configuration,
      entry: path.join(root, 'src', 'index.js'),
      cache: { ...cache, cacheDirectory },
    });

    expect(existsSync(cacheDirectory)).toBe(false);
  });
});
