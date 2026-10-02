import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { defineFilm } from '../../film/spec.js';
import { frameToSample } from '../../time/grid.js';

import { defineScore } from './define-score.js';
import { FIXTURE_GRID, FIXTURE_SCORE } from './score-test-support.js';
import { scoreTimeline } from './timeline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FILM = defineFilm({
  id: 'score-timeline',
  title: 'Score timeline',
  seed: 'score-timeline',
  grid: FIXTURE_GRID,
  beats: 8,
  shots: [{ id: 'all', fromBeat: 0, toBeat: 8, reads: [] }],
  text: [],
  cues: [{ id: 'drop', beat: 4, kind: 'impact', anchor: 'start' }],
});

/**
 * The ways a source loads a relative module at run time: a static import or
 * re-export that is not type-only (a type-only one leaves nothing at run time),
 * a side-effect import, and a dynamic import.
 */
const RELATIVE_LOADS = [
  /^(?:import|export)(?!\s+type\b)[^'"]*?\bfrom\s+['"](?<specifier>\.[^'"]+)['"]/gmu,
  /^import\s+['"](?<specifier>\.[^'"]+)['"]/gmu,
  /\bimport\s*\(\s*['"](?<specifier>\.[^'"]+)['"]/gu,
];

/** A Node built-in named anywhere in a source, however it is loaded. */
const NODE_SPECIFIER = /(?<quote>['"`])(?<specifier>node:[^'"`]*)\k<quote>/gu;

/** Every module a module loads at run time, itself included, with its source. */
function runtimeGraph(entry: string): Map<string, string> {
  const graph = new Map<string, string>();
  const pending = [entry];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (graph.has(file)) {
      continue;
    }
    const source = readFileSync(file, 'utf8');
    graph.set(file, source);
    for (const { groups } of RELATIVE_LOADS.flatMap((load) => [...source.matchAll(load)])) {
      const specifier = groups?.['specifier'] ?? '';
      pending.push(path.resolve(path.dirname(file), specifier.replace(/\.js$/u, '.ts')));
    }
  }
  return graph;
}

/** Each Node built-in the graph names, as `module: specifier`. */
function nodeBuiltins(graph: Map<string, string>): string[] {
  return [...graph].flatMap(([file, source]) =>
    [...source.matchAll(NODE_SPECIFIER)].map(
      ({ groups }) => `${path.relative(HERE, file)}: ${String(groups?.['specifier'])}`
    )
  );
}

describe('scoreTimeline', () => {
  it('returns the pattern-expanded frames of a track exactly', () => {
    expect(scoreTimeline(FIXTURE_SCORE)['kick']).toEqual([0, 24, 48, 72, 96, 120, 144, 168]);
  });

  it('holds one list per track, keyed by track id', () => {
    expect(Object.keys(scoreTimeline(FIXTURE_SCORE))).toEqual(
      FIXTURE_SCORE.tracks.map(({ id }) => id)
    );
  });

  it('sorts a track’s frames whatever order its events are declared in', () => {
    const score = defineScore(
      {
        tracks: [
          {
            id: 'hits',
            instrument: 'tom',
            bus: 'main',
            gainDb: 0,
            events: [{ at: { frame: 100 } }, { at: { cue: 'drop' } }, { at: { beat: 1 } }],
          },
        ],
        buses: [{ id: 'main', role: 'music', effects: [] }],
      },
      FILM
    );
    expect(scoreTimeline(score)['hits']).toEqual([24, 96, 100]);
  });

  it('places a sub-frame event on the frame on screen when it sounds', () => {
    // A sixteenth of a beat at 24 frames per beat is a frame and a half.
    const beat = 1 / 16;
    expect(frameToSample(FIXTURE_GRID.framesPerBeat * beat)).toBe(frameToSample(1) * 1.5);
    const score = defineScore(
      {
        tracks: [
          { id: 'tick', instrument: 'hat', bus: 'main', gainDb: 0, events: [{ at: { beat } }] },
        ],
        buses: [{ id: 'main', role: 'sfx', effects: [] }],
      },
      FILM
    );
    expect(scoreTimeline(score)['tick']).toEqual([1]);
  });

  it('places an event anchored at its end on the frame its anchor lands on', () => {
    const score = defineScore(
      {
        tracks: [
          {
            id: 'swell',
            instrument: 'pad',
            bus: 'main',
            gainDb: 0,
            events: [{ at: { cue: 'drop' }, anchor: 'end', params: { beats: 1 } }],
          },
        ],
        buses: [{ id: 'main', role: 'music', effects: [] }],
      },
      FILM
    );
    expect(scoreTimeline(score)['swell']).toEqual([96]);
  });

  it('loads no Node built-in, directly or through anything it imports, so a picture can read it', () => {
    expect(nodeBuiltins(runtimeGraph(path.resolve(HERE, 'timeline.ts')))).toEqual([]);
  });

  it('loads no Node built-in through defineScore either, the one way a picture gets a score', () => {
    const graph = runtimeGraph(path.resolve(HERE, 'define-score.ts'));
    expect(graph.size).toBeGreaterThan(10);
    expect(nodeBuiltins(graph)).toEqual([]);
  });
});
