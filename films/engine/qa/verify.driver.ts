import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import { INSTRUMENTS } from '../audio/instruments/index.js';
import { defineScore, renderScore } from '../audio/score/index.js';
import { parseLookTextLine } from '../layout/claims.js';
import { splitLookBoxes } from '../look/contract.js';
import { writeContactSheet } from '../render/contact-sheet.driver.js';
import { LEAD_FRAMES } from '../render/delivery-timing.js';
import { FilmRenderError } from '../render/film-error.js';
import { loadFilm } from '../render/films.driver.js';
import { probeFrames, withNeighbours } from '../render/probe-frames.js';
import { renderFilmStills, renderFilmVideo } from '../render/render-film.driver.js';
import { publishFile, publishVideo, withRunDirectory } from '../render/run-directory.js';
import { writeScore } from '../render/score.driver.js';
import { HEIGHT, WIDTH } from '../time/grid.js';

import { blockMeans, colourScoreOfMeans } from './colour.js';
import { chartColour } from './colour-chart.driver.js';
import { compositionLines, compositionMeter } from './composition.js';
import { measureContainment, measureContrast } from './contrast.js';
import {
  LUMA_BYTES,
  decodeAudio,
  decodePng,
  forEachDecodedFrame,
  packetPts,
  probeStream,
  readMoov,
  referenceLuma,
} from './decode.driver.js';
import { cueOnsets } from './evidence.js';
import { frameLight, transitionsBetween } from './flashes.js';
import { identicalRuns } from './frames.js';
import { QaGateError } from './gate.js';
import { allGates } from './gates.js';
import { mp4Tracks } from './mp4-boxes.js';
import {
  HIDDEN_TEXT_PROPS,
  UNFINISHED_HIDDEN_TEXT_PROPS,
  UNFINISHED_TEXT_PROPS,
} from './qa-props.js';
import { pairPurityFrame } from './purity-pair.driver.js';
import { lumaPlane, meanAndDeviation } from './raster.js';
import { markImageOf, measureRestingMark, restingRunEnds } from './resting-mark.js';
import { reportMarkdown, verifyReport } from './report.js';
import { judgeProbe } from './stills-match.js';

import type { RenderedScore, Score } from '../audio/score/index.js';
import type { LogoBox, TextBox } from '../look/contract.js';
import type { LoadedFilm } from '../render/films.driver.js';
import type { SheetStill } from '../render/contact-sheet.driver.js';
import type { RenderedVideo, StillOptions } from '../render/render-film.driver.js';
import type { ColourScore } from './colour.js';
import type { CompositionReport } from './composition.js';
import type { ClaimContrast, FrameContainment } from './contrast.js';
import type { FinalFileEvidence } from './final-file.js';
import type { FrameLight, Transition } from './flashes.js';
import type { LumaStats } from './frames.js';
import type { PurityFrame } from './purity.js';
import type { MarkImage, RestingMark } from './resting-mark.js';
import type { GateResult } from './gate.js';
import type { JudgedProbe } from './stills-match.js';

/** A film's master render and the probe frames it kept: what the luma comparison reads. */
export type MasterRender = Pick<RenderedEvidence, 'film' | 'probes' | 'video'>;

/** Everything `verify` renders of a film before it looks at the delivered MP4. */
export interface RenderedEvidence {
  film: LoadedFilm;
  score: Score;
  rendered: RenderedScore;
  probes: number[];
  /** Each probe frame's fresh-page still, as rendered with the QA channel on. */
  stills: ReadonlyMap<number, Uint8Array>;
  /** Every frame's text boxes, as the master render reported them. */
  textBoxes: ReadonlyMap<number, readonly TextBox[]>;
  contrast: ClaimContrast[][];
  containment: FrameContainment[];
  /** Each resting mark a compared frame reports (probe frames and the ends of resting runs), matched against the logo file. */
  restingMarks: RestingMark[];
  video: RenderedVideo;
  /** Every file written that outlasts the render, but the MP4, which `video.path` names. */
  files: string[];
}

/** What `verify` reads of the delivered MP4. */
export interface DeliveryEvidence {
  finalFile: FinalFileEvidence;
  picture: PictureEvidence;
}

function readBytes(file: string): Uint8Array {
  return new Uint8Array(readFileSync(file));
}

