import { describe, expect, it } from 'vitest';

import { definition } from './film.js';

const { spec } = definition;

function rowsWith(ids: readonly string[]): typeof spec.text {
  return spec.text.filter((row) => ids.includes(row.id));
}

describe('All But One', () => {
  it('names itself after its directory', () => {
    expect(spec.id).toBe('2026-09-all-but-one');
  });

  it('keys its score’s samples with the seed the approved take was rendered with', () => {
    expect(spec.seed).toBe('all-but-one/interview-cut');
  });

  it('runs 40 s at 32 frames a beat', () => {
    expect(spec.durationInFrames).toBe(2400);
    expect(spec.grid.framesPerBeat).toBe(32);
  });

  it('tiles the film with its shots from the first frame to the last', () => {
    const shots = spec.shots.toSorted((a, b) => a.from - b.from);
    expect(shots[0]?.from).toBe(0);
    expect(shots.at(-1)?.to).toBe(spec.durationInFrames);
    for (const [index, shot] of shots.slice(1).entries()) {
      expect(shot.from).toBe(shots[index]?.to);
    }
  });

  it('carries a score', () => {
    expect(definition.score?.tracks.length).toBeGreaterThan(0);
  });

  it('cites a source in the code for each HushBox claim', () => {
    const claims = rowsWith(['v1a', 'v1b', 'v2a', 'v2b', 'v3a', 'v3b']);
    expect(claims).toHaveLength(6);
    for (const row of claims) {
      expect(row.basis?.kind).toBe('fact');
    }
  });

  it('holds each line about AI companies as opinion', () => {
    const lines = rowsWith(['a1', 'a2', 'a3', 'a4a', 'a4b', 'a5', 'a6']);
    expect(lines).toHaveLength(7);
    for (const row of lines) {
      expect(row.basis).toEqual({ kind: 'opinion' });
    }
  });

  it('sets the wordmark and the tagline as brand lines', () => {
    const brand = rowsWith(['wordmark', 'tag-1', 'tag-2', 'tag-3']);
    expect(brand.map((row) => row.words)).toEqual([
      'HushBox',
      'One interface.',
      'Every feature.',
      'Private.',
    ]);
    for (const row of brand) {
      expect(row.basis?.kind).toBe('brand');
    }
  });

  it('sets the interviewer’s questions and the turn as brand lines', () => {
    const story = rowsWith(['q1', 'q2', 'q3', 'a7']);
    expect(story).toHaveLength(4);
    for (const row of story) {
      expect(row.basis?.kind).toBe('brand');
    }
  });
});
