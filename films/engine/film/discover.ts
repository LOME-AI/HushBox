import { z } from 'zod';

import { readFontFamilies } from '../look/fonts.js';

export interface DiscoveredFilm {
  id: string;
  dir: string;
}

export interface RegisteredFilm extends DiscoveredFilm {
  durationInFrames: number;
}

/** A loaded module and the POSIX-separated directory holding it. */
export interface FilmModule {
  dir: string;
  exports: unknown;
}

/** A loaded film module crosses an untyped boundary (a require or a bundler context), so it is parsed. */
const filmModuleSchema = z.object({
  definition: z.object({
    spec: z.object({ id: z.string(), durationInFrames: z.int().positive() }),
  }),
});

const EXCLUDED_DIRECTORIES = ['**/node_modules', '**/out'];

/** Where the open-licence font families sit under the package root, each beside its licence. */
const FONTS_DIRECTORY = 'fonts';

const KEBAB_SEGMENT = String.raw`[a-z0-9]+(?:-[a-z0-9]+)*`;

/** `<film>/rounds/<NN>/<take>`: a two-digit round and every other segment kebab-case. */
const TAKE_DIRECTORY = new RegExp(
  String.raw`^(?:${KEBAB_SEGMENT}/)+rounds/\d{2}/${KEBAB_SEGMENT}$`
);

const LOOK_MODULE = /\/look\.[jt]s$/;

/**
 * Refuses a film id two directories share, naming both. A film's id is its
 * directory's name, so Studio's registry and the CLI's discovery both refuse a
 * duplicate here.
 */
function refuseSharedIds(films: readonly DiscoveredFilm[]): void {
  const dirById = new Map<string, string>();
  for (const { id, dir } of films) {
    const holder = dirById.get(id);
    if (holder !== undefined) {
      throw new Error(`${dir}: film id "${id}" is already used by ${holder}`);
    }
    dirById.set(id, dir);
  }
}

/**
 * Checks each loaded film module against the directory holding it: the spec's
 * id must equal the directory's name and be unique. `dir` is POSIX-separated
 * and names the directory in every failure.
 */
export function registerFilms(modules: readonly FilmModule[]): RegisteredFilm[] {
  const films = modules.map(({ dir, exports }) => {
    const parsed = filmModuleSchema.safeParse(exports);
    if (!parsed.success) {
      throw new Error(
        `${dir}: the film module must export a definition whose spec has a string id and a positive integer durationInFrames\n${z.prettifyError(parsed.error)}`
      );
    }
    const { id, durationInFrames } = parsed.data.definition.spec;
    const name = dir.split('/').at(-1);
    if (id !== name) {
      throw new Error(`${dir}: spec id "${id}" differs from its directory name "${String(name)}"`);
    }
    return { id, dir, durationInFrames };
  });
  refuseSharedIds(films);
  return films;
}

/**
 * A take's id, its path under the package, spelled as a composition id, which
 * admits no `/`: each separator becomes `--`. Every segment of a take path is
 * kebab-case, so no segment holds `--` and the spelling reads back to one path.
 */
export function takeCompositionId(takeId: string): string {
  return takeId.replaceAll('/', '--');
}

/** The directories holding each kind of module, as discovery finds them; `looks` names each look module's file. */
export interface LookDirectories {
  looks: readonly string[];
  films: readonly string[];
  scores: readonly string[];
  compositions: readonly string[];
}

/** The directories whose look module draws a film, and those whose look module draws a take. */
export interface LookPlan {
  films: string[];
  takes: string[];
}

/**
 * Sorts every look module into a film (beside its `film.ts`) or a take (in a
 * take directory, beside its `score.ts`), refusing, by directory, a look module
 * that is neither, a directory with two look modules, and a film drawn by both
 * a look module and a `composition.tsx`.
 */
export function classifyLooks({ looks, films, scores, compositions }: LookDirectories): LookPlan {
  const plan: LookPlan = { films: [], takes: [] };
  const seen = new Set<string>();
  for (const file of looks) {
    const dir = file.replace(LOOK_MODULE, '');
    if (seen.has(dir)) {
      throw new Error(
        `${dir}: a directory holds one look module, and this one holds look.ts and look.js`
      );
    }
    seen.add(dir);
    if (compositions.includes(dir)) {
      throw new Error(`${dir}: a film draws through composition.tsx or a look module, never both`);
    }
    if (films.includes(dir)) {
      plan.films.push(dir);
    } else if (TAKE_DIRECTORY.test(dir) && scores.includes(dir)) {
      plan.takes.push(dir);
    } else {
      throw new Error(
        `${dir}: a look module sits beside film.ts, or beside score.ts in a take directory <film>/rounds/<NN>/<take> whose segments are kebab-case and whose round is two digits`
      );
    }
  }
  return plan;
}

