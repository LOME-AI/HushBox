import { useState } from 'react';
import { AbsoluteFill, Composition } from 'remotion';
import { z } from 'zod';

import {
  classifyLooks,
  registerFilms,
  registerTakes,
  takeCompositionId,
} from '../engine/film/discover.js';
import { fontFamilies, lookModuleOf } from '../engine/look/index.js';
import { masterAudioPath } from '../engine/render/master-audio.js';
import { FPS, HEIGHT, WIDTH } from '../engine/time/grid.js';

import { lookComposition } from './look-composition.js';

import type { ComponentType } from 'react';
import type { FilmModule } from '../engine/film/discover.js';
import type { LookFilm, LookFonts } from './look-composition.js';

type FilmComponent = ComponentType<Record<string, unknown>>;

interface FilmComposition {
  id: string;
  durationInFrames: number;
  component: (props: Record<string, unknown>) => React.JSX.Element;
}

/** Modules found under the package, keyed `./<dir>/<file>`, each loaded only when asked for. */
export interface PackageModules {
  keys: readonly string[];
  load: (key: string) => unknown;
}

/** A film's registered module and how its composition draws it. */
type DrawnFilm = FilmModule & { draw: (id: string) => FilmComposition['component'] };

const componentSchema = z.object({
  Component: z.custom<FilmComponent>((value) => typeof value === 'function'),
});

/** What the look host reads of a film's or take's definition beside what registration checks. */
const lookDefinitionSchema = z.object({
  definition: z.object({ spec: z.object({ seed: z.string() }), score: z.unknown().optional() }),
});

const MODULE_KEY = /^\.\/(.+)\/([^/]+)$/;

/**
 * Every module of the pieces this bundle registers, keyed `./<dir>/<file>`
 * under the package. The bundle's webpack override hands this context its
 * modules as an explicit map of the pieces discovery lists: every piece in
 * Studio's bundle, one piece in a render's. Opened on this directory alone,
 * with a pattern matching nothing, it lists no piece and walks no directory
 * when that map is missing.
 */
function packageModules(): PackageModules {
  // eslint-disable-next-line unicorn/prefer-module -- require.context is webpack's compile-time module discovery, not a CommonJS import; it is how Studio finds films with no hand-kept list.
  const modules = require.context('.', false, /^$/);
  return {
    keys: modules.keys(),
    load: (key): unknown => {
      const loaded: unknown = modules(key);
      return loaded;
    },
  };
}

/**
 * The open-licence fonts under `fonts/<family>/`: each face's file. The CLI's
 * film discovery checks each family's licence on disk, so no licence file
 * enters the bundle.
 */
function openFonts(): LookFonts {
  // eslint-disable-next-line unicorn/prefer-module -- require.context is webpack's compile-time module discovery; it lists the font files with no hand-kept list.
  const fonts = require.context('../fonts', true, /\.(?:woff2?|otf|ttf)$/i);
  const prefix = './';
  const families = fontFamilies(fonts.keys().map((key) => key.slice(prefix.length)));
  return { families, urlOf: (file) => String(fonts(`${prefix}${file}`)) };
}

/**
 * A film's component inside a full-frame box that clips to the frame. Content
 * moved past the frame's right or bottom edge would otherwise grow the page's
 * scrollable size, and Chrome rasterizes a page that grew differently from one
 * first painted at the larger size, so a frame's pixels would depend on the
 * frames its tab rendered before it.
 */
function clippedToFrame(Component: FilmComponent): FilmComposition['component'] {
  return function ClippedToFrame(props) {
    return (
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <Component {...props} />
      </AbsoluteFill>
    );
  };
}

function directoriesHolding(
  entries: readonly { dir: string; file: string }[],
  file: RegExp
): string[] {
  return entries.filter((entry) => file.test(entry.file)).map(({ dir }) => dir);
}

