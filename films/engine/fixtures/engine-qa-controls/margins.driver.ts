import { DEFAULT_GL } from '../../cli/command.js';
import { exitWhenWritten } from '../../cli/run.js';
import { loadFilm } from '../../render/films.driver.js';
import { renderFilmVideo } from '../../render/render-film.driver.js';
import { withRunDirectory } from '../../render/run-directory.js';
import { stillsMatchGate } from '../../qa/stills-match.js';
import { inspectPlanes } from '../../qa/verify.driver.js';

// Measures the stills-match rule's floor and neighbour margins on the engine
// fixtures under the delivery encode, every frame of each treated as a probe
// frame, so a change to the encode shows how much room the rule has left.
// Run with `node --import tsx` from the repository root, naming fixtures or
// none for `engine-render`.

const FIXTURES = ['engine-render'];

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

async function measure(filmId: string): Promise<boolean> {
  const film = loadFilm(filmId);
  const probes = Array.from({ length: film.definition.spec.durationInFrames }, (_, frame) => frame);
  // The MP4 judged is this run's own, never the published one another command may replace.
  const { judged } = await withRunDirectory(film, async (run) => {
    const video = await renderFilmVideo(filmId, {
      draft: false,
      gl: DEFAULT_GL,
      probeFrames: probes,
      directory: run,
    });
    return inspectPlanes({ film, probes, video }, video.path);
  });
  const result = stillsMatchGate(filmId, judged);
  print(`${filmId}: stills-match ${result.passed ? 'pass' : 'FAIL'}`);
  for (const line of [...result.measured, ...result.failures]) {
    print(`  ${line}`);
  }
  return result.passed;
}

async function main(): Promise<number> {
  const named = process.argv.slice(2);
  let passed = true;
  for (const filmId of named.length > 0 ? named : FIXTURES) {
    passed = (await measure(filmId)) && passed;
  }
  return passed ? 0 : 1;
}

await exitWhenWritten(await main());
