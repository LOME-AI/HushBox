import { describe, expect, it } from 'vitest';

import { LEAD_FRAMES, LEAD_SAMPLES } from '../render/delivery-timing.js';
import { FPS, HEIGHT, SAMPLE_RATE, SAMPLES_PER_FRAME, WIDTH } from '../time/grid.js';
import { GATE_ORDER, allGates } from './gates.js';
import { judgeProbe } from './stills-match.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { GateInputs } from './gates.js';

const FRAMES = FPS;
const MASTER_SAMPLES = FRAMES * SAMPLES_PER_FRAME;
const VIDEO_TIMESCALE = 15_360;
const TICKS = VIDEO_TIMESCALE / FPS;
const DELIVERED = FRAMES + LEAD_FRAMES;

function noise(length: number, seed: number): Float32Array {
  let state = seed;
  return Float32Array.from({ length }, () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return (state / 1_073_741_824 - 1) * 0.2;
  });
}

const MASTER: StereoBuffer = { left: noise(MASTER_SAMPLES, 3), right: noise(MASTER_SAMPLES, 4) };
/** A 1 kHz sine at −14 dBFS peak in both channels: −14 LUFS, the target the audio gate holds. */
const TONE = Float32Array.from(
  { length: MASTER_SAMPLES },
  (_, sample) => 10 ** (-14 / 20) * Math.sin((2 * Math.PI * 1000 * sample) / SAMPLE_RATE)
);

/** The channel late by the delivery's lead. */
function late(channel: Float32Array): Float32Array {
  const out = new Float32Array(channel.length + LEAD_SAMPLES);
  out.set(channel, LEAD_SAMPLES);
  return out;
}

const DECODED: StereoBuffer = { left: late(MASTER.left), right: late(MASTER.right) };
const PLANE = Uint8Array.from({ length: 16 }, (_, index) => index * 10);
const NEXT = Uint8Array.from({ length: 16 }, (_, index) => index * 10 + 5);
const PNG = Uint8Array.of(1, 2, 3);
const AUDIO_SAMPLES = MASTER_SAMPLES + LEAD_SAMPLES;
const PACKETS = Math.ceil(AUDIO_SAMPLES / 1024);

/** Inputs every gate passes on. */
function inputs(): GateInputs {
  return {
    purity: [
      { frame: 0, master: { bytes: PNG, raster: null }, still: { bytes: PNG, raster: null } },
    ],
    claims: { rows: [], frames: new Map() },
    contrast: [],
    containment: [],
    logo: [],
    frames: {
      spec: { durationInFrames: FRAMES, shots: [{ from: 0, to: FRAMES }], cues: [], silences: [] },
      probes: [0],
      stats: new Map([[0, { mean: 60, deviation: 20 }]]),
      identicalRuns: [],
    },
    transitions: [],
    judged: [
      judgeProbe({
        frame: 0,
        decoded: PLANE,
        references: new Map([
          [0, PLANE],
          [1, NEXT],
        ]),
      }),
    ],
    audio: {
      cues: [],
      silences: [],
      master: { left: TONE, right: TONE },
      placements: [],
      percussive: [],
    },
    finalFile: {
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
      tracks: [
        {
          trackId: 1,
          handler: 'vide',
          timescale: VIDEO_TIMESCALE,
          duration: DELIVERED * TICKS,
          hasEditList: false,
          sampleDurations: [{ count: DELIVERED, delta: TICKS }],
        },
        {
          trackId: 2,
          handler: 'soun',
          timescale: SAMPLE_RATE,
          duration: AUDIO_SAMPLES,
          hasEditList: false,
          sampleDurations: [
            { count: PACKETS - 1, delta: 1024 },
            { count: 1, delta: AUDIO_SAMPLES - (PACKETS - 1) * 1024 },
          ],
        },
      ],
      audio: { honoured: DECODED, ignored: DECODED },
      picturePts: {
        honoured: Array.from({ length: DELIVERED }, (_, frame) => frame * TICKS),
        ignored: Array.from({ length: DELIVERED }, (_, frame) => frame * TICKS),
        timescale: VIDEO_TIMESCALE,
      },
      audioStartTicks: 0,
      onsets: [],
      colour: [],
      chartPsnr: 50,
    },
  };
}

describe('allGates', () => {
  it('runs every gate, in the report order', () => {
    expect(allGates('film', inputs()).map(({ gate }) => gate)).toEqual([...GATE_ORDER]);
  });

  it('orders the gates purity, claims, contrast, containment, logo, frames, flashes, stills-match, audio, final-file', () => {
    expect(GATE_ORDER).toEqual([
      'purity',
      'claims',
      'contrast',
      'containment',
      'logo',
      'frames',
      'flashes',
      'stills-match',
      'audio',
      'final-file',
    ]);
  });

  it('keeps a failing input in its own gate', () => {
    const failing = { ...inputs(), contrast: [[{ frame: 0, id: 'line', ratio: 1 }]] };
    const results = allGates('film', failing);

    expect(results.filter(({ passed }) => !passed).map(({ gate }) => gate)).toEqual(['contrast']);
  });

  it('keeps a failing claim in the claims gate', () => {
    const failing = {
      ...inputs(),
      claims: {
        rows: [{ id: 'line', role: 'headline' as const, from: 0, to: 1 }],
        frames: new Map(),
      },
    };
    const results = allGates('film', failing);

    expect(results.filter(({ passed }) => !passed).map(({ gate }) => gate)).toEqual(['claims']);
  });

  it('keeps text outside its box in the containment gate', () => {
    const failing = {
      ...inputs(),
      containment: [
        {
          frame: 0,
          boxes: 1,
          differing: 2,
          strays: 1,
          strayLargest: 255,
          strayBounds: { x: 0, y: 0, width: 1, height: 1 },
          empty: [],
        },
      ],
    };
    const results = allGates('film', failing);

    expect(results.filter(({ passed }) => !passed).map(({ gate }) => gate)).toEqual([
      'containment',
    ]);
  });

  it('keeps a resting mark that misses the logo in the logo gate', () => {
    const failing: GateInputs = {
      ...inputs(),
      logo: [
        {
          frame: 0,
          id: 'mark',
          iou: 0.9,
          outside: null,
          grid: { width: 480, height: 483, across: 'file', down: 'file' },
          proportion: 0,
          colour: [236, 71, 85],
          surroundings: [26, 24, 22],
          deltaE: 0,
          contrast: 4.2,
        },
      ],
    };
    const results = allGates('film', failing);

    expect(results.filter(({ passed }) => !passed).map(({ gate }) => gate)).toEqual(['logo']);
  });
});