/** Collects each frame's text boxes and resting marks from the look host's console lines, frame by frame. */
function textCollector(): {
  boxes: Map<number, TextBox[]>;
  logos: Map<number, LogoBox[]>;
  onBrowserLog: (line: string) => void;
} {
  const boxes = new Map<number, TextBox[]>();
  const logos = new Map<number, LogoBox[]>();
  return {
    boxes,
    logos,
    onBrowserLog: (line) => {
      const parsed = parseLookTextLine(line);
      if (parsed !== null) {
        const { text, logos: marks } = splitLookBoxes(parsed.boxes);
        boxes.set(parsed.frame, text);
        logos.set(parsed.frame, marks);
      }
    },
  };
}

/** Where a verify's stills render, and the GL backend they render on. */
interface StillsTarget {
  gl: string;
  /** A directory only this verify writes, so no other command reads these stills. */
  run: string;
}

/** Each frame beside the file the stills render handed back for it, in the order of `frames`. */
function framesWithFiles(
  film: LoadedFilm,
  frames: readonly number[],
  files: readonly string[]
): SheetStill[] {
  return frames.map((frame, index) => {
    const file = files[index];
    if (file === undefined) {
      throw new FilmRenderError({
        filmId: film.id,
        rule: 'verify',
        detail: `the stills render handed back no file for frame ${String(frame)}`,
      });
    }
    return { frame, file };
  });
}

/** Renders the frames into the run's directory and keeps each still's bytes and file. */
async function renderedStills(
  film: LoadedFilm,
  frames: readonly number[],
  { gl, run }: StillsTarget,
  options: Pick<StillOptions, 'inputProps' | 'onBrowserLog'>
): Promise<{ files: SheetStill[]; stills: Map<number, Uint8Array> }> {
  const rendered = await renderFilmStills(film.id, frames, { gl, directory: run, ...options });
  const files = framesWithFiles(film, frames, rendered);
  const stills = new Map(files.map(({ frame, file }) => [frame, readBytes(file)] as const));
  return { files, stills };
}

/** Renders the probe stills with the QA channel on, keeping their bytes and files and every frame's text boxes. */
async function textStillsPass(
  film: LoadedFilm,
  probes: readonly number[],
  target: StillsTarget
): Promise<{
  files: SheetStill[];
  stills: Map<number, Uint8Array>;
  boxes: Map<number, TextBox[]>;
  logos: Map<number, LogoBox[]>;
}> {
  const text = textCollector();
  const { files, stills } = await renderedStills(film, probes, target, {
    inputProps: { qa: true },
    onBrowserLog: text.onBrowserLog,
  });
  return { files, stills, boxes: text.boxes, logos: text.logos };
}

/** The brand logo file as the resting-mark gate compares with it, decoded from the file the look host loads. */
async function markImage(filmId: string): Promise<MarkImage> {
  const file = createRequire(import.meta.url).resolve('@hushbox/ui/assets/HushBoxLogo.png');
  const { width, height, data } = await decodePng(filmId, readBytes(file));
  return markImageOf({ width, height, data });
}

/** What the resting-mark gate reads: each compared frame's still and the resting marks it reported. */
interface MarkStills {
  stills: ReadonlyMap<number, Uint8Array>;
  logos: ReadonlyMap<number, LogoBox[]>;
}

/**
 * The probe stills, and a still of the first and the last frame of each
 * resting run the master render reported (a mark in one unchanged box),
 * rendered with the QA channel on wherever the probe set misses one, so no
 * resting run goes uncompared.
 */
async function markStillsPass(
  film: LoadedFilm,
  probes: readonly number[],
  { qa, rendered }: { qa: MarkStills; rendered: ReadonlyMap<number, LogoBox[]> },
  target: StillsTarget
): Promise<MarkStills> {
  const probed = new Set(probes);
  const missed = restingRunEnds(rendered).filter((frame) => !probed.has(frame));
  if (missed.length === 0) {
    return qa;
  }
  const ends = await textStillsPass(film, missed, target);
  return {
    stills: new Map([...qa.stills, ...ends.stills]),
    logos: new Map([...qa.logos, ...ends.logos]),
  };
}

/**
 * Each resting mark a compared frame reports, matched against the logo file in
 * that frame's still as delivered, the post chain applied when the look opts in.
 */
