import { closeSync, mkdirSync, openSync, readFileSync, readSync } from 'node:fs';
import path from 'node:path';

import { RenderInternals } from '@remotion/renderer';
import sharp from 'sharp';

import { decodeWav24 } from '../audio/dsp/index.js';
import { FilmRenderError } from '../render/film-error.js';
import { HEIGHT, WIDTH } from '../time/grid.js';

import {
  decodeAudioArguments,
  decodeFramesArguments,
  packetPtsArguments,
  referenceLumaArguments,
  streamProbeArguments,
} from './decode-args.js';
import { createFrameSplitter, parsePts, parseStreamProbe } from './evidence.js';
import { boxHeader } from './mp4-boxes.js';

import type { StereoBuffer } from '../audio/dsp/index.js';
import type { StreamProbe } from './evidence.js';
import type { Raster } from './raster.js';

/** Bytes of one decoded yuv420p frame: a full-size luma plane and two quarter-size chroma planes. */
export const YUV_FRAME_BYTES = (WIDTH * HEIGHT * 3) / 2;
/** Bytes of one decoded RGB frame. */
export const RGB_FRAME_BYTES = WIDTH * HEIGHT * 3;
/** Bytes of a frame's luma plane, the first plane of a yuv420p frame. */
export const LUMA_BYTES = WIDTH * HEIGHT;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodeError(filmId: string, detail: string, cause?: unknown): FilmRenderError {
  return new FilmRenderError(
    { filmId, rule: 'decode', detail },
    cause === undefined ? undefined : { cause }
  );
}

async function ffprobe(filmId: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await RenderInternals.callFf({
      bin: 'ffprobe',
      args,
      indent: false,
      logLevel: 'error',
      binariesDirectory: null,
      cancelSignal: undefined,
    });
    return stdout;
  } catch (error) {
    throw decodeError(filmId, `the bundled ffprobe failed: ${messageOf(error)}`, error);
  }
}

/** The delivered video stream's size, pixel format and colour tags. */
export async function probeStream(filmId: string, file: string): Promise<StreamProbe> {
  return parseStreamProbe(await ffprobe(filmId, streamProbeArguments(file)));
}

/** One stream's packet timestamps in presentation order, with edit lists honoured or ignored. */
export async function packetPts(
  filmId: string,
  file: string,
  stream: 'v' | 'a',
  ignoreEditLists: boolean
): Promise<number[]> {
  return parsePts(await ffprobe(filmId, packetPtsArguments(file, stream, ignoreEditLists)));
}

/** The delivered audio decoded to a 24-bit WAV in `outDir`, with edit lists honoured or ignored. */
export async function decodeAudio(
  filmId: string,
  file: string,
  output: string,
  ignoreEditLists: boolean
): Promise<StereoBuffer> {
  mkdirSync(path.dirname(output), { recursive: true });
  try {
    await RenderInternals.callFf({
      bin: 'ffmpeg',
      args: decodeAudioArguments(file, output, ignoreEditLists),
      indent: false,
      logLevel: 'error',
      binariesDirectory: null,
      cancelSignal: undefined,
    });
  } catch (error) {
    throw decodeError(
      filmId,
      `the bundled ffmpeg did not decode the audio: ${messageOf(error)}`,
      error
    );
  }
  return decodeWav24(readFileSync(output));
}

/**
 * Runs the bundled ffmpeg with `args`, writes `input` to its stdin when given,
 * and hands each complete frame of `frameBytes` it writes to stdout to
 * `onFrame` with its index, holding at most one frame at a time. Returns the
 * number of frames.
 */
