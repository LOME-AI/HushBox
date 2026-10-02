import { describe, expect, it } from 'vitest';

import { LEAD_FRAMES, LEAD_SAMPLES } from '../render/delivery-timing.js';
import { FPS, HEIGHT, SAMPLE_RATE, SAMPLES_PER_FRAME, WIDTH } from '../time/grid.js';
import { colourScore } from './colour.js';
import { deliveredLoudnessFailure, finalFileGate } from './final-file.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { FinalFileEvidence } from './final-file.js';
import type { Mp4Track } from './mp4-boxes.js';

const FRAMES = 60;
const DELIVERED = FRAMES + LEAD_FRAMES;
const MASTER_SAMPLES = FRAMES * SAMPLES_PER_FRAME;
const VIDEO_TIMESCALE = 15_360;
const TICKS_PER_FRAME = VIDEO_TIMESCALE / FPS;
const AUDIO_SAMPLES = MASTER_SAMPLES + LEAD_SAMPLES;
const AAC_FRAME = 1024;

/** Seeded pseudo-noise at a level near −14 LUFS. */
function noise(length: number, seed: number): Float32Array {
  let state = seed;
  return Float32Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (state / 1_073_741_824 - 1) * 0.3;
  });
}

const MASTER: StereoBuffer = { left: noise(MASTER_SAMPLES, 1), right: noise(MASTER_SAMPLES, 2) };

function delayed(buffer: StereoBuffer, lag: number): StereoBuffer {
  const shift = (channel: Float32Array): Float32Array => {
    const out = new Float32Array(channel.length + lag);
    out.set(channel, lag);
    return out;
  };
  return { left: shift(buffer.left), right: shift(buffer.right) };
}

const DECODED = delayed(MASTER, LEAD_SAMPLES);
const PTS = Array.from({ length: DELIVERED }, (_, frame) => frame * TICKS_PER_FRAME);
const AUDIO_PACKETS = Math.ceil(AUDIO_SAMPLES / AAC_FRAME);
const VIDEO_TRACK: Mp4Track = {
  trackId: 1,
  handler: 'vide',
  timescale: VIDEO_TIMESCALE,
  duration: DELIVERED * TICKS_PER_FRAME,
  hasEditList: false,
  sampleDurations: [{ count: DELIVERED, delta: TICKS_PER_FRAME }],
};
const AUDIO_TRACK: Mp4Track = {
  trackId: 2,
  handler: 'soun',
  timescale: SAMPLE_RATE,
  duration: AUDIO_SAMPLES,
  hasEditList: false,
  sampleDurations: [
    { count: AUDIO_PACKETS - 1, delta: AAC_FRAME },
    { count: 1, delta: AUDIO_SAMPLES - (AUDIO_PACKETS - 1) * AAC_FRAME },
  ],
};
const GREY = {
  width: 16,
  height: 16,
  channels: 3 as const,
  data: new Uint8Array(16 * 16 * 3).fill(90),
};

function evidence(overrides: Partial<FinalFileEvidence> = {}): FinalFileEvidence {
  return {
    durationInFrames: FRAMES,
    master: MASTER,
    stream: {
      width: WIDTH,
      height: HEIGHT,
      pixFmt: 'yuv420p',
      colorPrimaries: 'bt709',
      colorTransfer: 'bt709',
      colorSpace: 'bt709',
      colorRange: 'tv',
      decodedFrames: DELIVERED,
    },
    tracks: [VIDEO_TRACK, AUDIO_TRACK],
    audio: { honoured: DECODED, ignored: DECODED },
    picturePts: { honoured: PTS, ignored: PTS, timescale: VIDEO_TIMESCALE },
    audioStartTicks: 0,
    onsets: [{ cueId: 'beat', frame: 30, sample: 30 * SAMPLES_PER_FRAME }],
    colour: [colourScore({ frame: 30, decoded: GREY, still: GREY })],
    chartPsnr: 50,
    ...overrides,
  };
}

function lines(overrides: Partial<FinalFileEvidence>): string[] {
  return finalFileGate('film', evidence(overrides)).failures;
}

/** The delivered audio scaled by `db`. */
function louder(db: number): FinalFileEvidence['audio'] {
  const gain = 10 ** (db / 20);
  const scaled = {
    left: DECODED.left.map((sample) => sample * gain),
    right: DECODED.right.map((sample) => sample * gain),
  };
  return { honoured: scaled, ignored: scaled };
}