async function restingMarkPass(
  film: LoadedFilm,
  { stills, logos }: Pick<MarkStills, 'stills' | 'logos'>
): Promise<RestingMark[]> {
  const frames = [...logos.entries()]
    .filter(([, marks]) => marks.length > 0)
    .toSorted(([a], [b]) => a - b);
  if (frames.length === 0) {
    return [];
  }
  const logo = await markImage(film.id);
  const measured: RestingMark[] = [];
  for (const [frame, marks] of frames) {
    const drawn = await decodePng(film.id, bytesOf(film, stills, frame));
    measured.push(...marks.map((mark) => measureRestingMark({ frame, mark, drawn, logo })));
  }
  return measured;
}

/** Renders the frames under the input props into the run's directory and keeps each still's bytes. */
async function renderedBytes(
  film: LoadedFilm,
  frames: readonly number[],
  target: StillsTarget,
  inputProps: Record<string, unknown>
): Promise<Map<number, Uint8Array>> {
  const { stills } = await renderedStills(film, frames, target, { inputProps });
  return stills;
}

function bytesOf(
  film: LoadedFilm,
  rendered: ReadonlyMap<number, Uint8Array>,
  frame: number
): Uint8Array {
  const bytes = rendered.get(frame);
  if (bytes === undefined) {
    throw new FilmRenderError({
      filmId: film.id,
      rule: 'verify',
      detail: `the text pass kept no still of frame ${String(frame)}`,
    });
  }
  return bytes;
}

/** What the text pair renders measure: each copy box's contrast and each frame's containment. */
interface TextPairMeasures {
  contrast: ClaimContrast[][];
  containment: FrameContainment[];
}

/** Each copy box's contrast on the probe frames that report boxes, against the frame as delivered. */
async function contrastPass(
  film: LoadedFilm,
  stills: ReadonlyMap<number, Uint8Array>,
  boxes: ReadonlyMap<number, TextBox[]>,
  target: StillsTarget
): Promise<ClaimContrast[][]> {
  const frames = [...boxes.entries()]
    .filter(([, frameBoxes]) => frameBoxes.length > 0)
    .map(([frame]) => frame)
    .toSorted((a, b) => a - b);
  if (frames.length === 0) {
    return [];
  }
  const hidden = await renderedBytes(film, frames, target, HIDDEN_TEXT_PROPS);
  const measured: ClaimContrast[][] = [];
  for (const frame of frames) {
    measured.push(
      measureContrast({
        frame,
        boxes: boxes.get(frame) ?? [],
        text: await decodePng(film.id, bytesOf(film, stills, frame)),
        hidden: await decodePng(film.id, bytesOf(film, hidden, frame)),
      })
    );
  }
  return measured;
}

/** Each probe frame's containment, on the look's own pixels with the post chain skipped. */
async function containmentPass(
  film: LoadedFilm,
  probes: readonly number[],
  boxes: ReadonlyMap<number, TextBox[]>,
  target: StillsTarget
): Promise<FrameContainment[]> {
  const unfinished = await renderedBytes(film, probes, target, UNFINISHED_TEXT_PROPS);
  const unfinishedHidden = await renderedBytes(film, probes, target, UNFINISHED_HIDDEN_TEXT_PROPS);
  const measured: FrameContainment[] = [];
  for (const frame of probes) {
    measured.push(
      measureContainment({
        frame,
        boxes: boxes.get(frame) ?? [],
        text: await decodePng(film.id, bytesOf(film, unfinished, frame)),
        hidden: await decodePng(film.id, bytesOf(film, unfinishedHidden, frame)),
      })
    );
  }
  return measured;
}

/**
 * Renders the probe frames again: those reporting text with `hideText`,
 * measuring each copy box's contrast against the frame as delivered; then every
 * probe frame with the post chain skipped, with its text and without, measuring
 * containment on the look's own pixels, so text drawn on a frame that reports
 * no box is caught.
 */
async function textPairPass(
  film: LoadedFilm,
  probes: readonly number[],
  {
    stills,
    boxes,
  }: { stills: ReadonlyMap<number, Uint8Array>; boxes: ReadonlyMap<number, TextBox[]> },
  target: StillsTarget
): Promise<TextPairMeasures> {
  const contrast = await contrastPass(film, stills, boxes, target);
  const containment = await containmentPass(film, probes, boxes, target);
  return { contrast, containment };
}

/**
 * Scores the film, renders its stills, its text pairs and its delivered MP4
 * with the QA channel on, and writes the contact sheet. The stills render into
 * a directory only this call writes, removed when it returns, their bytes kept.
 * The MP4 goes to `videoDirectory`, the caller's own run directory, when given;
 * otherwise it is published to `out/<film-id>.mp4`.
 */
