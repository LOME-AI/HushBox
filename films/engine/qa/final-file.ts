import { measureLoudness } from '../analyze/index.js';
import { LEAD_FRAMES, LEAD_SAMPLES } from '../render/delivery-timing.js';
import { FPS, HEIGHT, SAMPLE_RATE, WIDTH } from '../time/grid.js';

import { sameBytes } from './bytes.js';
import { colourCheck } from './colour.js';
import { chartColourCheck } from './colour-chart.js';
import { gateResult } from './gate.js';
import { signalLag } from './lag.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { ColourScore } from './colour.js';
import type { GateFailure, GateResult } from './gate.js';
import type { Mp4Track } from './mp4-boxes.js';

/** Samples in each AAC access unit, the duration of every audio sample but the last. */
const AAC_FRAME = 1024;
const LOUDNESS_TOLERANCE_LU = 0.5;
const COLOUR_TAG = 'bt709';

/** What the final-file rules read of the delivered MP4. */
export interface FinalFileEvidence {
  durationInFrames: number;
  /** The master as muxed. */
  master: StereoBuffer;
  /** The video stream as ffprobe reports it, and the frames decoding it gives. */
  stream: {
    width: number;
    height: number;
    pixFmt: string;
    colorPrimaries: string;
    colorTransfer: string;
    colorSpace: string;
    colorRange: string;
    decodedFrames: number;
  };
  tracks: readonly Mp4Track[];
  /** The audio decoded with edit lists honoured and with them ignored. */
  audio: { honoured: StereoBuffer; ignored: StereoBuffer };
  /** Each picture's presentation time, in the video timescale, both ways. */
  picturePts: { honoured: readonly number[]; ignored: readonly number[]; timescale: number };
  /** The first audio sample's presentation time, in samples. */
  audioStartTicks: number;
  /** Each percussive placement on a cue: the cue, its frame, and the master sample it lands on. */
  onsets: readonly { cueId: string; frame: number; sample: number }[];
  /** Each probe frame's block-mean colour score against its still. */
  colour: readonly ColourScore[];
  /** The colour chart's block-mean PSNR against itself through the delivery's encode and the decode as tagged. */
  chartPsnr: number;
}

type Fail = (rule: string, at: string, detail: string) => GateFailure;

function channelBytes(channel: Float32Array): Uint8Array {
  return new Uint8Array(channel.buffer, channel.byteOffset, channel.byteLength);
}

/** Whether two decodes hold the same samples, bit for bit. */
function samePcm(a: StereoBuffer, b: StereoBuffer): boolean {
  return (
    sameBytes(channelBytes(a.left), channelBytes(b.left)) &&
    sameBytes(channelBytes(a.right), channelBytes(b.right))
  );
}

function streamFailures(
  { stream, durationInFrames }: FinalFileEvidence,
  fail: Fail
): GateFailure[] {
  const failures: GateFailure[] = [];
  const delivered = durationInFrames + LEAD_FRAMES;
  if (stream.decodedFrames !== delivered) {
    failures.push(
      fail(
        'frame-count',
        'video',
        `${String(stream.decodedFrames)} decoded frames, not the spec's ${String(durationInFrames)} plus the ${String(LEAD_FRAMES)}-frame lead`
      )
    );
  }
  if (stream.width !== WIDTH || stream.height !== HEIGHT) {
    failures.push(
      fail(
        'dimensions',
        'video',
        `${String(stream.width)}×${String(stream.height)}, not ${String(WIDTH)}×${String(HEIGHT)}`
      )
    );
  }
  if (stream.pixFmt !== 'yuv420p') {
    failures.push(fail('pixel-format', 'video', `${stream.pixFmt}, not yuv420p`));
  }
  const tags = [
    ['color_primaries', stream.colorPrimaries, COLOUR_TAG],
    ['color_transfer', stream.colorTransfer, COLOUR_TAG],
    ['color_space', stream.colorSpace, COLOUR_TAG],
    ['color_range', stream.colorRange, 'tv'],
  ] as const;
  for (const [tag, value, expected] of tags) {
    if (value !== expected) {
      failures.push(fail('colour-tags', 'video', `${tag} is ${value}, not ${expected}`));
    }
  }
  return failures;
}