async function streamFrames(
  filmId: string,
  {
    args,
    frameBytes,
    input,
  }: { args: string[]; frameBytes: number; input?: readonly Uint8Array[] },
  onFrame: (index: number, frame: Uint8Array) => void
): Promise<number> {
  const child = RenderInternals.callFf({
    bin: 'ffmpeg',
    args,
    indent: false,
    logLevel: 'error',
    binariesDirectory: null,
    cancelSignal: undefined,
    options: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe', buffer: false },
  });
  const { stdin, stdout } = child;
  if (stdin === null || stdout === null) {
    child.kill('SIGKILL');
    throw decodeError(filmId, 'the bundled ffmpeg was started without its pipes');
  }
  const stderr: string[] = [];
  child.stderr?.on('data', (chunk: Buffer) => {
    stderr.push(chunk.toString());
  });
  stdin.on('error', () => {
    // A write after ffmpeg has exited fails here; its exit status names the cause.
  });
  for (const bytes of input ?? []) {
    stdin.write(bytes);
  }
  stdin.end();
  const splitter = createFrameSplitter(frameBytes);
  let count = 0;
  const exited = (async (): Promise<unknown> => {
    try {
      await child;
      return null;
    } catch (error) {
      return error;
    }
  })();
  for await (const chunk of stdout) {
    for (const frame of splitter.push(chunk as Uint8Array)) {
      onFrame(count, frame);
      count += 1;
    }
  }
  const failure = await exited;
  if (failure !== null) {
    throw decodeError(
      filmId,
      `the bundled ffmpeg failed: ${messageOf(failure)} ${stderr.join('').trim()}`,
      failure
    );
  }
  if (splitter.pending() !== 0) {
    throw decodeError(
      filmId,
      `the bundled ffmpeg ended mid-frame, ${String(splitter.pending())} bytes into frame ${String(count)}`
    );
  }
  return count;
}

/** Hands every decoded frame of the delivered MP4 to `onFrame`: the stored yuv420p planes, or RGB as the stream is tagged. */
export async function forEachDecodedFrame(
  filmId: string,
  file: string,
  pixels: 'yuv420p' | 'rgb24',
  onFrame: (index: number, frame: Uint8Array) => void
): Promise<number> {
  const frameBytes = pixels === 'yuv420p' ? YUV_FRAME_BYTES : RGB_FRAME_BYTES;
  return streamFrames(filmId, { args: decodeFramesArguments(file, pixels), frameBytes }, onFrame);
}

/** The luma plane of each PNG, converted through the delivery's own conversion, in the order given. */
export async function referenceLuma(
  filmId: string,
  pngs: readonly Uint8Array[]
): Promise<Uint8Array[]> {
  const planes: Uint8Array[] = [];
  const count = await streamFrames(
    filmId,
    { args: referenceLumaArguments(), frameBytes: YUV_FRAME_BYTES, input: pngs },
    (_, frame) => {
      planes.push(frame.slice(0, LUMA_BYTES));
    }
  );
  if (count !== pngs.length) {
    throw decodeError(filmId, `${String(pngs.length)} PNGs converted to ${String(count)} frames`);
  }
  return planes;
}

/** A PNG's pixels, as 8-bit channels. */
export async function decodePng(filmId: string, png: Uint8Array): Promise<Raster> {
  try {
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    if (info.channels !== 3 && info.channels !== 4) {
      throw new RangeError(`a PNG of ${String(info.channels)} channels is not RGB`);
    }
    return {
      width: info.width,
      height: info.height,
      channels: info.channels,
      data: new Uint8Array(data),
    };
  } catch (error) {
    throw decodeError(filmId, `a PNG did not decode: ${messageOf(error)}`, error);
  }
}

/** The MP4's `moov` box, header included, read without loading the media data. */
export function readMoov(filmId: string, file: string): Uint8Array {
  const handle = openSync(file, 'r');
  try {
    const header = new Uint8Array(16);
    let offset = 0;
    for (;;) {
      const read = readSync(handle, header, 0, header.length, offset);
      if (read < 8) {
        throw decodeError(filmId, `${path.basename(file)} holds no moov box`);
      }
      const { size, type } = boxHeader(header.subarray(0, read), 0);
      if (type === 'moov') {
        const moov = new Uint8Array(size);
        readSync(handle, moov, 0, size, offset);
        return moov;
      }
      offset += size;
    }
  } finally {
    closeSync(handle);
  }
}