export async function renderEvidence(
  filmId: string,
  gl: string,
  videoDirectory?: string
): Promise<RenderedEvidence> {
  const film = loadFilm(filmId);
  const { spec, score: input } = film.definition;
  if (input === undefined) {
    throw new FilmRenderError({
      filmId,
      rule: 'verify',
      detail: 'the film declares no score; verify gates a film with its audio',
    });
  }
  const scoreFiles = await writeScore(film);
  const score = defineScore(input, spec);
  const rendered = renderScore(score);
  const probes = probeFrames(spec);
  return withRunDirectory(film, async (run) => {
    const target: StillsTarget = { gl, run };
    const qa = await textStillsPass(film, probes, target);
    const sheet = await writeContactSheet(qa.files, path.join(film.outDir, 'sheet.png'));
    const pairs = await textPairPass(film, probes, qa, target);
    const text = textCollector();
    const video = await renderFilmVideo(filmId, {
      draft: false,
      gl,
      probeFrames: probes,
      inputProps: { qa: true },
      onBrowserLog: text.onBrowserLog,
      ...(videoDirectory === undefined ? {} : { directory: videoDirectory }),
    });
    const marks = await markStillsPass(
      film,
      probes,
      { qa: { stills: qa.stills, logos: qa.logos }, rendered: text.logos },
      target
    );
    const restingMarks = await restingMarkPass(film, marks);
    return {
      film,
      score,
      rendered,
      probes,
      stills: qa.stills,
      textBoxes: text.boxes,
      contrast: pairs.contrast,
      containment: pairs.containment,
      restingMarks,
      video,
      files: [...scoreFiles, sheet],
    };
  });
}

function probePng(evidence: MasterRender, frame: number): Uint8Array {
  const png = evidence.video.probePngs.get(frame);
  if (png === undefined) {
    throw new FilmRenderError({
      filmId: evidence.film.id,
      rule: 'verify',
      detail: `the master kept no PNG of frame ${String(frame)}`,
    });
  }
  return png;
}

/** Judges each probe's delivered luma against its own and its neighbours' master frames, one probe at a time. */
async function judgeProbes(
  evidence: MasterRender,
  decoded: ReadonlyMap<number, Uint8Array>
): Promise<JudgedProbe[]> {
  const { durationInFrames } = evidence.film.definition.spec;
  const judged: JudgedProbe[] = [];
  for (const frame of evidence.probes) {
    const frames = withNeighbours([frame], durationInFrames);
    const planes = await referenceLuma(
      evidence.film.id,
      frames.map((neighbour) => probePng(evidence, neighbour))
    );
    const plane = decoded.get(frame);
    if (plane === undefined) {
      throw new FilmRenderError({
        filmId: evidence.film.id,
        rule: 'decode',
        detail: `the delivered MP4 holds no frame ${String(frame + LEAD_FRAMES)} for probe frame ${String(frame)}`,
      });
    }
    judged.push(
      judgeProbe({
        frame,
        decoded: plane,
        references: new Map(
          frames.map((neighbour, index) => [neighbour, planes[index] ?? new Uint8Array(0)])
        ),
      })
    );
  }
  return judged;
}

/** What `verify` reads of the delivered picture, decoding it twice: the stored planes, then RGB as tagged. */
export interface PictureEvidence {
  decodedFrames: number;
  sameAsPrevious: boolean[];
  judged: JudgedProbe[];
  transitions: Transition[];
  colour: ColourScore[];
  /** The composition measure: reported beside the gates, never one of them. */
  composition: CompositionReport;
}

/** The stored planes: each frame against the one before, and each probe frame's luma judged against the master. */
export async function inspectPlanes(
  evidence: MasterRender,
  file: string
): Promise<Pick<PictureEvidence, 'decodedFrames' | 'sameAsPrevious' | 'judged'>> {
  const byDelivered = new Map(evidence.probes.map((frame) => [frame + LEAD_FRAMES, frame]));
  const sameAsPrevious: boolean[] = [];
  const lumas = new Map<number, Uint8Array>();
  let previous: Uint8Array | null = null;
  const decodedFrames = await forEachDecodedFrame(
    evidence.film.id,
    file,
    'yuv420p',
    (index, frame) => {
      sameAsPrevious.push(previous !== null && Buffer.compare(previous, frame) === 0);
      previous = frame;
      const probe = byDelivered.get(index);
      if (probe !== undefined) {
        lumas.set(probe, frame.slice(0, LUMA_BYTES));
      }
    }
  );
  return { decodedFrames, sameAsPrevious, judged: await judgeProbes(evidence, lumas) };
}

