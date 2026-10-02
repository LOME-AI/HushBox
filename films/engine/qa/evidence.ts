import { z } from 'zod';

/** The video stream as ffprobe reports it; an absent colour tag reads `unknown`. */
export interface StreamProbe {
  width: number;
  height: number;
  pixFmt: string;
  colorPrimaries: string;
  colorTransfer: string;
  colorSpace: string;
  colorRange: string;
}

const tag = z.string().default('unknown');

const probeSchema = z.object({
  streams: z.array(
    z.object({
      width: z.int(),
      height: z.int(),
      pix_fmt: z.string(),
      color_primaries: tag,
      color_transfer: tag,
      color_space: tag,
      color_range: tag,
    })
  ),
});

/** ffprobe's JSON for the video stream, read into the fields the final-file rules check. */
export function parseStreamProbe(json: string): StreamProbe {
  const [stream] = probeSchema.parse(JSON.parse(json)).streams;
  if (stream === undefined) {
    throw new RangeError('ffprobe found no video stream in the delivered MP4');
  }
  return {
    width: stream.width,
    height: stream.height,
    pixFmt: stream.pix_fmt,
    colorPrimaries: stream.color_primaries,
    colorTransfer: stream.color_transfer,
    colorSpace: stream.color_space,
    colorRange: stream.color_range,
  };
}

const WHOLE = /^-?\d+$/;

/** ffprobe's packet timestamps, the first field of each line, in presentation order. */
export function parsePts(csv: string): number[] {
  return csv
    .split('\n')
    .map((line) => line.replace(/,.*/, '').trim())
    .filter((line) => line !== '')
    .map((line) => {
      if (!WHOLE.test(line)) {
        throw new RangeError(
          `ffprobe gave a packet timestamp ${JSON.stringify(line)} that is not a whole number`
        );
      }
      return Number(line);
    })
    .toSorted((a, b) => a - b);
}

/** Cuts a byte stream of fixed-size frames into frames, whatever the chunk boundaries, copying each byte once. */
export function createFrameSplitter(frameBytes: number): {
  push: (chunk: Uint8Array) => Uint8Array[];
  pending: () => number;
} {
  let frame = new Uint8Array(frameBytes);
  let filled = 0;
  return {
    push(chunk) {
      const frames: Uint8Array[] = [];
      let offset = 0;
      while (offset < chunk.length) {
        const taken = Math.min(frameBytes - filled, chunk.length - offset);
        frame.set(chunk.subarray(offset, offset + taken), filled);
        filled += taken;
        offset += taken;
        if (filled === frameBytes) {
          frames.push(frame);
          frame = new Uint8Array(frameBytes);
          filled = 0;
        }
      }
      return frames;
    },
    pending: () => filled,
  };
}

/**
 * Each placement of a percussive track on a cue, with the cue's frame: the
 * onsets whose presentation time must select the frame of their cue. A cue on
 * the film's end names no frame of the film and adds none.
 */
export function cueOnsets(
  placements: readonly { track: string; cueId: string | null; sample: number }[],
  cues: readonly { id: string; from: number }[],
  percussive: ReadonlySet<string>,
  durationInFrames = Number.POSITIVE_INFINITY
): { cueId: string; frame: number; sample: number }[] {
  return placements.flatMap(({ track, cueId, sample }) => {
    const cue = cues.find(({ id }) => id === cueId);
    if (cue === undefined || !percussive.has(track) || cue.from >= durationInFrames) {
      return [];
    }
    return [{ cueId: cue.id, frame: cue.from, sample }];
  });
}
