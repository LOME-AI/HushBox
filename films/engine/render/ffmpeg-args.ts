import { FPS } from '../time/grid.js';

import { PAD_SAMPLES } from './delivery-timing.js';

export interface MuxOptions {
  /** How each frame on the pipe is encoded: PNG for the master, JPEG for a draft. */
  frameFormat: 'png' | 'jpeg';
  /** The master WAV, or null for a film with no score, which is delivered as picture only. */
  audio: string | null;
  output: string;
}

const FRAME_DECODERS: Record<MuxOptions['frameFormat'], string> = { png: 'png', jpeg: 'mjpeg' };

/**
 * The RGB → Y′CbCr conversion of the delivery: BT.709 matrix, limited range,
 * 4:2:0. Any comparison against the delivered picture converts its reference
 * through this same filter, so the two share one conversion.
 */
export function deliveryConversionFilter(): string {
  const scale = ['out_color_matrix=bt709', 'out_range=tv'].join(':');
  return `scale=${scale},format=yuv420p`;
}

/**
 * The bundled ffmpeg's arguments for the delivered MP4: frames read from stdin,
 * H.264 High at CRF 17 with no B-frames tagged BT.709, the master padded and
 * encoded as AAC, and no edit list on any track. x264's output bytes depend on
 * its thread count, so the count is pinned. The muxer warns that it writes no
 * edit list where one would be required; the log level keeps that visible.
 */
export function muxArguments({ frameFormat, audio, output }: MuxOptions): string[] {
  // The master is stereo by construction; declaring it spares the demuxer a guess and its warning.
  const audioInput = audio === null ? [] : ['-ch_layout', 'stereo', '-i', audio];
  const audioMap = audio === null ? [] : ['-map', '1:a:0'];
  const audioEncode =
    audio === null
      ? []
      : ['-af', `adelay=${String(PAD_SAMPLES)}S:all=1`, '-c:a', 'aac', '-b:a', '320k'];
  return [
    '-hide_banner',
    '-nostats',
    '-loglevel',
    'warning',
    '-f',
    'image2pipe',
    '-framerate',
    String(FPS),
    '-c:v',
    FRAME_DECODERS[frameFormat],
    '-i',
    'pipe:0',
    ...audioInput,
    '-map',
    '0:v:0',
    ...audioMap,
    '-vf',
    deliveryConversionFilter(),
    '-c:v',
    'libx264',
    '-profile:v',
    'high',
    '-preset',
    'medium',
    '-crf',
    '17',
    '-bf',
    '0',
    '-threads',
    '8',
    '-x264-params',
    'colorprim=bt709:transfer=bt709:colormatrix=bt709',
    '-color_range',
    'tv',
    ...audioEncode,
    '-use_editlist',
    '0',
    '-avoid_negative_ts',
    'disabled',
    '-movflags',
    '+faststart',
    '-y',
    output,
  ];
}