/**
 * RGB as tagged: every frame-to-frame transition, each probe frame's block
 * means against its still, and the composition measure over the film's frames,
 * the lead's copies of frame 0 skipped.
 */
async function inspectRgb(
  evidence: RenderedEvidence,
  file: string
): Promise<Pick<PictureEvidence, 'transitions' | 'colour' | 'composition'>> {
  const filmId = evidence.film.id;
  const byDelivered = new Map(evidence.probes.map((frame) => [frame + LEAD_FRAMES, frame]));
  const stillMeans = new Map<number, Float64Array>();
  for (const [frame, still] of evidence.stills) {
    stillMeans.set(frame, blockMeans(await decodePng(filmId, still)));
  }
  const transitions: Transition[] = [];
  const colour: ColourScore[] = [];
  const meter = compositionMeter();
  let light: FrameLight | null = null;
  await forEachDecodedFrame(filmId, file, 'rgb24', (index, frame) => {
    const raster = { width: WIDTH, height: HEIGHT, channels: 3 as const, data: frame };
    if (index >= LEAD_FRAMES) {
      meter.add(index - LEAD_FRAMES, raster);
    }
    const next = frameLight(raster);
    if (light !== null) {
      transitions.push(...transitionsBetween(index, light, next));
    }
    light = next;
    const probe = byDelivered.get(index);
    const means = probe === undefined ? undefined : stillMeans.get(probe);
    if (probe !== undefined && means !== undefined) {
      colour.push(colourScoreOfMeans(probe, blockMeans(raster), means));
    }
  });
  return { transitions, colour, composition: meter.report() };
}

/** Decodes the delivered picture and reads what the picture gates judge. */
export async function inspectPicture(
  evidence: RenderedEvidence,
  file: string
): Promise<PictureEvidence> {
  return { ...(await inspectPlanes(evidence, file)), ...(await inspectRgb(evidence, file)) };
}

/**
 * Decodes the delivered MP4, and puts the colour chart through the delivery's
 * encode and the decode as tagged, reading every fact the delivery gates judge.
 * Its decodes and the chart's MP4 are written in a directory only this call
 * writes, removed when it returns.
 */
export async function inspectDelivery(
  evidence: RenderedEvidence,
  file: string
): Promise<DeliveryEvidence> {
  return withRunDirectory(evidence.film, async (verifyDir) =>
    inspectDeliveryIn(evidence, file, verifyDir)
  );
}

/** {@link inspectDelivery}, its decodes written in `verifyDir`. */
async function inspectDeliveryIn(
  evidence: RenderedEvidence,
  file: string,
  verifyDir: string
): Promise<DeliveryEvidence> {
  const { film, rendered, score } = evidence;
  const filmId = film.id;
  const { spec } = film.definition;
  const picture = await inspectPicture(evidence, file);
  const [honoured, ignored, videoPts, videoPtsIgnored, audioPts, stream, chartPsnr] =
    await Promise.all([
      decodeAudio(filmId, file, path.join(verifyDir, 'audio-honoured.wav'), false),
      decodeAudio(filmId, file, path.join(verifyDir, 'audio-ignored.wav'), true),
      packetPts(filmId, file, 'v', false),
      packetPts(filmId, file, 'v', true),
      packetPts(filmId, file, 'a', false),
      probeStream(filmId, file),
      chartColour(filmId, verifyDir),
    ]);
  const tracks = mp4Tracks(readMoov(filmId, file));
  const video = tracks.find(({ handler }) => handler === 'vide');
  const percussive = new Set(
    score.tracks.filter(({ instrument }) => INSTRUMENTS[instrument].percussive).map(({ id }) => id)
  );
  return {
    finalFile: {
      durationInFrames: spec.durationInFrames,
      master: rendered.master,
      stream: { ...stream, decodedFrames: picture.decodedFrames },
      tracks,
      audio: { honoured, ignored },
      picturePts: {
        honoured: videoPts,
        ignored: videoPtsIgnored,
        timescale: video?.timescale ?? 1,
      },
      audioStartTicks: audioPts[0] ?? 0,
      onsets: cueOnsets(rendered.placements, spec.cues, percussive, spec.durationInFrames),
      colour: picture.colour,
      chartPsnr,
    },
    picture,
  };
}

