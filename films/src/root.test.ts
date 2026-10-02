import { AbsoluteFill } from 'remotion';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { filmCompositions } from './root.js';

import type { PackageModules } from './root.js';

function First(): null {
  return null;
}

function Second(): null {
  return null;
}

/** Modules keyed as the bundler context keys them. */
function packageOf(modules: Readonly<Record<string, unknown>>): PackageModules {
  return { keys: Object.keys(modules), load: (key) => modules[key] };
}

const NO_FONTS = { families: [], urlOf: (file: string): string => file };

const MODULES = packageOf({
  './engine/fixtures/first/composition.tsx': {
    definition: { spec: { id: 'first', durationInFrames: 12 } },
    Component: First,
  },
  './a-film/second/composition.tsx': {
    definition: { spec: { id: 'second', durationInFrames: 24 } },
    Component: Second,
  },
});

function renderFrame(): [] {
  return [];
}

const LOOK = { context: '2d', renderFrame };

/** What a composition's component renders: one box, holding the film's component. */
const boxSchema = z.object({
  type: z.unknown(),
  props: z.object({
    style: z.object({ overflow: z.string() }),
    children: z.object({ type: z.unknown(), props: z.record(z.string(), z.unknown()) }),
  }),
});

function rendered(
  props: Record<string, unknown>
): { id: string; box: z.infer<typeof boxSchema> }[] {
  return filmCompositions(MODULES, NO_FONTS).map(({ id, component: Clipped }) => ({
    id,
    box: boxSchema.parse(Clipped(props)),
  }));
}

describe('filmCompositions', () => {
  it('registers one composition per film module, with its id and length', () => {
    expect(
      filmCompositions(MODULES, NO_FONTS).map(({ id, durationInFrames }) => ({
        id,
        durationInFrames,
      }))
    ).toEqual([
      { id: 'first', durationInFrames: 12 },
      { id: 'second', durationInFrames: 24 },
    ]);
  });

  it('wraps every registered composition in a full-frame box that clips to the frame', () => {
    const compositions = rendered({});

    expect(compositions).toHaveLength(MODULES.keys.length);
    for (const { box } of compositions) {
      expect(box.type).toBe(AbsoluteFill);
      expect(box.props.style.overflow).toBe('hidden');
    }
  });

  it("renders each film's own component inside its clip box", () => {
    expect(rendered({}).map(({ box }) => box.props.children.type)).toEqual([First, Second]);
  });

  it("passes the composition's input props to the film's component", () => {
    for (const { box } of rendered({ stallAt: 7 })) {
      expect(box.props.children.props).toEqual({ stallAt: 7 });
    }
  });

  it('refuses a composition module that exports no component, naming its directory', () => {
    const bare = packageOf({
      './engine/fixtures/bare/composition.tsx': {
        definition: { spec: { id: 'bare', durationInFrames: 12 } },
      },
    });

    expect(() => filmCompositions(bare, NO_FONTS)).toThrow(
      'engine/fixtures/bare: composition.tsx must export a Component'
    );
  });

  it("registers a film drawn by a look module under its spec's id and length", () => {
    const modules = packageOf({
      './a-film/film.ts': {
        definition: { spec: { id: 'a-film', seed: 's', durationInFrames: 36 } },
      },
      './a-film/look.ts': LOOK,
      './a-film/score.ts': {},
    });

    expect(
      filmCompositions(modules, NO_FONTS).map(({ id, durationInFrames }) => ({
        id,
        durationInFrames,
      }))
    ).toEqual([{ id: 'a-film', durationInFrames: 36 }]);
  });

  it('registers a take drawn by a look module under its path, spelled as a composition id', () => {
    const modules = packageOf({
      './a-film/rounds/01/ember/look.js': LOOK,
      './a-film/rounds/01/ember/score.ts': {
        definition: { spec: { id: 'ember', seed: 's', durationInFrames: 48 } },
      },
    });

    expect(
      filmCompositions(modules, NO_FONTS).map(({ id, durationInFrames }) => ({
        id,
        durationInFrames,
      }))
    ).toEqual([{ id: 'a-film--rounds--01--ember', durationInFrames: 48 }]);
  });

  it('refuses a film id used by both a composition and a look film, naming the directory', () => {
    const modules = packageOf({
      './one/same/composition.tsx': {
        definition: { spec: { id: 'same', durationInFrames: 12 } },
        Component: First,
      },
      './two/same/film.ts': {
        definition: { spec: { id: 'same', seed: 's', durationInFrames: 12 } },
      },
      './two/same/look.ts': LOOK,
    });

    expect(() => filmCompositions(modules, NO_FONTS)).toThrow(
      /two\/same: film id "same" is already used by one\/same/
    );
  });

  it('refuses a look module that breaks the contract, naming its directory', () => {
    const modules = packageOf({
      './a-film/film.ts': {
        definition: { spec: { id: 'a-film', seed: 's', durationInFrames: 36 } },
      },
      './a-film/look.ts': { context: '2d' },
    });

    expect(() => filmCompositions(modules, NO_FONTS)).toThrow(/a-film: .*renderFrame/);
  });

  it('refuses a definition beside a look module that carries no seed, naming the directory', () => {
    const modules = packageOf({
      './a-film/film.ts': { definition: { spec: { id: 'a-film', durationInFrames: 36 } } },
      './a-film/look.ts': LOOK,
    });

    expect(() => filmCompositions(modules, NO_FONTS)).toThrow(/a-film: .*seed/);
  });
});