/**
 * The gain that puts the delivered loudness `lu` from the master's: the lead's
 * silence moves the gating blocks, so the unscaled delivery already reads a
 * little apart, and the bound is set from that reading.
 */
function apart(lu: number): number {
  const reading = finalFileGate('film', evidence()).measured[2] ?? '';
  const [delivered, master] = [...reading.matchAll(/(-?\d+\.\d+) LUFS/g)].map(([, value]) =>
    Number(value)
  );
  return lu - ((delivered ?? 0) - (master ?? 0));
}

describe('finalFileGate', () => {
  it('passes a delivery that keeps every rule', () => {
    expect(finalFileGate('film', evidence()).failures).toEqual([]);
  });

  it('fails a decoded frame count other than the spec plus the lead', () => {
    const stream = { ...evidence().stream, decodedFrames: DELIVERED - 1 };

    expect(lines({ stream })).toEqual([
      `film: frame-count: video: ${String(DELIVERED - 1)} decoded frames, not the spec's ${String(FRAMES)} plus the ${String(LEAD_FRAMES)}-frame lead`,
    ]);
  });

  it('fails dimensions other than 1080×1920', () => {
    const stream = { ...evidence().stream, width: 1920, height: 1080 };

    expect(lines({ stream })).toEqual(['film: dimensions: video: 1920×1080, not 1080×1920']);
  });

  it('fails a pixel format other than yuv420p', () => {
    const stream = { ...evidence().stream, pixFmt: 'yuv444p' };

    expect(lines({ stream })).toEqual(['film: pixel-format: video: yuv444p, not yuv420p']);
  });

  it('fails a colour tag other than BT.709, naming the tag', () => {
    const stream = { ...evidence().stream, colorTransfer: 'unknown' };

    expect(lines({ stream })).toEqual([
      'film: colour-tags: video: color_transfer is unknown, not bt709',
    ]);
  });

  it('fails a range other than limited', () => {
    const stream = { ...evidence().stream, colorRange: 'pc' };

    expect(lines({ stream })).toEqual(['film: colour-tags: video: color_range is pc, not tv']);
  });

  it('fails a video track whose container duration is off by one tick', () => {
    const tracks = [{ ...VIDEO_TRACK, duration: DELIVERED * TICKS_PER_FRAME + 1 }, AUDIO_TRACK];

    expect(lines({ tracks })).toEqual([
      `film: duration: track 1: the container says ${String(DELIVERED * TICKS_PER_FRAME + 1)} ticks of 1/${String(VIDEO_TIMESCALE)} s, not ${String(DELIVERED)} frames`,
    ]);
  });

  it('fails an audio track whose container duration is not the master plus the lead', () => {
    const tracks = [VIDEO_TRACK, { ...AUDIO_TRACK, duration: AUDIO_SAMPLES + 256 }];

    expect(lines({ tracks })[0]).toContain(`not ${String(AUDIO_SAMPLES)} samples`);
  });

  it('fails a track that carries an edit list, naming the track', () => {
    const tracks = [{ ...VIDEO_TRACK, hasEditList: true }, AUDIO_TRACK];

    expect(lines({ tracks })).toEqual([
      'film: edit-list: track 1: the vide track carries an edts box',
    ]);
  });

  it('fails decodes whose PCM differs with edit lists honoured and ignored', () => {
    const shifted = { left: Float32Array.from(DECODED.left), right: DECODED.right };
    shifted.left[LEAD_SAMPLES] = (shifted.left[LEAD_SAMPLES] ?? 0) + 2 ** -23;
    const audio = { honoured: DECODED, ignored: shifted };

    expect(lines({ audio })).toContain(
      'film: edit-list: audio: the decode with edit lists ignored gives different PCM from the decode honouring them'
    );
  });

  it('fails picture timestamps that differ with edit lists honoured and ignored', () => {
    const ignored = PTS.map((pts) => pts + 2 * TICKS_PER_FRAME);
    const picturePts = { honoured: PTS, ignored, timescale: VIDEO_TIMESCALE };

    expect(lines({ picturePts })).toEqual([
      'film: edit-list: video: the picture timestamps with edit lists ignored differ from those honouring them',
    ]);
  });

  it('fails a video sample lasting other than one frame period, naming it', () => {
    const sampleDurations = [
      { count: 1, delta: 584 },
      { count: DELIVERED - 1, delta: TICKS_PER_FRAME },
    ];
    const tracks = [{ ...VIDEO_TRACK, sampleDurations }, AUDIO_TRACK];

    expect(lines({ tracks })).toContain(
      `film: sample-durations: track 1: sample 0 lasts 584 ticks, not one frame period of ${String(TICKS_PER_FRAME)}`
    );
  });

  it('fails an audio sample other than the last lasting other than 1024 samples', () => {
    const sampleDurations = [
      { count: 1, delta: 1600 },
      { count: AUDIO_PACKETS - 2, delta: AAC_FRAME },
      { count: 1, delta: AUDIO_SAMPLES - 1600 - (AUDIO_PACKETS - 2) * AAC_FRAME },
    ];
    const tracks = [VIDEO_TRACK, { ...AUDIO_TRACK, sampleDurations }];

    expect(lines({ tracks })).toContain(
      'film: sample-durations: track 2: sample 0 lasts 1600 samples, not 1024'
    );
  });

  it('fails a whole-signal lag other than the lead, naming both', () => {
    const late = delayed(MASTER, LEAD_SAMPLES + 1);
    const audio = { honoured: late, ignored: late };

    expect(lines({ audio })).toContain(
      `film: lag: audio: the delivered audio lags the master by ${String(LEAD_SAMPLES + 1)} samples, not the lead's ${String(LEAD_SAMPLES)}`
    );
  });

  it('fails an onset whose presentation time selects a frame other than its own, naming the cue', () => {
    const late = delayed(MASTER, LEAD_SAMPLES + 2048);
    const audio = { honoured: late, ignored: late };

    expect(lines({ audio })).toContain(
      `film: onset-frame: cue "beat": the onset presents at delivered frame ${String(30 + LEAD_FRAMES + 2)}, not ${String(30 + LEAD_FRAMES)}, where its frame is shown`
    );
  });

  it('selects the frame by the picture timestamps, not by the frame index', () => {
    const shifted = PTS.map((pts) => pts + TICKS_PER_FRAME);
    const picturePts = { honoured: shifted, ignored: shifted, timescale: VIDEO_TIMESCALE };

    expect(lines({ picturePts })[0]).toContain('onset-frame');
  });

  it('fails delivered loudness more than 0.5 LU from the master', () => {
    const quiet = {
      left: DECODED.left.map((sample) => sample / 2),
      right: DECODED.right.map((sample) => sample / 2),
    };
    const audio = { honoured: quiet, ignored: quiet };

    expect(lines({ audio })[0]).toMatch(
      /^film: delivered-loudness: audio: -\d+\.\d\d LUFS against the master's -\d+\.\d\d LUFS, more than 0\.5 LU apart$/
    );
  });

  it.each([-0.49, 0.49])('accepts delivered loudness %s LU from the master', (db) => {
    expect(lines({ audio: louder(apart(db)) })).toEqual([]);
  });

  it.each([-0.51, 0.51])('refuses delivered loudness %s LU from the master', (db) => {
    expect(lines({ audio: louder(apart(db)) })[0]).toMatch(/^film: delivered-loudness: /);
  });

  it('fails a delivered loudness that is not a number, naming the film and the rule', () => {
    expect(deliveredLoudnessFailure('film', Number.NaN, -14)).toEqual({
      filmId: 'film',
      rule: 'delivered-loudness',
      at: 'audio',
      detail: "NaN LUFS against the master's -14.00 LUFS, more than 0.5 LU apart",
    });
  });

  it('fails the colour check', () => {
    const tinted = { ...GREY, data: new Uint8Array(16 * 16 * 3).fill(120) };

    expect(
      lines({ colour: [colourScore({ frame: 30, decoded: tinted, still: GREY })] })[0]
    ).toMatch(/^film: colour: frame 30: /);
  });

  it('fails a colour chart below the floor, naming the matrix', () => {
    expect(lines({ chartPsnr: 27 })).toEqual([
      expect.stringMatching(/^film: colour-matrix: colour chart: .*the BT\.709 its tags declare$/),
    ]);
  });

  it('reports the colour chart score', () => {
    expect(finalFileGate('film', evidence()).measured).toContain(
      'colour chart block-mean PSNR 50.0 dB through the delivery encode and the decode as tagged (floor 44 dB)'
    );
  });

  it('fails a delivery with no audio track', () => {
    expect(lines({ tracks: [VIDEO_TRACK] })).toContain(
      'film: tracks: file: the MP4 has no soun track'
    );
  });
});
