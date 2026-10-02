import { describe, expect, it } from 'vitest';

import { createFrameSplitter, cueOnsets, parsePts, parseStreamProbe } from './evidence.js';

describe('parseStreamProbe', () => {
  const json = JSON.stringify({
    streams: [
      {
        width: 1080,
        height: 1920,
        pix_fmt: 'yuv420p',
        color_range: 'tv',
        color_space: 'bt709',
        color_transfer: 'bt709',
        color_primaries: 'bt709',
      },
    ],
  });

  it('reads the video stream fields', () => {
    expect(parseStreamProbe(json)).toEqual({
      width: 1080,
      height: 1920,
      pixFmt: 'yuv420p',
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv',
    });
  });

  it('reads an absent colour tag as unknown', () => {
    const untagged = JSON.stringify({ streams: [{ width: 1, height: 1, pix_fmt: 'yuv420p' }] });

    expect(parseStreamProbe(untagged).colorTransfer).toBe('unknown');
  });

  it('refuses output with no video stream', () => {
    expect(() => parseStreamProbe('{"streams":[]}')).toThrow(/no video stream/);
  });
});

describe('parsePts', () => {
  it('reads one timestamp per line, sorted into presentation order', () => {
    expect(parsePts('512\n0\n256\n')).toEqual([0, 256, 512]);
  });

  it('reads the first field of a line that carries more, as a packet with side data prints', () => {
    expect(parsePts('-1024,\n0,\n')).toEqual([-1024, 0]);
  });

  it('refuses a line that is not a whole timestamp', () => {
    expect(() => parsePts('0\nN/A\n')).toThrow(/"N\/A"/);
  });
});

describe('createFrameSplitter', () => {
  it('cuts a stream into frames of the given size across chunk boundaries', () => {
    const splitter = createFrameSplitter(3);

    const frames = [
      ...splitter.push(Uint8Array.of(1, 2)),
      ...splitter.push(Uint8Array.of(3, 4, 5, 6, 7)),
    ];

    expect(frames.map((frame) => [...frame])).toEqual([
      [1, 2, 3],
      [4, 5, 6],
    ]);
  });

  it('holds the bytes of an unfinished frame', () => {
    const splitter = createFrameSplitter(3);
    splitter.push(Uint8Array.of(1, 2, 3, 4));

    expect(splitter.pending()).toBe(1);
  });
});

describe('cueOnsets', () => {
  const cues = [
    { id: 'a', from: 10 },
    { id: 'b', from: 20 },
  ];

  it('lists each percussive placement on a cue with its frame and sample', () => {
    const placements = [{ track: 'click', cueId: 'a', sample: 8000 }];

    expect(cueOnsets(placements, cues, new Set(['click']))).toEqual([
      { cueId: 'a', frame: 10, sample: 8000 },
    ]);
  });

  it('leaves out placements of tracks that are not percussive', () => {
    const placements = [{ track: 'pad', cueId: 'a', sample: 8000 }];

    expect(cueOnsets(placements, cues, new Set(['click']))).toEqual([]);
  });

  it('leaves out placements on no cue', () => {
    const placements = [{ track: 'click', cueId: null, sample: 8000 }];

    expect(cueOnsets(placements, cues, new Set(['click']))).toEqual([]);
  });

  it('leaves out placements whose cue lies past the last frame', () => {
    const placements = [{ track: 'click', cueId: 'b', sample: 16_000 }];

    expect(cueOnsets(placements, cues, new Set(['click']), 20)).toEqual([]);
  });
});
