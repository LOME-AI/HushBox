import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import {
  RenderInternals,
  makeCancelSignal,
  renderFrames,
  renderStill,
  selectComposition,
} from '@remotion/renderer';

import { FPS } from '../time/grid.js';
import { UI_FRAMES_DIRECTORY, frameRuns, readUiPlanLine, uiFrameFile } from '../ui/ui-plan.js';
import { UI_PASS_PROPS, UI_PLAN_PROPS, uiFramesProps } from '../ui/ui-props.js';

import { LEAD_FRAMES } from './delivery-timing.js';
import { muxArguments } from './ffmpeg-args.js';
import { FilmRenderError } from './film-error.js';
import { withFilmBrowser, withFilmBundle } from './film-browser.driver.js';
import { loadFilm, masterWavFile } from './films.driver.js';
import { createFrameQueue } from './frame-queue.js';
import { frameSettings } from './frame-settings.js';
import { requireFrames, withNeighbours } from './probe-frames.js';
import { publishVideo, withRunDirectory } from './run-directory.js';

import type { BrowserLog, CancelSignal, HeadlessBrowser, OpenGlRenderer } from '@remotion/renderer';
import type { LoadedFilm } from './films.driver.js';
import type { FrameQueue } from './frame-queue.js';

/**
 * How long a render may go without finishing a frame before it counts as a
 * stall. A frame's deadline includes opening its page, which loads the whole
 * bundle and slows with the machine's load, so it is set far above any frame.
 */
const STALL_SECONDS = 120;

/**
 * Remotion's own timeout, for a `delayRender` or a seek, sits past the stall
 * deadline, so every stall, whether or not Remotion would notice it, fails
 * through the deadline and names its frame the same way.
 */
const REMOTION_TIMEOUT_MS = 2 * STALL_SECONDS * 1000;

export interface StillOptions {
  gl: string;
  inputProps?: Record<string, unknown>;
  /** Receives each line the render tab writes to its console. */
  onBrowserLog?: (line: string) => void;
}

export interface StillsOptions extends StillOptions {
  /**
   * Where the stills are written: a run's own directory, so no other command
   * reads them. Omitted, they are published to the piece's `out/stills/`, each
   * rendered in a run directory and renamed into place.
   */
  directory?: string;
}

export interface VideoOptions extends StillOptions {
  /** Half-size JPEG frames rendered in parallel: quick to make, never purity-checked. */
  draft: boolean;
  /** The frames whose bytes, and whose neighbours' bytes, come back with the video. */
  probeFrames: readonly number[];
  /**
   * Where the MP4 is written and left: a run's own directory, so no other
   * command's render replaces it. Omitted, it is encoded in a run directory of
   * its own and published to `out/<film-id>.mp4` once complete.
   */
  directory?: string;
}