/** Each sample's duration from a run-length `stts` table, with its index. */
function samples(track: Mp4Track): { index: number; delta: number }[] {
  let index = 0;
  return track.sampleDurations.flatMap(({ count, delta }) =>
    Array.from({ length: count }, () => ({ index: index++, delta }))
  );
}

function videoTrackFailures(track: Mp4Track, delivered: number, fail: Fail): GateFailure[] {
  const at = `track ${String(track.trackId)}`;
  const period = track.timescale / FPS;
  const failures: GateFailure[] = [];
  if (track.duration * FPS !== delivered * track.timescale) {
    failures.push(
      fail(
        'duration',
        at,
        `the container says ${String(track.duration)} ticks of 1/${String(track.timescale)} s, not ${String(delivered)} frames`
      )
    );
  }
  const odd = samples(track).find(({ delta }) => delta !== period);
  if (odd !== undefined) {
    failures.push(
      fail(
        'sample-durations',
        at,
        `sample ${String(odd.index)} lasts ${String(odd.delta)} ticks, not one frame period of ${String(period)}`
      )
    );
  }
  return failures;
}

function audioTrackFailures(track: Mp4Track, audioSamples: number, fail: Fail): GateFailure[] {
  const at = `track ${String(track.trackId)}`;
  const failures: GateFailure[] = [];
  if (track.duration * SAMPLE_RATE !== audioSamples * track.timescale) {
    failures.push(
      fail(
        'duration',
        at,
        `the container says ${String(track.duration)} ticks of 1/${String(track.timescale)} s, not ${String(audioSamples)} samples`
      )
    );
  }
  const all = samples(track);
  const odd = all
    .slice(0, -1)
    .find(({ delta }) => delta * SAMPLE_RATE !== AAC_FRAME * track.timescale);
  if (odd !== undefined) {
    failures.push(
      fail(
        'sample-durations',
        at,
        `sample ${String(odd.index)} lasts ${String(odd.delta)} samples, not ${String(AAC_FRAME)}`
      )
    );
  }
  return failures;
}

function trackFailures(evidence: FinalFileEvidence, fail: Fail): GateFailure[] {
  const failures: GateFailure[] = [];
  for (const handler of ['vide', 'soun']) {
    if (!evidence.tracks.some((track) => track.handler === handler)) {
      failures.push(fail('tracks', 'file', `the MP4 has no ${handler} track`));
    }
  }
  for (const track of evidence.tracks) {
    if (track.hasEditList) {
      failures.push(
        fail(
          'edit-list',
          `track ${String(track.trackId)}`,
          `the ${track.handler} track carries an edts box`
        )
      );
    }
    if (track.handler === 'vide') {
      failures.push(...videoTrackFailures(track, evidence.durationInFrames + LEAD_FRAMES, fail));
    } else if (track.handler === 'soun') {
      failures.push(...audioTrackFailures(track, evidence.master.left.length + LEAD_SAMPLES, fail));
    }
  }
  return failures;
}

function decodeFailures({ audio, picturePts }: FinalFileEvidence, fail: Fail): GateFailure[] {
  const failures: GateFailure[] = [];
  if (!samePcm(audio.honoured, audio.ignored)) {
    failures.push(
      fail(
        'edit-list',
        'audio',
        'the decode with edit lists ignored gives different PCM from the decode honouring them'
      )
    );
  }
  const { honoured, ignored } = picturePts;
  if (honoured.length !== ignored.length || honoured.some((pts, index) => pts !== ignored[index])) {
    failures.push(
      fail(
        'edit-list',
        'video',
        'the picture timestamps with edit lists ignored differ from those honouring them'
      )
    );
  }
  return failures;
}

/** The delivered frame on screen at an audio sample: the latest picture presented at or before it. */
function frameAt(evidence: FinalFileEvidence, audioTicks: number): number {
  const { honoured, timescale } = evidence.picturePts;
  let shown = -1;
  for (const [index, pts] of honoured.entries()) {
    if (pts * SAMPLE_RATE <= audioTicks * timescale) {
      shown = index;
    }
  }
  return shown;
}