/**
 * Checks each loaded take `score.ts` module against its directory, which must
 * be a take directory; a take's id is that directory, its path under the package.
 */
export function registerTakes(modules: readonly FilmModule[]): RegisteredFilm[] {
  return modules.map(({ dir, exports }) => {
    if (!TAKE_DIRECTORY.test(dir)) {
      throw new Error(`${dir}: a take sits in a take directory, <film>/rounds/<NN>/<take>`);
    }
    const parsed = filmModuleSchema.safeParse(exports);
    if (!parsed.success) {
      throw new Error(
        `${dir}: the take's score.ts must export a definition whose spec has a positive integer durationInFrames\n${z.prettifyError(parsed.error)}`
      );
    }
    return { id: dir, dir, durationInFrames: parsed.data.definition.spec.durationInFrames };
  });
}

/** What a discovery over a tree on disk reads it with. */
interface TreeReader {
  /** POSIX-separated paths under the root matching the pattern, outside `node_modules/` and `out/`. */
  find: (pattern: string) => string[];
  /** A POSIX-separated path under the root as an absolute path. */
  absolute: (relative: string) => string;
}

/**
 * The reader discovery walks `root` with, once the font families under
 * `root/fonts/` have each been found beside their licence file: every CLI verb
 * discovers first, so an unlicensed family is refused by name before a bundle.
 * It reads paths only and imports no module, so a piece that fails to load
 * fails only a verb on that piece.
 */
function treeReader(root: string): TreeReader {
  // Loaded at call time, never imported: the Studio bundle imports this module
  // for `registerFilms`, and webpack refuses a static `node:` import.
  const { globSync } = process.getBuiltinModule('node:fs');
  const path = process.getBuiltinModule('node:path');
  readFontFamilies(path.join(root, FONTS_DIRECTORY));
  return {
    find: (pattern) =>
      globSync(pattern, { cwd: root, exclude: EXCLUDED_DIRECTORIES })
        .map((file) => file.split(path.sep).join('/'))
        .toSorted((a, b) => a.localeCompare(b)),
    absolute: (relative) => path.join(root, ...relative.split('/')),
  };
}

function directoryOf(file: string): string {
  return file.slice(0, file.lastIndexOf('/'));
}

/**
 * Every take under `root` (outside `node_modules/` and `out/`), by path, with its
 * absolute directory, found by path alone; fails first naming any font family
 * under `root/fonts/` that holds no licence file, then naming any look module
 * that sits in neither a film nor a take directory.
 */
export function discoverTakes(root: string): DiscoveredFilm[] {
  const { find, absolute } = treeReader(root);
  const directories = (pattern: string): string[] => find(pattern).map((file) => directoryOf(file));
  const { takes } = classifyLooks({
    looks: find('**/look.{ts,js}'),
    films: directories('**/film.ts'),
    scores: directories('**/score.ts'),
    compositions: directories('**/composition.tsx'),
  });
  return takes
    .toSorted((a, b) => a.localeCompare(b))
    .map((dir) => ({ id: dir, dir: absolute(dir) }));
}

/**
 * Every film under `root` (outside `node_modules/` and `out/`), with its absolute
 * directory, found by path alone: a film's id is its directory's name, which
 * its spec must repeat when the film loads. Fails first naming any font family
 * under `root/fonts/` that holds no licence file, so every CLI verb refuses one
 * before it bundles, then naming both directories of an id used twice.
 */
export function discoverFilms(root: string): DiscoveredFilm[] {
  const { find, absolute } = treeReader(root);
  const films = find('**/film.ts')
    .map((file) => directoryOf(file))
    .toSorted((a, b) => a.localeCompare(b))
    .map((dir) => ({ id: dir.slice(dir.lastIndexOf('/') + 1), dir }));
  refuseSharedIds(films);
  return films.map(({ id, dir }) => ({ id, dir: absolute(dir) }));
}

/**
 * The exports of one module of a discovered piece, `file` in its directory,
 * the only module of the tree a verb imports. A module that throws while it
 * loads fails naming its path under `root`, with what it threw as the cause.
 */
export function loadPieceModule(root: string, piece: DiscoveredFilm, file: string): unknown {
  const path = process.getBuiltinModule('node:path');
  // Built from the piece's own path, never `import.meta`: the Remotion CLI compiles
  // this module to CommonJS through the bundle override, where `import.meta` is empty.
  const require = process.getBuiltinModule('node:module').createRequire(path.join(piece.dir, file));
  const where = path.relative(root, path.join(piece.dir, file)).split(path.sep).join('/');
  try {
    const loaded: unknown = require(path.join(piece.dir, file));
    return loaded;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${where}: the module did not load: ${message}`, { cause: error });
  }
}
