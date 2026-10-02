import { existsSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';

import { takeCompositionId } from '../film/discover.js';
import { compositionLines, compositionMeter } from '../qa/composition.js';
import { forEachDecodedFrame } from '../qa/decode.driver.js';
import { writeContactSheet } from '../render/contact-sheet.driver.js';
import { LEAD_FRAMES } from '../render/delivery-timing.js';
import { FilmRenderError } from '../render/film-error.js';
import { FILMS_ROOT, loadFilm, masterWavFile } from '../render/films.driver.js';
import { renderFilmVideo, stillFile } from '../render/render-film.driver.js';
import { publishFile, withRunDirectory } from '../render/run-directory.js';
import { writeScore } from '../render/score.driver.js';
import { HEIGHT, WIDTH } from '../time/grid.js';

import { stripFile, takeFrames } from './take-frames.js';
import { takeIdOf } from './take-path.js';

import type { TakeOptions } from '../cli/run.js';
import type { LoadedFilm } from '../render/films.driver.js';

/** The directories under a take's `out/` this verb rewrites whole, so no file of an earlier take lingers. */
const REVIEW_DIRECTORIES = ['stills', 'strips'] as const;

/** Publishes one captured frame's PNG to `file`, refusing a frame the render did not hand back. */
async function writeFrame(
  take: LoadedFilm,
  frames: ReadonlyMap<number, Uint8Array>,
  { frame, file }: { frame: number; file: string }
): Promise<string> {
  const bytes = frames.get(frame);
  if (bytes === undefined) {
    throw new FilmRenderError({
      filmId: take.id,
      rule: 'take',
      detail: `the render handed back no frame ${String(frame)}`,
    });
  }
  return publishFile(file, bytes);
}

/**
 * Removes each file in the review directories that this take did not write, so
 * no still or strip of an earlier take lingers. Files are replaced in place by
 * rename rather than cleared first, so a reader never finds a directory
 * emptied mid-take; directories in them are run directories, not products.
 */
function removeEarlierTakes(take: LoadedFilm, written: readonly string[]): void {
  const kept = new Set(written);
  for (const directory of REVIEW_DIRECTORIES.map((name) => path.join(take.outDir, name))) {
    if (!existsSync(directory)) {
      continue;
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isFile() && !kept.has(file)) {
        rmSync(file, { force: true });
      }
    }
  }
}

/**
 * Decodes the take's MP4 once, measures its composition over the take's frames
 * (the lead's copies of frame 0 skipped), prints the report and writes it to
 * `out/composition.json`, returning that file.
 */
async function writeComposition(take: LoadedFilm, mp4: string): Promise<string> {
  const meter = compositionMeter();
  await forEachDecodedFrame(take.id, mp4, 'rgb24', (index, data) => {
    if (index >= LEAD_FRAMES) {
      meter.add(index - LEAD_FRAMES, { width: WIDTH, height: HEIGHT, channels: 3, data });
    }
  });
  const report = meter.report();
  for (const line of compositionLines(report)) {
    process.stdout.write(`${line}\n`);
  }
  return publishFile(
    path.join(take.outDir, 'composition.json'),
    new TextEncoder().encode(`${JSON.stringify(report, null, 2)}\n`)
  );
}

/** Where a captured frame waits, in the take's run directory, for the sheet and the strips to be drawn from it. */
function frameFile(run: string, frame: number): string {
  return path.join(run, `frame-${String(frame).padStart(4, '0')}.png`);
}

/**
 * Renders a take, named by its path, to its `out/`: its score to `master.wav`
 * (with the stems, audio report and pictures the `score` verb writes), its look
 * through the look host to `take.mp4` with the engine's delivery settings, a
 * still on every beat of its tempo in `stills/`, a contact sheet of one frame
 * every quarter second in `sheet.png`, and a strip of the frames three either
 * side of each cue in `strips/<frame>-<cue-id>.png`. Every still, sheet and strip
 * frame is a frame of the one video render, never rendered again. It measures
 * the composition of the delivered frames into `composition.json` and prints
 * it. It runs no gate. Returns every file written.
 */
export async function renderTake(takePath: string, { gl }: TakeOptions): Promise<string[]> {
  const compositionId = takeCompositionId(
    takeIdOf(takePath, { cwd: process.cwd(), root: FILMS_ROOT })
  );
  const take = loadFilm(compositionId);

  const scored = await writeScore(take);
  const master = await publishFile(
    path.join(take.outDir, 'master.wav'),
    new Uint8Array(readFileSync(masterWavFile(compositionId)))
  );

  const chosen = takeFrames(take.definition.spec);
  const mp4 = path.join(take.outDir, 'take.mp4');
  // The take renders, is measured and is drawn from in a directory only this
  // run writes, and its MP4 is renamed from there to `take.mp4` in one step.
  const { composition, stills, sheet, strips } = await withRunDirectory(take, async (run) => {
    const video = await renderFilmVideo(compositionId, {
      draft: false,
      gl,
      probeFrames: chosen.captured,
      directory: run,
    });
    const measured = await writeComposition(take, video.path);
    renameSync(video.path, mp4);
    const beatStills: string[] = [];
    for (const frame of chosen.beats) {
      beatStills.push(
        await writeFrame(take, video.probePngs, { frame, file: stillFile(take, frame) })
      );
    }
    for (const frame of chosen.captured) {
      await writeFrame(take, video.probePngs, { frame, file: frameFile(run, frame) });
    }
    const drawn = await writeContactSheet(
      chosen.sheet.map((frame) => ({ frame, file: frameFile(run, frame) })),
      path.join(take.outDir, 'sheet.png')
    );
    const cueStrips: string[] = [];
    for (const strip of chosen.strips) {
      cueStrips.push(
        await writeContactSheet(
          strip.frames.map((frame) => ({ frame, file: frameFile(run, frame) })),
          stripFile(take.outDir, strip)
        )
      );
    }
    return { composition: measured, stills: beatStills, sheet: drawn, strips: cueStrips };
  });
  removeEarlierTakes(take, [...stills, ...strips]);

  return [mp4, master, composition, ...stills, sheet, ...strips, ...scored];
}
