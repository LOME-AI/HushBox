import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { BundlerInternals, webpack } from '@remotion/bundler';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { filmsWebpackOverride, pieceWebpackOverride } from './webpack-override.js';

import type { WebpackConfiguration } from '@remotion/bundler';

type Rule = NonNullable<NonNullable<WebpackConfiguration['module']>['rules']>[number];

/** The bundler's own rule for stylesheets, which knows nothing of Tailwind. */
const BUNDLER_CSS_RULE: Rule = { test: /\.css$/i, use: ['style-loader', 'css-loader'] };
const BUNDLER_FONT_RULE: Rule = { test: /\.(woff(2)?|otf|ttf|eot)$/, type: 'asset/resource' };

/** The override's rules that a stylesheet import is matched against. */
function cssRules(config: WebpackConfiguration): Rule[] {
  return (filmsWebpackOverride(config).module?.rules ?? []).filter(
    (rule) =>
      typeof rule === 'object' &&
      rule !== null &&
      rule.test instanceof RegExp &&
      rule.test.test('index.css')
  );
}

describe('filmsWebpackOverride', () => {
  it('compiles stylesheets through Tailwind', () => {
    const [rule] = cssRules({ module: { rules: [BUNDLER_CSS_RULE] } });

    expect(JSON.stringify(rule)).toMatch(/@tailwindcss[/\\]webpack/);
  });

  it('leaves no stylesheet rule that bypasses Tailwind', () => {
    const bypassing = cssRules({ module: { rules: [BUNDLER_CSS_RULE] } }).filter(
      (rule) => !/@tailwindcss[/\\]webpack/.test(JSON.stringify(rule))
    );

    expect(bypassing).toEqual([]);
  });

  it('keeps the rules for everything but stylesheets', () => {
    const config: WebpackConfiguration = {
      module: { rules: [BUNDLER_CSS_RULE, BUNDLER_FONT_RULE] },
    };

    expect(filmsWebpackOverride(config).module?.rules).toContain(BUNDLER_FONT_RULE);
  });

  it('resolves a .js specifier to the .ts or .tsx source beside it', () => {
    const config: WebpackConfiguration = { resolve: { extensions: ['.ts', '.tsx', '.js'] } };

    expect(filmsWebpackOverride(config).resolve?.extensionAlias).toEqual({
      '.js': ['.ts', '.tsx', '.js'],
    });
  });

  it('keeps the rest of the resolve configuration', () => {
    const config: WebpackConfiguration = { resolve: { extensions: ['.ts', '.tsx', '.js'] } };

    expect(filmsWebpackOverride(config).resolve?.extensions).toEqual(['.ts', '.tsx', '.js']);
  });

  it('keeps the configuration outside resolve', () => {
    const config: WebpackConfiguration = { mode: 'production', resolve: {} };

    expect(filmsWebpackOverride(config).mode).toBe('production');
  });

  it('keeps extension aliases the configuration already declares', () => {
    const config: WebpackConfiguration = { resolve: { extensionAlias: { '.mjs': ['.mts'] } } };

    expect(filmsWebpackOverride(config).resolve?.extensionAlias).toEqual({
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts'],
    });
  });

  it('adds the alias when the configuration has no resolve block', () => {
    expect(filmsWebpackOverride({}).resolve?.extensionAlias).toEqual({
      '.js': ['.ts', '.tsx', '.js'],
    });
  });
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'films-webpack-override-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** Writes `content` at `file` (POSIX-separated, relative to the package root). */
function write(file: string, content: string): void {
  const absolute = path.join(root, ...file.split('/'));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content);
}

/** A piece module that exports the path it was written at. */
function writeModule(file: string): void {
  write(file, `export const where = ${JSON.stringify(file)};\n`);
}

/** The registry's module context as `src/root.tsx` opens it, loading each module it maps. */
const REGISTRY_ENTRY = `const modules = require.context('.', false, /^$/);
module.exports = Object.fromEntries(modules.keys().map((key) => [key, modules(key).where]));
`;

/** A package holding two films, a take, a stray copy under out/, and a package under node_modules. */
function writePackage(): void {
  write('src/index.js', REGISTRY_ENTRY);
  writeModule('a-film/film.ts');
  writeModule('a-film/look.ts');
  writeModule('a-film/palette.ts');
  writeModule('a-film/rounds/01/a-take/look.ts');
  writeModule('a-film/rounds/01/a-take/score.ts');
  writeModule('a-film/out/copy/film.ts');
  writeModule('b-film/film.ts');
  writeModule('node_modules/some-package/stray/film.ts');
}

interface Bundled {
  /** What the bundle's entry exports. */
  readonly exports: unknown;
  /** The bundle's source. */
  bundled: () => string;
  /** Every directory webpack listed while bundling. */
  listed: string[];
  contextDependencies: string[];
  errors: string[];
}

/** Bundles the package's `src/index.js` under `override`, recording each directory webpack lists. */
async function bundleWith(
  override: (config: WebpackConfiguration) => WebpackConfiguration,
  /** The cache the bundler sets after the override has run, as Remotion's bundler does. */
  cache: WebpackConfiguration['cache'] = false
): Promise<Bundled> {
  const listed: string[] = [];
  const recorder: webpack.WebpackPluginInstance = {
    apply(compiler) {
      const fs = compiler.inputFileSystem;
      if (fs === null) throw new Error('the compiler has no input file system');
      fs.readdir = new Proxy(fs.readdir, {
        apply(target, receiver, args: unknown[]): unknown {
          listed.push(String(args[0]));
          return Reflect.apply(target, receiver, args);
        },
      });
    },
  };
  const output = path.join(root, 'out');
  const overridden = override({});
  const compiler = webpack.webpack({
    ...overridden,
    context: root,
    entry: path.join(root, 'src', 'index.js'),
    mode: 'none',
    target: 'node',
    output: { path: output, filename: 'main.js', library: { type: 'commonjs2' } },
    plugins: [...(overridden.plugins ?? []), recorder],
    cache,
  });
  // Webpack writes its persistent cache while the compiler closes, so the bundle settles only then.
  const stats = await new Promise<webpack.Stats>((resolve, reject) => {
    compiler.run((error, result) => {
      compiler.close((closeError) => {
        const failure = error ?? closeError;
        if (failure) reject(failure);
        else if (result === undefined) reject(new Error('webpack returned no stats'));
        else resolve(result);
      });
    });
  });
  const { compilation } = stats;
  const errors = compilation.errors.map((error) => error.message);
  return {
    // Read on demand: a bundle holding a stylesheet injects it into a document when loaded.
    get exports(): unknown {
      if (errors.length > 0) return null;
      const loaded: unknown = createRequire(import.meta.url)(path.join(output, 'main.js'));
      return loaded;
    },
    bundled: () => readFileSync(path.join(output, 'main.js'), 'utf8'),
    listed,
    contextDependencies: [...compilation.contextDependencies],
    errors,
  };
}

describe('the registry a bundle builds', () => {
  it("maps Studio's registry to the modules of every film and take discovery lists", async () => {
    writePackage();

    const { exports, errors } = await bundleWith(filmsWebpackOverride);

    expect(errors).toEqual([]);
    expect(exports).toEqual({
      './a-film/film.ts': 'a-film/film.ts',
      './a-film/look.ts': 'a-film/look.ts',
      './a-film/rounds/01/a-take/look.ts': 'a-film/rounds/01/a-take/look.ts',
      './a-film/rounds/01/a-take/score.ts': 'a-film/rounds/01/a-take/score.ts',
      './b-film/film.ts': 'b-film/film.ts',
    });
  });

  it("maps a piece's registry to that piece's modules alone", async () => {
    writePackage();

    const { exports } = await bundleWith(pieceWebpackOverride('a-film/rounds/01/a-take'));

    expect(exports).toEqual({
      './a-film/rounds/01/a-take/look.ts': 'a-film/rounds/01/a-take/look.ts',
      './a-film/rounds/01/a-take/score.ts': 'a-film/rounds/01/a-take/score.ts',
    });
  });

  it("bundles a piece while a sibling's module does not parse", async () => {
    writePackage();
    write('b-film/film.ts', 'export const where = ;\n');

    const { errors } = await bundleWith(pieceWebpackOverride('a-film'));

    expect(errors).toEqual([]);
  });

  it.each([
    ['Studio', filmsWebpackOverride],
    ['a piece', pieceWebpackOverride('a-film')],
  ])("lists only the registry's own directory for %s's bundle", async (_, override) => {
    writePackage();

    const { listed } = await bundleWith(override);

    expect(listed.filter((directory) => directory.startsWith(root))).toEqual([
      path.join(root, 'src'),
    ]);
  });

  it.each([
    ['Studio', filmsWebpackOverride],
    ['a piece', pieceWebpackOverride('a-film')],
  ])("leaves node_modules out of %s's bundle's context dependencies", async (_, override) => {
    writePackage();

    const { contextDependencies } = await bundleWith(override);

    expect(contextDependencies).toEqual([path.join(root, 'src')]);
  });

  it('leaves a module context elsewhere under the package walking its own directory', async () => {
    writePackage();
    write(
      'src/index.js',
      "const modules = require.context('../b-film', false, /\\.ts$/);\nmodule.exports = modules.keys();\n"
    );

    const { exports } = await bundleWith(filmsWebpackOverride);

    expect(exports).toEqual(['./film.ts']);
  });

  it('records the directories a module context walks when no map replaces it', async () => {
    writePackage();
    write(
      'src/index.js',
      "const modules = require.context('..', true, /film\\.ts$/);\nmodule.exports = modules.keys();\n"
    );

    const { listed } = await bundleWith((config) => config);

    expect(listed).toContain(path.join(root, 'node_modules'));
  });
});

/**
 * A package whose stylesheet compiles through Tailwind with its scan rooted at the
 * package, holding render products under a film's `out/`, the bundle's own `out/`
 * and `public/`, as a films package holds them.
 */
function writeStyledPackage(): void {
  write('.gitignore', 'out/\npublic/\n');
  write('src/index.js', "require('./style.css');\nmodule.exports = 'styled';\n");
  write('src/style.css', "@tailwind utilities source('..');\n");
  write('a-film/film.ts', "export const where = 'a-film';\n");
  write('a-film/look.ts', "export const surface = 'isolate';\n");
  write('a-film/rounds/01/a-take/look.ts', "export const ink = 'tabular-nums';\n");
  writeModule('a-film/rounds/01/a-take/score.ts');
  write('a-film/out/stills/0.png', 'still');
  write('a-film/out/run-1/frames/0.png', 'frame');
  write('b-film/film.ts', "export const where = 'b-film';\n");
  write('public/a-film/master.wav', 'master');
}

/** The render products a bundle of the styled package must not read. */
function renderOutput(): string[] {
  return [path.join(root, 'out'), path.join(root, 'a-film', 'out'), path.join(root, 'public')];
}

/** Whether `directory` is a render product's directory, lies under one, or holds one. */
function touchesRenderOutput(directory: string): boolean {
  return renderOutput().some(
    (output) =>
      directory === output ||
      directory.startsWith(output + path.sep) ||
      output.startsWith(directory + path.sep)
  );
}

describe("the Tailwind scan a bundle's stylesheet runs", () => {
  it.each([
    ['Studio', filmsWebpackOverride],
    ['a piece', pieceWebpackOverride('a-film')],
  ])(
    "reads no directory under an out/ or public/ directory in %s's bundle",
    async (_, override) => {
      writeStyledPackage();

      const { listed, errors } = await bundleWith(override);

      expect(errors).toEqual([]);
      expect(listed.filter((directory) => touchesRenderOutput(directory))).toEqual([]);
    }
  );

  it.each([
    ['Studio', filmsWebpackOverride],
    ['a piece', pieceWebpackOverride('a-film')],
  ])(
    "leaves no context dependency that is or holds render output in %s's bundle",
    async (_, override) => {
      writeStyledPackage();

      const { contextDependencies } = await bundleWith(override);

      expect(contextDependencies.filter((directory) => touchesRenderOutput(directory))).toEqual([]);
    }
  );

  it('keeps a context dependency on each scanned directory that holds no render output', async () => {
    writeStyledPackage();

    const { contextDependencies } = await bundleWith(filmsWebpackOverride);

    expect(contextDependencies).toEqual(
      expect.arrayContaining([
        path.join(root, 'b-film'),
        path.join(root, 'src'),
        path.join(root, 'a-film', 'rounds'),
      ])
    );
  });

  it('generates the utilities the modules beside render output name', async () => {
    writeStyledPackage();

    const { bundled } = await bundleWith(filmsWebpackOverride);

    expect(bundled()).toMatch(/\.isolate\b/);
  });

  it('generates the utilities a module nested under a split directory names', async () => {
    writeStyledPackage();

    const { bundled } = await bundleWith(filmsWebpackOverride);

    expect(bundled()).toMatch(/\.tabular-nums\b/);
  });
});

/** The films package, where the Remotion CLI finds `remotion.config.ts`. */
const FILMS_PACKAGE = path.resolve(import.meta.dirname, '..', '..');

describe("webpack's persistent cache", () => {
  it.each([
    ['Studio', filmsWebpackOverride],
    ['a piece', pieceWebpackOverride('a-film')],
  ])(
    "writes no cache file for %s's bundle when the bundler asks for the filesystem cache",
    async (_, override) => {
      writePackage();
      const cacheDirectory = path.join(root, 'cache');

      await bundleWith(override, {
        type: 'filesystem',
        name: 'remotion-production-films',
        version: 'films',
        cacheDirectory,
      });

      expect(existsSync(cacheDirectory)).toBe(false);
    }
  );
});

describe('the override as the Remotion CLI loads it', () => {
  it('compiles with remotion.config.ts to CommonJS with no warning', async () => {
    const result = await BundlerInternals.esbuild.build({
      platform: 'node',
      target: 'node16',
      bundle: true,
      entryPoints: [path.join(FILMS_PACKAGE, 'remotion.config.ts')],
      tsconfig: path.join(FILMS_PACKAGE, 'tsconfig.json'),
      absWorkingDir: FILMS_PACKAGE,
      outfile: 'bundle.js',
      write: false,
      packages: 'external',
      logLevel: 'silent',
    });

    expect(result.warnings.map(({ text }) => text)).toEqual([]);
  });
});
