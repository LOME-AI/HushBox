import { describe, expect, it } from 'vitest';

import { boxHeader, mp4Tracks } from './mp4-boxes.js';

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function u64(value: number): number[] {
  return [...u32(Math.floor(value / 2 ** 32)), ...u32(value % 2 ** 32)];
}

function ascii(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

function box(type: string, ...payload: number[][]): number[] {
  const body = payload.flat();
  return [...u32(8 + body.length), ...ascii(type), ...body];
}

function fullBox(type: string, version: number, ...payload: number[][]): number[] {
  return box(type, [version, 0, 0, 0], ...payload);
}

function mdhd(version: 0 | 1, timescale: number, duration: number): number[] {
  return version === 0
    ? fullBox('mdhd', 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0))
    : fullBox('mdhd', 1, u64(0), u64(0), u32(timescale), u64(duration), u32(0));
}

function trak(options: {
  id: number;
  handler: string;
  timescale: number;
  duration: number;
  stts: [number, number][];
  editList?: boolean;
  version?: 0 | 1;
}): number[] {
  const tkhd = fullBox('tkhd', 0, u32(0), u32(0), u32(options.id), u32(0), u32(0));
  const hdlr = fullBox('hdlr', 0, u32(0), ascii(options.handler), u32(0), u32(0), u32(0), [0]);
  const stts = fullBox(
    'stts',
    0,
    u32(options.stts.length),
    ...options.stts.map(([count, delta]) => [...u32(count), ...u32(delta)])
  );
  const stbl = box('stbl', stts);
  const minf = box('minf', box('vmhd', [0, 0, 0, 0]), stbl);
  const mdia = box(
    'mdia',
    mdhd(options.version ?? 0, options.timescale, options.duration),
    hdlr,
    minf
  );
  const edts = options.editList === true ? [box('edts', fullBox('elst', 0, u32(0)))] : [];
  return box('trak', tkhd, ...edts, mdia);
}

const VIDEO = trak({
  id: 1,
  handler: 'vide',
  timescale: 15_360,
  duration: 98_816,
  stts: [[386, 256]],
});
const AUDIO = trak({
  id: 2,
  handler: 'soun',
  timescale: 48_000,
  duration: 308_800,
  stts: [
    [301, 1024],
    [1, 576],
  ],
});

function moov(...traks: number[][]): Uint8Array {
  return Uint8Array.from(box('moov', fullBox('mvhd', 0, u32(0)), ...traks));
}

describe('boxHeader', () => {
  it('reads a box size and type', () => {
    expect(boxHeader(Uint8Array.from(box('free', [1, 2, 3])), 0)).toEqual({
      size: 11,
      type: 'free',
      headerSize: 8,
    });
  });

  it('reads a 64-bit size', () => {
    const large = Uint8Array.from([...u32(1), ...ascii('mdat'), ...u64(2 ** 33)]);

    expect(boxHeader(large, 0)).toEqual({ size: 2 ** 33, type: 'mdat', headerSize: 16 });
  });

  it('reads a size of 0 as running to the end of the bytes', () => {
    const open = Uint8Array.from([...u32(0), ...ascii('mdat'), 1, 2, 3, 4]);

    expect(boxHeader(open, 0).size).toBe(12);
  });

  it('refuses a header cut short', () => {
    expect(() => boxHeader(Uint8Array.of(0, 0, 0), 0)).toThrow(/box header/);
  });
});

describe('mp4Tracks', () => {
  it('reads each track handler', () => {
    expect(mp4Tracks(moov(VIDEO, AUDIO)).map(({ handler }) => handler)).toEqual(['vide', 'soun']);
  });

  it('reads the track id', () => {
    expect(mp4Tracks(moov(VIDEO, AUDIO)).map(({ trackId }) => trackId)).toEqual([1, 2]);
  });

  it('reads the media timescale and duration', () => {
    expect(mp4Tracks(moov(AUDIO))[0]).toMatchObject({ timescale: 48_000, duration: 308_800 });
  });

  it('reads a version 1 media header', () => {
    const wide = trak({
      id: 3,
      handler: 'vide',
      timescale: 600,
      duration: 2 ** 33,
      stts: [],
      version: 1,
    });

    expect(mp4Tracks(moov(wide))[0]).toMatchObject({ timescale: 600, duration: 2 ** 33 });
  });

  it('reads the sample durations', () => {
    expect(mp4Tracks(moov(AUDIO))[0]?.sampleDurations).toEqual([
      { count: 301, delta: 1024 },
      { count: 1, delta: 576 },
    ]);
  });

  it('finds no edit list on a track without one', () => {
    expect(mp4Tracks(moov(VIDEO))[0]?.hasEditList).toBe(false);
  });

  it('finds an edit list on a track that carries one', () => {
    const edited = trak({
      id: 1,
      handler: 'vide',
      timescale: 15_360,
      duration: 1,
      stts: [],
      editList: true,
    });

    expect(mp4Tracks(moov(edited))[0]?.hasEditList).toBe(true);
  });

  it('reads the track id of a version 1 track header', () => {
    const tkhd = fullBox('tkhd', 1, u64(0), u64(0), u32(7), u32(0), u64(0));
    const hdlr = fullBox('hdlr', 0, u32(0), ascii('soun'), u32(0), u32(0), u32(0), [0]);
    const wide = box('trak', tkhd, box('mdia', mdhd(0, 48_000, 0), hdlr));

    expect(mp4Tracks(moov(wide))[0]?.trackId).toBe(7);
  });

  it('reads a track with no track header as track 0', () => {
    const hdlr = fullBox('hdlr', 0, u32(0), ascii('vide'), u32(0), u32(0), u32(0), [0]);
    const bare = box('trak', box('mdia', mdhd(0, 600, 0), hdlr));

    expect(mp4Tracks(moov(bare))[0]?.trackId).toBe(0);
  });

  it('reads a track with no sample table as having no sample durations', () => {
    const hdlr = fullBox('hdlr', 0, u32(0), ascii('vide'), u32(0), u32(0), u32(0), [0]);
    const tableless = box('trak', box('mdia', mdhd(0, 600, 0), hdlr));

    expect(mp4Tracks(moov(tableless))[0]?.sampleDurations).toEqual([]);
  });

  it('refuses bytes that are not a moov box', () => {
    expect(() => mp4Tracks(Uint8Array.from(box('free', [])))).toThrow(/moov/);
  });

  it('refuses a track with no media header', () => {
    const bare = box('trak', fullBox('tkhd', 0, u32(0), u32(0), u32(9), u32(0), u32(0)));

    expect(() => mp4Tracks(moov(bare))).toThrow(/track 9 .*mdhd/);
  });
});