/** The look film a look module and its definition's module make, read and checked. */
function lookFilm(
  modules: PackageModules,
  { dir, lookKey, definitionKey }: { dir: string; lookKey: string; definitionKey: string },
  fonts: LookFonts,
  /** The master's path under the public directory, played in preview when the definition has a score. */
  master: string | null
): LookFilm {
  const parsed = lookDefinitionSchema.safeParse(modules.load(definitionKey));
  if (!parsed.success) {
    throw new Error(`${dir}: the definition beside a look module must carry a spec with a seed`);
  }
  return {
    where: dir,
    seed: parsed.data.definition.spec.seed,
    look: lookModuleOf(dir, modules.load(lookKey)),
    audio: parsed.data.definition.score === undefined ? null : master,
    fonts,
  };
}

/**
 * Every film, engine fixture and take under the package as a composition: a
 * film drawn by its own `composition.tsx`, or a film or take drawn by a look
 * module through the one look composition, each clipped to the frame. Film
 * ids are checked unique across both kinds; a take registers under its path.
 */
export function filmCompositions(modules: PackageModules, fonts: LookFonts): FilmComposition[] {
  const entries = modules.keys.flatMap((key) => {
    const match = MODULE_KEY.exec(key);
    return match?.[1] === undefined || match[2] === undefined
      ? []
      : [{ key, dir: match[1], file: match[2] }];
  });
  const plan = classifyLooks({
    looks: entries
      .filter(({ file }) => /^look\.[jt]s$/.test(file))
      .map(({ dir, file }) => `${dir}/${file}`),
    films: directoriesHolding(entries, /^film\.ts$/),
    scores: directoriesHolding(entries, /^score\.ts$/),
    compositions: directoriesHolding(entries, /^composition\.tsx$/),
  });
  const keyOf = (dir: string, file: RegExp): string => {
    const entry = entries.find((candidate) => candidate.dir === dir && file.test(candidate.file));
    if (entry === undefined) {
      throw new Error(`${dir}: no module matches ${String(file)}`);
    }
    return entry.key;
  };

  const films = [
    ...entries
      .filter(({ file }) => file === 'composition.tsx')
      .map(({ key, dir }): DrawnFilm => {
        const exports = modules.load(key);
        return {
          dir,
          exports,
          draw: () => {
            const parsed = componentSchema.safeParse(exports);
            if (!parsed.success) {
              throw new Error(`${dir}: composition.tsx must export a Component`);
            }
            return clippedToFrame(parsed.data.Component);
          },
        };
      }),
    ...plan.films.map((dir): DrawnFilm => {
      const definitionKey = keyOf(dir, /^film\.ts$/);
      const lookKey = keyOf(dir, /^look\.[jt]s$/);
      return {
        dir,
        exports: modules.load(definitionKey),
        draw: (id) =>
          clippedToFrame(
            lookComposition(
              lookFilm(modules, { dir, lookKey, definitionKey }, fonts, masterAudioPath(id))
            )
          ),
      };
    }),
  ];
  const registeredFilms = registerFilms(films).map(({ id, dir, durationInFrames }, index) => {
    const film = films[index];
    if (film === undefined) {
      throw new Error(`${dir}: registered without a module`);
    }
    return { id, durationInFrames, component: film.draw(id) };
  });

  const takes = registerTakes(
    plan.takes.map((dir): FilmModule => ({ dir, exports: modules.load(keyOf(dir, /^score\.ts$/)) }))
  ).map(({ id, dir, durationInFrames }) => ({
    id: takeCompositionId(id),
    durationInFrames,
    component: clippedToFrame(
      lookComposition(
        lookFilm(
          modules,
          { dir, lookKey: keyOf(dir, /^look\.[jt]s$/), definitionKey: keyOf(dir, /^score\.ts$/) },
          fonts,
          null
        )
      )
    ),
  }));
  return [...registeredFilms, ...takes];
}

/** One `<Composition>` per film, engine fixture and take discovered under the package. */
export function Root(): React.JSX.Element {
  const [films] = useState(() => filmCompositions(packageModules(), openFonts()));
  return (
    <>
      {films.map(({ id, durationInFrames, component }) => (
        <Composition
          key={id}
          id={id}
          component={component}
          durationInFrames={durationInFrames}
          fps={FPS}
          width={WIDTH}
          height={HEIGHT}
        />
      ))}
    </>
  );
}
