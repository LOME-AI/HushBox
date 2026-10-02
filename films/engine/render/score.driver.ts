import path from 'node:path';

import { amplitudeToDb, audioReport } from '../analyze/index.js';
import { spectrogramPng, waveformPng } from '../analyze/png.driver.js';
import { encodeWav24 } from '../audio/dsp/index.js';
import { defineScore, renderScore } from '../audio/score/index.js';
import { rand } from '../rand/rand.js';

import { FilmRenderError } from './film-error.js';
import { masterWavFile } from './films.driver.js';
import { publishFile } from './run-directory.js';
import { STEM_PEAK_DBFS, analysisCues, scaleStereo, stemGain } from './score-products.js';

import type { LoadedFilm } from './films.driver.js';

const SPECTROGRAM_SIZE = { width: 1600, height: 600 };
const WAVEFORM_SIZE = { width: 1600, height: 400 };

/**
 * Publishes one file: a reader of it, such as a mux reading the master while
 * another command scores the same film, sees the earlier file or this one.
 */
async function writeFile(file: string, bytes: Uint8Array | string): Promise<string> {
  return publishFile(file, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
}

/**
 * Renders a film's score and writes its master to the public directory, where
 * the preview `<Audio>` and the mux read it, and to the film's `out/` its stems
 * (every stem scaled by one gain, recorded in the report), the audio report and
 * the spectrogram and waveform pictures. Returns every file written.
 */
export async function writeScore(film: LoadedFilm): Promise<string[]> {
  const { spec, score } = film.definition;
  if (score === undefined) {
    throw new FilmRenderError({
      filmId: film.id,
      rule: 'score',
      detail: 'the film declares no score',
    });
  }
  const rendered = renderScore(defineScore(score, spec));
  const cues = analysisCues(spec.cues);
  const stems = stemGain(rendered.stems);
  const stemFiles: string[] = [];
  for (const [track, stem] of Object.entries(rendered.stems)) {
    stemFiles.push(
      await writeFile(
        path.join(film.outDir, 'stems', `${track}.wav`),
        encodeWav24(scaleStereo(stem, stems.gain), rand(`${spec.seed}/stem/${track}`))
      )
    );
  }
  const report = {
    filmId: film.id,
    master: audioReport(rendered.master, cues),
    stems: {
      peakDbfs: STEM_PEAK_DBFS,
      loudest: stems.loudest,
      gain: stems.gain,
      gainDb: amplitudeToDb(stems.gain),
    },
  };
  return [
    await writeFile(masterWavFile(film.id), rendered.wav),
    ...stemFiles,
    await writeFile(
      path.join(film.outDir, 'audio-report.json'),
      `${JSON.stringify(report, null, 2)}\n`
    ),
    await writeFile(
      path.join(film.outDir, 'spectrogram.png'),
      await spectrogramPng(rendered.master, SPECTROGRAM_SIZE)
    ),
    await writeFile(
      path.join(film.outDir, 'waveform.png'),
      await waveformPng(rendered.master, cues, WAVEFORM_SIZE)
    ),
  ];
}