function syncFailures(
  evidence: FinalFileEvidence,
  fail: Fail
): { failures: GateFailure[]; lag: number } {
  const lag = signalLag(evidence.audio.honoured, evidence.master);
  const failures: GateFailure[] = [];
  if (lag !== LEAD_SAMPLES) {
    failures.push(
      fail(
        'lag',
        'audio',
        `the delivered audio lags the master by ${String(lag)} samples, not the lead's ${String(LEAD_SAMPLES)}`
      )
    );
  }
  for (const { cueId, frame, sample } of evidence.onsets) {
    const shown = frameAt(evidence, evidence.audioStartTicks + sample + lag);
    const expected = frame + LEAD_FRAMES;
    if (shown !== expected) {
      failures.push(
        fail(
          'onset-frame',
          `cue ${JSON.stringify(cueId)}`,
          `the onset presents at delivered frame ${String(shown)}, not ${String(expected)}, where its frame is shown`
        )
      );
    }
  }
  return { failures, lag };
}

/**
 * The delivered-loudness rule: the delivered audio's integrated loudness within
 * 0.5 LU of the master's. A loudness that is not a number fails.
 */
export function deliveredLoudnessFailure(
  filmId: string,
  deliveredLufs: number,
  masterLufs: number
): GateFailure | null {
  return Math.abs(deliveredLufs - masterLufs) <= LOUDNESS_TOLERANCE_LU
    ? null
    : {
        filmId,
        rule: 'delivered-loudness',
        at: 'audio',
        detail: `${deliveredLufs.toFixed(2)} LUFS against the master's ${masterLufs.toFixed(2)} LUFS, more than ${String(LOUDNESS_TOLERANCE_LU)} LU apart`,
      };
}

function loudnessFailures(
  filmId: string,
  evidence: FinalFileEvidence
): { failures: GateFailure[]; measured: string } {
  const delivered = measureLoudness(evidence.audio.honoured).integratedLufs;
  const master = measureLoudness(evidence.master).integratedLufs;
  return {
    failures: [deliveredLoudnessFailure(filmId, delivered, master) ?? []].flat(),
    measured: `delivered ${delivered.toFixed(2)} LUFS against the master's ${master.toFixed(2)} LUFS`,
  };
}

/**
 * The delivered MP4: its frame count, size, pixel format and BT.709 tags; its
 * container durations; no edit list on any track, and the same decode whether
 * or not a reader honours edit lists; every sample one frame period, or one AAC
 * frame; the audio late by exactly the lead, so each percussive onset on a cue
 * presents with its own frame; its loudness within 0.5 LU of the master's; its
 * colour against the stills; and its matrix, read on the colour chart, which no
 * film's frames can hide.
 */
export function finalFileGate(filmId: string, evidence: FinalFileEvidence): GateResult {
  const fail: Fail = (rule, at, detail) => ({ filmId, rule, at, detail });
  const sync = syncFailures(evidence, fail);
  const loudness = loudnessFailures(filmId, evidence);
  const colour = colourCheck(filmId, evidence.colour);
  const chart = chartColourCheck(filmId, evidence.chartPsnr);
  return gateResult(
    'final-file',
    [
      ...streamFailures(evidence, fail),
      ...trackFailures(evidence, fail),
      ...decodeFailures(evidence, fail),
      ...sync.failures,
      ...loudness.failures,
      ...colour.failures,
      ...chart.failures,
    ],
    [
      `${String(evidence.stream.decodedFrames)} delivered frames (${String(evidence.durationInFrames)} plus a ${String(LEAD_FRAMES)}-frame lead), ${String(evidence.stream.width)}×${String(evidence.stream.height)} ${evidence.stream.pixFmt}`,
      `whole-signal lag ${String(sync.lag)} samples; ${String(evidence.onsets.length)} onsets matched to their frames by presentation time`,
      loudness.measured,
      ...colour.measured,
      ...chart.measured,
    ]
  );
}