/** Each probe frame's master PNG against its fresh-page still, decoded only where the bytes differ. */
async function purityFrames(evidence: RenderedEvidence): Promise<PurityFrame[]> {
  const frames: PurityFrame[] = [];
  for (const frame of evidence.probes) {
    const master = probePng(evidence, frame);
    const still = evidence.stills.get(frame);
    frames.push(await pairPurityFrame(evidence.film.id, { frame, master, still }));
  }
  return frames;
}

/** The luma stats of every master frame the frame rules read: each probe frame and its neighbours. */
async function lumaStats(evidence: RenderedEvidence): Promise<Map<number, LumaStats>> {
  const stats = new Map<number, LumaStats>();
  for (const frame of evidence.video.probePngs.keys()) {
    stats.set(
      frame,
      meanAndDeviation(lumaPlane(await decodePng(evidence.film.id, probePng(evidence, frame))))
    );
  }
  return stats;
}

/** Every gate of a film, in the report's order. */
export async function runGates(
  evidence: RenderedEvidence,
  delivery: DeliveryEvidence
): Promise<GateResult[]> {
  const { film, probes, rendered, score } = evidence;
  const { spec } = film.definition;
  return allGates(film.id, {
    purity: await purityFrames(evidence),
    claims: { rows: spec.text, frames: evidence.textBoxes },
    contrast: evidence.contrast,
    containment: evidence.containment,
    logo: evidence.restingMarks,
    frames: {
      spec,
      probes,
      stats: await lumaStats(evidence),
      identicalRuns: identicalRuns(delivery.picture.sameAsPrevious),
    },
    transitions: delivery.picture.transitions,
    judged: delivery.picture.judged,
    audio: {
      cues: spec.cues,
      silences: spec.silences,
      master: rendered.master,
      placements: rendered.placements,
      percussive: score.tracks
        .filter(({ instrument }) => INSTRUMENTS[instrument].percussive)
        .map(({ id, gain }) => ({
          track: id,
          gain,
          stem: rendered.stems[id] ?? { left: new Float32Array(0), right: new Float32Array(0) },
        })),
    },
    finalFile: delivery.finalFile,
  });
}

/**
 * Publishes `out/report.md` and `out/report.json`, the composition measure
 * beside the gates and outside their verdict; returns both files.
 */
export async function writeVerifyReport(
  film: LoadedFilm,
  results: readonly GateResult[],
  composition: CompositionReport
): Promise<string[]> {
  const report = verifyReport(film.id, results);
  const markdown = path.join(film.outDir, 'report.md');
  const json = path.join(film.outDir, 'report.json');
  const measured = [
    '## Reported, not gated',
    '',
    ...compositionLines(composition).map((line) => `- ${line}`),
    '',
  ];
  const text = new TextEncoder();
  return [
    await publishFile(markdown, text.encode([reportMarkdown(report), ...measured].join('\n'))),
    await publishFile(
      json,
      text.encode(`${JSON.stringify({ ...report, composition }, null, 2)}\n`)
    ),
  ];
}

/**
 * `pnpm films verify <film>`: renders the film into a directory only this run
 * writes, so a command on the same piece beside it never hands it frames, runs
 * every gate, publishes the MP4 it judged to `out/<film-id>.mp4`, and writes the
 * report with the composition measure, which it also prints and which no
 * reading of changes the verdict. Returns every file written when every gate
 * passes; otherwise throws a `QaGateError` listing each failure, once the MP4
 * and the report are written.
 */
export async function verifyFilm(filmId: string, { gl }: { gl: string }): Promise<string[]> {
  return withRunDirectory(loadFilm(filmId), async (run) => {
    const evidence = await renderEvidence(filmId, gl, run);
    const delivery = await inspectDelivery(evidence, evidence.video.path);
    const results = await runGates(evidence, delivery);
    const video = publishVideo(evidence.film, evidence.video.path);
    const { composition } = delivery.picture;
    const reports = await writeVerifyReport(evidence.film, results, composition);
    for (const line of compositionLines(composition)) {
      process.stdout.write(`${line}\n`);
    }
    if (!results.every(({ passed }) => passed)) {
      throw new QaGateError(filmId, results);
    }
    return [...evidence.files, video, ...reports];
  });
}
