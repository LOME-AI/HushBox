import { deliveryConversionFilter } from '../render/ffmpeg-args.js';

/**
 * Y′CbCr → RGB as the stream's own tags say: the scale filter reads the matrix
 * and range from each frame, so a delivery tagged wrong decodes wrong here, and
 * the colour check against the stills sees it. The scaler rounds accurately: its
 * default rounding misreads dark colours by 1-3 levels, depending on the colour,
 * so the colour check would measure its own decoder rather than the delivery.
 */
export const AS_TAGGED_RGB_FILTER =
  // eslint-disable-next-line no-secrets/no-secrets -- an ffmpeg filter graph, not a credential; its option names score high on character entropy
  'scale=in_color_matrix=auto:in_range=auto:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24';

const QUIET = ['-hide_banner', '-loglevel', 'error'];
/** The mov demuxer's option to read the file's samples on their own timeline, as a reader blind to edit lists does. */
// eslint-disable-next-line no-secrets/no-secrets -- ffmpeg's mov demuxer option name, not a credential; its `re_` tail matches the Resend key pattern
export const IGNORE_EDIT_LISTS = ['-ignore_editlist', '1'] as const;

/** ffprobe's arguments for the video stream's size, pixel format and colour tags, as JSON. */
export function streamProbeArguments(file: string): string[] {
  return [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height,pix_fmt,color_primaries,color_transfer,color_space,color_range',
    '-of',
    'json',
    file,
  ];
}

/** ffprobe's arguments for one stream's packet timestamps, one per line, in its time base. */
export function packetPtsArguments(
  file: string,
  stream: 'v' | 'a',
  ignoreEditLists: boolean
): string[] {
  return [
    '-v',
    'error',
    ...(ignoreEditLists ? IGNORE_EDIT_LISTS : []),
    '-select_streams',
    `${stream}:0`,
    '-show_entries',
    'packet=pts',
    '-of',
    'csv=p=0',
    file,
  ];
}

/** ffmpeg's arguments to decode the delivered audio to a 24-bit WAV with no metadata chunk. */
export function decodeAudioArguments(
  file: string,
  output: string,
  ignoreEditLists: boolean
): string[] {
  return [
    ...QUIET,
    ...(ignoreEditLists ? IGNORE_EDIT_LISTS : []),
    '-i',
    file,
    '-map',
    '0:a:0',
    '-c:a',
    'pcm_s24le',
    '-map_metadata',
    '-1',
    '-fflags',
    '+bitexact',
    '-f',
    'wav',
    '-y',
    output,
  ];
}

/** ffmpeg's arguments to write every decoded frame to stdout: the stored yuv420p planes, or RGB as tagged. */
export function decodeFramesArguments(file: string, pixels: 'yuv420p' | 'rgb24'): string[] {
  const conversion = pixels === 'yuv420p' ? ['-pix_fmt', 'yuv420p'] : ['-vf', AS_TAGGED_RGB_FILTER];
  return [
    ...QUIET,
    '-i',
    file,
    '-map',
    '0:v:0',
    ...conversion,
    '-f',
    'image2pipe',
    '-c:v',
    'rawvideo',
    'pipe:1',
  ];
}

/** ffmpeg's arguments to convert PNGs on stdin through the delivery's own conversion to raw yuv420p frames on stdout. */
export function referenceLumaArguments(): string[] {
  return [
    ...QUIET,
    '-f',
    'image2pipe',
    '-c:v',
    'png',
    '-i',
    'pipe:0',
    '-vf',
    deliveryConversionFilter(),
    '-f',
    'image2pipe',
    '-c:v',
    'rawvideo',
    'pipe:1',
  ];
}
