import { describe, expect, it } from 'vitest';

import { deliveryConversionFilter } from '../render/ffmpeg-args.js';
import {
  AS_TAGGED_RGB_FILTER,
  IGNORE_EDIT_LISTS,
  decodeAudioArguments,
  decodeFramesArguments,
  packetPtsArguments,
  referenceLumaArguments,
  streamProbeArguments,
} from './decode-args.js';

describe('streamProbeArguments', () => {
  it('asks ffprobe for the video stream fields the final-file rules read, as JSON', () => {
    expect(streamProbeArguments('film.mp4')).toEqual([
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'stream=width,height,pix_fmt,color_primaries,color_transfer,color_space,color_range',
      '-of',
      'json',
      'film.mp4',
    ]);
  });
});

describe('packetPtsArguments', () => {
  it('lists the packet timestamps of one stream', () => {
    expect(packetPtsArguments('film.mp4', 'a', false)).toEqual([
      '-v',
      'error',
      '-select_streams',
      'a:0',
      '-show_entries',
      'packet=pts',
      '-of',
      'csv=p=0',
      'film.mp4',
    ]);
  });

  it('tells the demuxer to ignore edit lists before the input when asked', () => {
    expect(packetPtsArguments('film.mp4', 'v', true).slice(0, 4)).toEqual([
      '-v',
      'error',
      ...IGNORE_EDIT_LISTS,
    ]);
  });
});

describe('decodeAudioArguments', () => {
  it('decodes the audio to a 24-bit WAV with no metadata', () => {
    expect(decodeAudioArguments('film.mp4', 'out.wav', false)).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'film.mp4',
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
      'out.wav',
    ]);
  });

  it('tells the demuxer to ignore edit lists before the input when asked', () => {
    const args = decodeAudioArguments('film.mp4', 'out.wav', true);

    expect(args.slice(args.indexOf(IGNORE_EDIT_LISTS[0]), args.indexOf('-i'))).toEqual(
      IGNORE_EDIT_LISTS
    );
  });
});

describe('IGNORE_EDIT_LISTS', () => {
  it('is the mov demuxer option that ignores edit lists, switched on', () => {
    // eslint-disable-next-line no-secrets/no-secrets -- ffmpeg's mov demuxer option name, not a credential; its `re_` tail matches the Resend key pattern
    expect(IGNORE_EDIT_LISTS).toEqual(['-ignore_editlist', '1']);
  });
});

describe('decodeFramesArguments', () => {
  it('writes each frame to stdout as raw yuv420p planes, unconverted', () => {
    expect(decodeFramesArguments('film.mp4', 'yuv420p')).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'film.mp4',
      '-map',
      '0:v:0',
      '-pix_fmt',
      'yuv420p',
      '-f',
      'image2pipe',
      '-c:v',
      'rawvideo',
      'pipe:1',
    ]);
  });

  it('converts to RGB as the stream is tagged', () => {
    expect(decodeFramesArguments('film.mp4', 'rgb24')).toContain(AS_TAGGED_RGB_FILTER);
  });

  it('reads the tags rather than naming a matrix, rounding accurately', () => {
    expect(AS_TAGGED_RGB_FILTER).toBe(
      // eslint-disable-next-line no-secrets/no-secrets -- an ffmpeg filter graph, not a credential; its option names score high on character entropy
      'scale=in_color_matrix=auto:in_range=auto:flags=bicubic+accurate_rnd+full_chroma_int,format=rgb24'
    );
  });
});

describe('referenceLumaArguments', () => {
  it('converts PNGs from stdin through the delivery filter to raw frames on stdout', () => {
    expect(referenceLumaArguments()).toEqual([
      '-hide_banner',
      '-loglevel',
      'error',
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
    ]);
  });
});