export interface RenderedVideo {
  /** The delivered MP4. */
  path: string;
  /** Each frame's SHA-256, by frame, as rendered: PNG, or half-size JPEG for a draft. */
  frameSha256: string[];
  /** The bytes of each probe frame and of the frame either side of it, as rendered. */
  probePngs: ReadonlyMap<number, Uint8Array>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function glBackend(filmId: string, gl: string): OpenGlRenderer {
  let backend: OpenGlRenderer | null;
  try {
    backend = RenderInternals.validateOpenGlRenderer(gl);
  } catch (error) {
    throw new FilmRenderError({ filmId, rule: 'gl', detail: messageOf(error) }, { cause: error });
  }
  if (backend === null) {
    throw new FilmRenderError({ filmId, rule: 'gl', detail: 'no GL backend was given' });
  }
  return backend;
}

/** Hands each console line of the render tab to `onBrowserLog`, when one is given. */
function browserLog({ onBrowserLog }: StillOptions): (log: BrowserLog) => void {
  return (log) => {
    onBrowserLog?.(log.text);
  };
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A deadline re-armed on each sign of progress, calling `onStall` when one
 * passes with none. It reads the wall clock of the Node process that drives
 * the render; nothing it measures reaches a frame. A superseded deadline still
 * fires, and is ignored; `AbortSignal.timeout` holds no process open.
 */
function stallWatch(onStall: () => void): { arm: () => void; disarm: () => void } {
  let generation = 0;
  return {
    arm() {
      generation += 1;
      const armed = generation;
      AbortSignal.timeout(STALL_SECONDS * 1000).addEventListener(
        'abort',
        () => {
          if (armed === generation) {
            onStall();
          }
        },
        { once: true }
      );
    },
    disarm() {
      generation += 1;
    },
  };
}

function stallError(filmId: string, what: string): FilmRenderError {
  return new FilmRenderError({
    filmId,
    rule: 'render',
    detail: `${what} did not render within ${String(STALL_SECONDS)} s`,
  });
}

/**
 * Runs one render call under the stall deadline, cancelling it and naming `what`
 * when it stalls; a call that renders many frames re-arms the deadline with
 * `progressed` as each one lands.
 */
async function beforeStall<T>(
  filmId: string,
  what: string,
  run: (cancelSignal: CancelSignal, progressed: () => void) => Promise<T>
): Promise<T> {
  const { cancelSignal, cancel } = makeCancelSignal();
  const state: { stall: FilmRenderError | null } = { stall: null };
  const watch = stallWatch(() => {
    state.stall = stallError(filmId, what);
    cancel();
  });
  watch.arm();
  try {
    return await run(cancelSignal, watch.arm);
  } catch (error) {
    throw (
      state.stall ??
      new FilmRenderError(
        { filmId, rule: 'render', detail: `${what}: ${messageOf(error)}` },
        { cause: error }
      )
    );
  } finally {
    watch.disarm();
  }
}

async function composition(
  film: LoadedFilm,
  browser: HeadlessBrowser,
  { serveUrl, gl, options }: { serveUrl: string; gl: OpenGlRenderer; options: StillOptions }
): ReturnType<typeof selectComposition> {
  try {
    return await selectComposition({
      serveUrl,
      id: film.id,
      inputProps: options.inputProps ?? {},
      puppeteerInstance: browser,
      chromiumOptions: { gl },
      timeoutInMilliseconds: REMOTION_TIMEOUT_MS,
      logLevel: 'warn',
      onBrowserLog: browserLog(options),
    });
  } catch (error) {
    throw new FilmRenderError(
      { filmId: film.id, rule: 'composition', detail: messageOf(error) },
      { cause: error }
    );
  }
}

/** What every pass of one render call renders with: one bundle and one browser. */
interface RenderSession {
  film: LoadedFilm;
  browser: HeadlessBrowser;
  serveUrl: string;
  gl: OpenGlRenderer;
}

type SelectedComposition = Awaited<ReturnType<typeof selectComposition>>;

/** One still on a fresh page. */
interface FreshStill {
  frame: number;
  /** Where the PNG is written; null keeps only the page's console lines. */
  output: string | null;
  options: StillOptions;
  /** What the stall deadline names. */
  what: string;
}

/** Renders one still on a fresh page under the stall deadline. */
async function freshStill(
  { film, browser, serveUrl, gl }: RenderSession,
  selected: SelectedComposition,
  { frame, output, options, what }: FreshStill
): Promise<void> {
  await beforeStall(film.id, what, async (cancelSignal) =>
    renderStill({
      composition: selected,
      serveUrl,
      frame,
      output,
      imageFormat: 'png',
      overwrite: true,
      inputProps: options.inputProps ?? {},
      puppeteerInstance: browser,
      chromiumOptions: { gl },
      timeoutInMilliseconds: REMOTION_TIMEOUT_MS,
      cancelSignal,
      logLevel: 'warn',
      onBrowserLog: browserLog(options),
    })
  );
}

/**
 * A POSIX path inside the render's bundle, on disk, where its server serves it.
 * The UI pass writes there, never under the package: every bundle hashes the
 * whole package tree for the root's module discovery, so a file appearing
 * under it while another render bundles fails that bundle.
 */
function bundleFile(serveUrl: string, posix: string): string {
  return path.join(serveUrl, ...posix.split('/'));
}

/** A film drawn by a look module, the only kind with a UI layer. */
function drawnByLook(film: LoadedFilm): boolean {
  return ['look.ts', 'look.js'].some((file) => existsSync(path.join(film.dir, file)));
}

/**
 * Every frame on which the film's look hands its UI layer to the canvas as a
 * texture, as the look host reports them from one probe still.
 */
async function uiTextureFrames(session: RenderSession): Promise<number[]> {
  const { film, browser, serveUrl, gl } = session;
  if (!drawnByLook(film)) {
    return [];
  }
  const plans: number[][] = [];
  const probe: StillOptions = {
    gl,
    inputProps: UI_PLAN_PROPS,
    onBrowserLog: (line) => {
      const plan = readUiPlanLine(line);
      if (plan !== null) {
        plans.push(plan);
      }
    },
  };
  const selected = await composition(film, browser, { serveUrl, gl, options: probe });
  await freshStill(session, selected, {
    frame: 0,
    output: null,
    options: probe,
    what: 'the UI plan',
  });
  const [plan] = plans;
  if (plan === undefined) {
    throw new FilmRenderError({
      filmId: film.id,
      rule: 'ui',
      detail: 'the look host reported no UI plan',
    });
  }
  return plan;
}

/**
 * The UI pass of a video: the UI layer alone on each texture frame, rendered
 * in one tab like the picture's master, run by run of consecutive frames, as
 * lossless full-size PNGs whatever the picture's settings.
 */
async function uiVideoPass(
  { film, browser, serveUrl, gl }: RenderSession,
  frames: readonly number[],
  directory: string
): Promise<void> {
  const options: StillOptions = { gl, inputProps: UI_PASS_PROPS };
  const selected = await composition(film, browser, { serveUrl, gl, options });
  for (const [from, to] of frameRuns(frames)) {
    await beforeStall(
      film.id,
      `the UI of frames ${String(from)} to ${String(to)}`,
      async (cancelSignal, progressed) =>
        renderFrames({
          ...frameSettings(false),
          composition: selected,
          serveUrl,
          frameRange: [from, to],
          inputProps: UI_PASS_PROPS,
          puppeteerInstance: browser,
          chromiumOptions: { gl },
          muted: true,
          outputDir: null,
          timeoutInMilliseconds: REMOTION_TIMEOUT_MS,
          cancelSignal,
          logLevel: 'warn',
          onStart: () => undefined,
          onFrameUpdate: () => undefined,
          onFrameBuffer: (buffer, frame) => {
            progressed();
            writeFileSync(bundleFile(serveUrl, uiFrameFile(directory, frame)), buffer);
          },
        })
    );
  }
}

/** Where one still of a pass is written, and what its stall deadline names. */
type StillTarget = (frame: number) => { output: string; what: string };

/**
 * Renders each still on a fresh page in descending frame order, the reverse of
 * the one-tab master's, so a picture that follows what the browser process
 * holds differs from the master.
 */
async function renderStills(
  session: RenderSession,
  frames: readonly number[],
  options: StillOptions,
  target: StillTarget
): Promise<void> {
  const { film, browser, serveUrl, gl } = session;
  const selected = await composition(film, browser, { serveUrl, gl, options });
  for (const frame of frames.toSorted((a, b) => b - a)) {
    await freshStill(session, selected, { frame, options, ...target(frame) });
  }
}

/**
 * The UI pass of stills: the UI layer alone on each texture frame, rendered as
 * the stills themselves render.
 */
async function uiStillsPass(
  session: RenderSession,
  frames: readonly number[],
  directory: string
): Promise<void> {
  await renderStills(session, frames, { gl: session.gl, inputProps: UI_PASS_PROPS }, (frame) => ({
    output: bundleFile(session.serveUrl, uiFrameFile(directory, frame)),
    what: `the UI of frame ${String(frame)}`,
  }));
}

/**
 * Runs `use` with the input props the picture renders under. When the film's
 * look hands its UI to the canvas on any of `frames`, a UI pass of `kind` first
 * renders the UI's pixels on those frames into the render's bundle, which is
 * removed with them, and the props point the look host at them.
 */
async function withUiPass<T>(
  render: RenderSession,
  {
    kind,
    frames,
    inputProps,
  }: { kind: 'video' | 'stills'; frames: readonly number[]; inputProps: Record<string, unknown> },
  use: (inputProps: Record<string, unknown>) => Promise<T>
): Promise<T> {
  const wanted = new Set(frames);
  const planned = await uiTextureFrames(render);
  const texture = planned.filter((frame) => wanted.has(frame));
  if (texture.length === 0) {
    return use(inputProps);
  }
  mkdirSync(bundleFile(render.serveUrl, UI_FRAMES_DIRECTORY), { recursive: true });
  await (kind === 'video'
    ? uiVideoPass(render, texture, UI_FRAMES_DIRECTORY)
    : uiStillsPass(render, texture, UI_FRAMES_DIRECTORY));
  return use({ ...inputProps, ...uiFramesProps(UI_FRAMES_DIRECTORY) });
}

/** The still of `frame` in `directory`. */
function stillIn(directory: string, frame: number): string {
  return path.join(directory, `frame-${String(frame).padStart(4, '0')}.png`);
}

/** Where the published still of `frame` is written, in the piece's `out/stills/`. */
export function stillFile(film: LoadedFilm, frame: number): string {
  return stillIn(path.join(film.outDir, 'stills'), frame);
}

/** Each picture still's file in `directory`, and the frame its stall deadline names. */
function pictureStill(directory: string): StillTarget {
  return (frame) => ({ output: stillIn(directory, frame), what: `frame ${String(frame)}` });
}

/**
 * Renders the given frames of a film as PNGs in `options.directory`, or
 * publishes them to `out/stills/` when it is omitted: each is rendered in a run
 * directory and renamed into place, so a reader of `out/stills/` never sees part
 * of one. Returns the files in the order of `frames`.
 */
export async function renderFilmStills(
  filmId: string,
  frames: readonly number[],
  { directory, ...options }: StillsOptions
): Promise<string[]> {
  if (directory !== undefined) {
    return stillsInto(filmId, frames, directory, options);
  }
  const film = loadFilm(filmId);
  const published = path.join(film.outDir, 'stills');
  return withRunDirectory(film, async (run) => {
    const rendered = await stillsInto(filmId, frames, run, options);
    mkdirSync(published, { recursive: true });
    return rendered.map((file) => {
      const target = path.join(published, path.basename(file));
      renameSync(file, target);
      return target;
    });
  });
}

/**
 * Renders the given frames of a film as PNGs in `into`, through one bundle and
 * one browser, each still a fresh page. A fresh page keeps what the browser
 * process holds, so the stills render in descending frame order, the reverse of
 * the one-tab master's, where a picture that follows that state differs from
 * the master. Returns the files in the order of `frames`.
 */
async function stillsInto(
  filmId: string,
  frames: readonly number[],
  into: string,
  options: StillOptions
): Promise<string[]> {
  const film = loadFilm(filmId);
  requireFrames(filmId, frames, film.definition.spec.durationInFrames);
  const gl = glBackend(filmId, options.gl);
  mkdirSync(into, { recursive: true });
  const files = frames.map((frame) => stillIn(into, frame));
  return withFilmBundle(film, async (serveUrl) =>
    withFilmBrowser(filmId, gl, async (browser) => {
      const render: RenderSession = { film, browser, serveUrl, gl };
      return withUiPass(
        render,
        { kind: 'stills', frames, inputProps: options.inputProps ?? {} },
        async (inputProps) => {
          await renderStills(render, frames, { ...options, inputProps }, pictureStill(into));
          return files;
        }
      );
    })
  );
}

interface Encoding {
  film: LoadedFilm;
  browser: HeadlessBrowser;
  serveUrl: string;
  gl: OpenGlRenderer;
  output: string;
  options: VideoOptions;
}

/** The first failure of a video render, from the render, the stall deadline or ffmpeg, stops the rest. */
interface Failures {
  first: FilmRenderError | null;
  fail: (failure: FilmRenderError) => void;
  cancelSignal: CancelSignal;
}

function failures(): Failures {
  const { cancelSignal, cancel } = makeCancelSignal();
  const state: Failures = {
    first: null,
    fail(failure) {
      state.first ??= failure;
      cancel();
    },
    cancelSignal,
  };
  return state;
}

/** Starts the bundled ffmpeg reading frames on its stdin, and records its failure as the render's. */
function startMux(
  film: LoadedFilm,
  { output, draft }: { output: string; draft: boolean },
  failed: Failures
): { stdin: NodeJS.WritableStream; kill: () => void; done: Promise<void> } {
  const encoder = RenderInternals.callFf({
    bin: 'ffmpeg',
    args: muxArguments({
      frameFormat: frameSettings(draft).imageFormat,
      audio: film.definition.score === undefined ? null : masterWavFile(film.id),
      output,
    }),
    indent: false,
    logLevel: 'warn',
    binariesDirectory: null,
    cancelSignal: undefined,
    options: { stdin: 'pipe', stdout: 'ignore', stderr: 'inherit', buffer: false },
  });
  const muxFailure = (error: unknown): FilmRenderError =>
    new FilmRenderError(
      { filmId: film.id, rule: 'mux', detail: `the bundled ffmpeg failed: ${messageOf(error)}` },
      { cause: error }
    );
  const { stdin } = encoder;
  if (stdin === null) {
    throw muxFailure(new Error('it has no stdin'));
  }
  stdin.on('error', (error) => {
    failed.fail(muxFailure(error));
  });
  const done = (async (): Promise<void> => {
    try {
      await encoder;
    } catch (error) {
      failed.fail(muxFailure(error));
    }
  })();
  return {
    stdin,
    kill: () => {
      encoder.kill('SIGKILL');
    },
    done,
  };
}

/** What a video render keeps of each frame as it arrives, and the queue that puts frames on the pipe. */
function frameCollector(
  film: LoadedFilm,
  probeFrames: readonly number[],
  write: (bytes: Uint8Array) => void
): {
  queue: FrameQueue;
  frameSha256: string[];
  probePngs: Map<number, Uint8Array>;
  accept: (buffer: Buffer, frame: number) => void;
} {
  const { durationInFrames } = film.definition.spec;
  const queue = createFrameQueue(durationInFrames, LEAD_FRAMES);
  const keep = new Set(withNeighbours(probeFrames, durationInFrames));
  const frameSha256: string[] = [];
  const probePngs = new Map<number, Uint8Array>();
  return {
    queue,
    frameSha256,
    probePngs,
    accept(buffer, frame) {
      frameSha256[frame] = sha256(buffer);
      if (keep.has(frame)) {
        probePngs.set(frame, new Uint8Array(buffer));
      }
      for (const bytes of queue.accept(frame, buffer)) {
        write(bytes);
      }
    },
  };
}

function progress(filmId: string, total: number): (rendered: number) => void {
  return (rendered) => {
    if (rendered % FPS === 0 || rendered === total) {
      process.stderr.write(`${filmId}: ${String(rendered)} of ${String(total)} frames rendered\n`);
    }
  };
}

/**
 * Renders every frame of the film in order and pipes each to the bundled
 * ffmpeg as it arrives, frame 0 written the lead extra times first, so no
 * frame sequence is written to disk. A stall, a render failure or an ffmpeg
 * failure stops both and removes the partial MP4.
 */
async function encode({
  film,
  browser,
  serveUrl,
  gl,
  output,
  options,
}: Encoding): Promise<RenderedVideo> {
  const { id: filmId } = film;
  const { durationInFrames } = film.definition.spec;
  const selected = await composition(film, browser, { serveUrl, gl, options });
  const failed = failures();
  const mux = startMux(film, { output, draft: options.draft }, failed);
  const frames = frameCollector(film, options.probeFrames, (bytes) => mux.stdin.write(bytes));
  const watch = stallWatch(() => {
    failed.fail(stallError(filmId, `frame ${String(frames.queue.next)}`));
  });
  watch.arm();
  try {
    await renderFrames({
      ...frameSettings(options.draft),
      composition: selected,
      serveUrl,
      inputProps: options.inputProps ?? {},
      puppeteerInstance: browser,
      chromiumOptions: { gl },
      muted: true,
      outputDir: null,
      timeoutInMilliseconds: REMOTION_TIMEOUT_MS,
      cancelSignal: failed.cancelSignal,
      logLevel: 'warn',
      onBrowserLog: browserLog(options),
      onStart: () => undefined,
      onFrameUpdate: progress(filmId, durationInFrames),
      onFrameBuffer: (buffer, frame) => {
        watch.arm();
        frames.accept(buffer, frame);
      },
    });
  } catch (error) {
    const detail = `frame ${String(frames.queue.next)}: ${messageOf(error)}`;
    failed.fail(new FilmRenderError({ filmId, rule: 'render', detail }, { cause: error }));
  } finally {
    watch.disarm();
  }
  if (!frames.queue.complete) {
    const detail = `the render ended at frame ${String(frames.queue.next)} of ${String(durationInFrames)}`;
    failed.fail(new FilmRenderError({ filmId, rule: 'render', detail }));
  }
  if (failed.first === null) {
    mux.stdin.end();
  } else {
    mux.kill();
  }
  await mux.done;
  if (failed.first !== null) {
    rmSync(output, { force: true });
    throw failed.first;
  }
  return { path: output, frameSha256: frames.frameSha256, probePngs: frames.probePngs };
}

/** Renders the film's picture and muxes it into `output`, through one bundle and one browser. */
async function videoInto(
  film: LoadedFilm,
  gl: OpenGlRenderer,
  output: string,
  options: VideoOptions
): Promise<RenderedVideo> {
  const everyFrame = Array.from(
    { length: film.definition.spec.durationInFrames },
    (_, frame) => frame
  );
  return withFilmBundle(film, async (serveUrl) =>
    withFilmBrowser(film.id, gl, async (browser) =>
      withUiPass(
        { film, browser, serveUrl, gl },
        { kind: 'video', frames: everyFrame, inputProps: options.inputProps ?? {} },
        async (inputProps) =>
          encode({ film, browser, serveUrl, gl, output, options: { ...options, inputProps } })
      )
    )
  );
}

/**
 * Renders a film's picture muted and muxes it with its master into
 * `<film-id>.mp4` in `options.directory`, or publishes it to
 * `out/<film-id>.mp4` when that is omitted: one tab, lossless PNG frames and
 * every frame's SHA-256 for the master, or half-size JPEG frames in parallel
 * for a draft. A film with no score is delivered as picture only.
 */
export async function renderFilmVideo(
  filmId: string,
  options: VideoOptions
): Promise<RenderedVideo> {
  const film = loadFilm(filmId);
  if (options.probeFrames.length > 0) {
    requireFrames(filmId, options.probeFrames, film.definition.spec.durationInFrames);
  }
  const gl = glBackend(filmId, options.gl);
  if (film.definition.score !== undefined && !existsSync(masterWavFile(filmId))) {
    throw new FilmRenderError({
      filmId,
      rule: 'mux',
      detail: `the film has no master WAV yet; pnpm films score ${filmId} writes it`,
    });
  }
  const { directory } = options;
  if (directory !== undefined) {
    return videoInto(film, gl, path.join(directory, `${filmId}.mp4`), options);
  }
  return withRunDirectory(film, async (run) => {
    const video = await videoInto(film, gl, path.join(run, `${filmId}.mp4`), options);
    return { ...video, path: publishVideo(film, video.path) };
  });
}
