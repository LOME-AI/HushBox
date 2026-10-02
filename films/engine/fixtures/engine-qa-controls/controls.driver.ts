import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { RenderInternals } from '@remotion/renderer';

import { INSTRUMENTS } from '../../audio/instruments/index.js';
import { wavHeader } from '../../audio/dsp/wav.js';
import { DEFAULT_GL } from '../../cli/command.js';
import { exitWhenWritten } from '../../cli/run.js';
import { PAD_SAMPLES } from '../../render/delivery-timing.js';
import { loadFilm, masterWavFile } from '../../render/films.driver.js';
import { renderFilmVideo } from '../../render/render-film.driver.js';
import { publishFile, withRunDirectory } from '../../render/run-directory.js';
import { finalFileGate } from '../../qa/final-file.js';
import { stillsMatchGate } from '../../qa/stills-match.js';
import {
  inspectDelivery,
  inspectPlanes,
  renderEvidence,
  runGates,
  verifyFilm,
} from '../../qa/verify.driver.js';

import type { StereoBuffer } from '../../audio/dsp/index.js';
import type { GateResult } from '../../qa/gate.js';
import type { RenderedEvidence } from '../../qa/verify.driver.js';

// The render-level controls no film can carry in its own source: a video offset
// from its master, a master padded before the mux, a stem shifted after the
// render, and re-muxes of the delivered video that bring back what the delivery
// forbids. Each prints the gate it targets, red, beside that gate green on the
// unaltered fixture. Run with `node --import tsx` from the repository root.

const FILM = 'engine-render';
/** How far the padded-master control moves the audio: Remotion's own AAC offset. */
const MASTER_PAD = 2048;

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/** Prints a gate's verdict and failure lines under a label; true when the gate failed. */
function show(label: string, result: GateResult | undefined): boolean {
  if (result === undefined) {
    print(`${label}: no such gate`);
    return false;
  }
  print(`${label}: ${result.gate} ${result.passed ? 'pass' : 'FAIL'}`);
  for (const line of result.failures) {
    print(`  ${line}`);
  }
  return !result.passed;
}

function gate(results: readonly GateResult[], name: string): GateResult | undefined {
  return results.find((result) => result.gate === name);
}

function shifted(stem: StereoBuffer, by: number): StereoBuffer {
  const move = (channel: Float32Array): Float32Array => {
    const out = new Float32Array(channel.length);
    out.set(channel.subarray(0, channel.length - by), by);
    return out;
  };
  return { left: move(stem.left), right: move(stem.right) };
}

/** The evidence with the first percussive track's stem one sample late. */
function withLateStem(evidence: RenderedEvidence): RenderedEvidence {
  const track = evidence.score.tracks.find(({ instrument }) => INSTRUMENTS[instrument].percussive);
  const stem = track === undefined ? undefined : evidence.rendered.stems[track.id];
  if (track === undefined || stem === undefined) {
    throw new Error(`${FILM} has no percussive stem to shift`);
  }
  const stems = { ...evidence.rendered.stems, [track.id]: shifted(stem, 1) };
  return { ...evidence, rendered: { ...evidence.rendered, stems } };
}

/** Re-muxes the delivered video, stream-copied, with the master encoded again, under the given muxer flags. */
async function remux(delivered: string, output: string, flags: readonly string[]): Promise<string> {
  await RenderInternals.callFf({
    bin: 'ffmpeg',
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      delivered,
      '-ch_layout',
      'stereo',
      '-i',
      masterWavFile(FILM),
      '-map',
      '0:v:0',
      '-map',
      '1:a:0',
      '-c:v',
      'copy',
      '-af',
      `adelay=${String(PAD_SAMPLES)}S:all=1`,
      '-c:a',
      'aac',
      '-b:a',
      '320k',
      ...flags,
      '-movflags',
      '+faststart',
      '-y',
      output,
    ],
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
    cancelSignal: undefined,
  });
  return output;
}

/** Publishes the master WAV again with `samples` of silence before it. */
async function padMaster(samples: number): Promise<void> {
  const file = masterWavFile(FILM);
  const bytes = readFileSync(file);
  const header = wavHeader(0).length;
  const data = bytes.subarray(header);
  const padded = new Uint8Array(header + samples * 6 + data.length);
  padded.set(wavHeader(data.length / 6 + samples));
  padded.set(data, header + samples * 6);
  await publishFile(file, padded);
}

/** A directory for one video of the controls, inside the run's own. */
function videoDirectory(run: string, name: string): string {
  const directory = path.join(run, name);
  mkdirSync(directory, { recursive: true });
  return directory;
}

/**
 * Runs every control; true when each went red and every gate passed on the
 * unaltered fixture. Every MP4 judged is rendered into this run's own
 * directory, never the published one another command may replace.
 */
async function controls(scratch: string): Promise<boolean> {
  return withRunDirectory(loadFilm(FILM), async (run) => controlsIn(scratch, run));
}

async function controlsIn(scratch: string, run: string): Promise<boolean> {
  const evidence = await renderEvidence(FILM, DEFAULT_GL, videoDirectory(run, 'unaltered'));
  const delivery = await inspectDelivery(evidence, evidence.video.path);
  const clean = await runGates(evidence, delivery);
  const greens = clean.map((result) => !show('unaltered', result));

  const reds = [
    show(
      'stem shifted by 1 sample',
      gate(await runGates(withLateStem(evidence), delivery), 'audio')
    ),
  ];

  const offset = await renderFilmVideo('qa-offset', {
    draft: false,
    gl: DEFAULT_GL,
    probeFrames: evidence.probes,
    directory: videoDirectory(run, 'offset'),
  });
  const planes = await inspectPlanes(evidence, offset.path);
  reds.push(show('video offset by one frame', stillsMatchGate(FILM, planes.judged)));

  for (const [label, name, flags] of [
    ['muxed with edit lists', 'edit-lists.mp4', []],
    ['muxed with no edit list but shifted timestamps', 'stretched.mp4', ['-use_editlist', '0']],
  ] as const) {
    const file = await remux(evidence.video.path, path.join(scratch, name), flags);
    const remuxed = await inspectDelivery(evidence, file);
    reds.push(show(label, finalFileGate(FILM, remuxed.finalFile)));
  }

  await padMaster(MASTER_PAD);
  const padded = await renderFilmVideo(FILM, {
    draft: false,
    gl: DEFAULT_GL,
    probeFrames: evidence.probes,
    directory: videoDirectory(run, 'padded'),
  });
  const paddedDelivery = await inspectDelivery(evidence, padded.path);
  reds.push(
    show(
      `master padded by ${String(MASTER_PAD)} samples before the mux`,
      finalFileGate(FILM, paddedDelivery.finalFile)
    )
  );
  return greens.every(Boolean) && reds.every(Boolean);
}

async function main(): Promise<number> {
  const scratch = mkdtempSync(path.join(tmpdir(), 'films-qa-controls-'));
  let passed = false;
  try {
    passed = await controls(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    // The padded control writes over the fixture's master; a clean verify writes
    // it back, with the MP4 and report a verify of it leaves.
    await verifyFilm(FILM, { gl: DEFAULT_GL });
  }
  print(
    passed
      ? 'every control red, every gate green without it; out/ rewritten by a clean verify'
      : 'a control stayed green or a gate failed unaltered'
  );
  return passed ? 0 : 1;
}

await exitWhenWritten(await main());
