import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { DEFAULT_GL } from '../../cli/command.js';
import { exitWhenWritten } from '../../cli/run.js';
import { muxArguments } from '../../render/ffmpeg-args.js';
import { HEIGHT, WIDTH } from '../../time/grid.js';
import { blockMeans, colourCheck, colourScoreOfMeans } from '../../qa/colour.js';
import { chartColour, encodePngs } from '../../qa/colour-chart.driver.js';
import { decodePng, forEachDecodedFrame } from '../../qa/decode.driver.js';
import { loadFilm } from '../../render/films.driver.js';
import { withRunDirectory } from '../../render/run-directory.js';
import { finalFileGate } from '../../qa/final-file.js';
import { inspectDelivery, renderEvidence } from '../../qa/verify.driver.js';

import type { MuxOptions } from '../../render/ffmpeg-args.js';
import type { ColourScore } from '../../qa/colour.js';
import type { Mux } from '../../qa/colour-chart.driver.js';
import type { GateResult } from '../../qa/gate.js';
import type { RenderedEvidence } from '../../qa/verify.driver.js';

// The wrong-matrix control: the delivery's encode with its RGB → Y′CbCr matrix
// swapped for BT.601 and its BT.709 tags kept, on a film of dark, near-grey
// frames. It prints the colour-matrix rule red under the swap and green
// without it, beside the film's own colour lines under the same swap, which
// such frames cannot turn red. Run with `node --import tsx` from the
// repository root.

const FILM = 'qa-contrast-clear';
const DELIVERED_MATRIX = 'out_color_matrix=bt709';
const WRONG_MATRIX = 'out_color_matrix=bt601';

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function show(label: string, result: GateResult): void {
  print(`${label}: ${result.gate} ${result.passed ? 'pass' : 'FAIL'}`);
  for (const line of [...result.failures, ...result.measured]) {
    print(`  ${line}`);
  }
}

/** The delivery's own arguments with the conversion's matrix swapped for BT.601, the tags left as they are. */
function bt601(options: MuxOptions): string[] {
  const delivered = muxArguments(options);
  const swapped = delivered.map((argument) => argument.replace(DELIVERED_MATRIX, WRONG_MATRIX));
  if (swapped.every((argument, index) => argument === delivered[index])) {
    throw new Error(`the delivery's arguments name no ${DELIVERED_MATRIX} to swap`);
  }
  return swapped;
}

/** Each probe frame's master PNG encoded under `mux`, decoded as tagged and scored against its still. */
async function probeColour(
  evidence: RenderedEvidence,
  mux: Mux,
  output: string
): Promise<ColourScore[]> {
  const { probes, stills, video } = evidence;
  const pngs = probes.map((frame) => {
    const png = video.probePngs.get(frame);
    if (png === undefined) {
      throw new Error(`the master kept no PNG of frame ${String(frame)}`);
    }
    return png;
  });
  await encodePngs(FILM, pngs, output, mux);
  const stillMeans: Float64Array[] = [];
  for (const frame of probes) {
    const still = stills.get(frame);
    if (still === undefined) {
      throw new Error(`verify kept no still of frame ${String(frame)}`);
    }
    stillMeans.push(blockMeans(await decodePng(FILM, still)));
  }
  const scores: ColourScore[] = [];
  await forEachDecodedFrame(FILM, output, 'rgb24', (index, frame) => {
    const means = blockMeans({ width: WIDTH, height: HEIGHT, channels: 3, data: frame });
    scores.push(
      colourScoreOfMeans(probes[index] ?? -1, means, stillMeans[index] ?? new Float64Array(0))
    );
  });
  return scores;
}

function showColour(label: string, scores: readonly ColourScore[]): void {
  const { failures, measured } = colourCheck(FILM, scores);
  print(`${label}: ${failures.length === 0 ? 'pass' : 'FAIL'}`);
  for (const line of measured) {
    print(`  ${line}`);
  }
}

/** True when the colour-matrix rule fails under the swap and every final-file rule passes without it. */
async function control(scratch: string): Promise<boolean> {
  // The MP4 judged is this run's own, never the published one another command may replace.
  const { evidence, finalFile } = await withRunDirectory(loadFilm(FILM), async (run) => {
    const rendered = await renderEvidence(FILM, DEFAULT_GL, run);
    const delivery = await inspectDelivery(rendered, rendered.video.path);
    return { evidence: rendered, finalFile: delivery.finalFile };
  });
  const unaltered = finalFileGate(FILM, finalFile);
  show('unaltered', unaltered);

  showColour(
    "the film's probe frames, encoded as delivered: colour",
    await probeColour(evidence, muxArguments, path.join(scratch, 'probes-bt709.mp4'))
  );
  const wrongFilm = await probeColour(evidence, bt601, path.join(scratch, 'probes-bt601.mp4'));
  showColour("the film's probe frames, encoded through BT.601 tagged BT.709: colour", wrongFilm);

  const swapped = finalFileGate(FILM, {
    ...finalFile,
    colour: wrongFilm,
    chartPsnr: await chartColour(FILM, scratch, bt601),
  });
  show('encoded through BT.601, tagged BT.709', swapped);
  const red = swapped.failures.some((line) => line.startsWith(`${FILM}: colour-matrix: `));
  return unaltered.passed && red;
}

async function main(): Promise<number> {
  const scratch = mkdtempSync(path.join(tmpdir(), 'films-wrong-matrix-'));
  let passed = false;
  try {
    passed = await control(scratch);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  print(
    passed
      ? 'the colour-matrix rule red under BT.601, every final-file rule green without it'
      : 'the colour-matrix rule stayed green under BT.601, or a final-file rule failed unaltered'
  );
  return passed ? 0 : 1;
}

await exitWhenWritten(await main());
