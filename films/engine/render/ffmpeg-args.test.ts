import { describe, expect, it } from 'vitest';

import { FPS } from '../time/grid.js';

import { PAD_SAMPLES } from './delivery-timing.js';
import { deliveryConversionFilter, muxArguments } from './ffmpeg-args.js';

import type { MuxOptions } from './ffmpeg-args.js';

const WITH_AUDIO: MuxOptions = {
  frameFormat: 'png',
  audio: 'public/engine-render/master.wav',
  output: 'out/engine-render.mp4',
};

const PICTURE_ONLY: MuxOptions = { ...WITH_AUDIO, audio: null };

/** The value that follows each occurrence of `flag`, in order. */
function valuesOf(args: readonly string[], flag: string): string[] {
  return args.flatMap((argument, index) =>
    argument === flag ? [args[index + 1] ?? '<missing>'] : []
  );
}

/** The one value that follows `flag`; fails the test when the flag is absent or repeated. */
function valueOf(args: readonly string[], flag: string): string {
  const values = valuesOf(args, flag);
  expect(values, `${flag} occurs once`).toHaveLength(1);
  return values[0] ?? '';
}

/** The arguments before the first `-i`, which apply to the frame pipe. */
function frameInputOptions(args: readonly string[]): string[] {
  return args.slice(0, args.indexOf('-i'));
}

describe('deliveryConversionFilter', () => {
  it('scales with the BT.709 matrix into limited range', () => {
    const [scale] = deliveryConversionFilter().split(',');

    expect(scale?.split(':')).toEqual(['scale=out_color_matrix=bt709', 'out_range=tv']);
  });

  it('converts to 4:2:0 after scaling', () => {
    expect(deliveryConversionFilter().split(',')[1]).toBe('format=yuv420p');
  });

  it('holds nothing but the scale and the format', () => {
    expect(deliveryConversionFilter().split(',')).toHaveLength(2);
  });
});

describe('muxArguments', () => {
  it('reads the frames from the pipe on stdin', () => {
    expect(valuesOf(muxArguments(WITH_AUDIO), '-i')[0]).toBe('pipe:0');
  });

  it('reads the pipe as a sequence of images', () => {
    expect(valueOf(frameInputOptions(muxArguments(WITH_AUDIO)), '-f')).toBe('image2pipe');
  });

  it('reads the pipe at the film frame rate', () => {
    expect(valueOf(frameInputOptions(muxArguments(WITH_AUDIO)), '-framerate')).toBe(String(FPS));
  });

  it('decodes PNG frames as PNG', () => {
    expect(valueOf(frameInputOptions(muxArguments(WITH_AUDIO)), '-c:v')).toBe('png');
  });

  it('decodes JPEG frames as Motion JPEG', () => {
    const args = muxArguments({ ...WITH_AUDIO, frameFormat: 'jpeg' });

    expect(valueOf(frameInputOptions(args), '-c:v')).toBe('mjpeg');
  });

  it('reads the master as the second input', () => {
    expect(valuesOf(muxArguments(WITH_AUDIO), '-i')[1]).toBe(WITH_AUDIO.audio);
  });

  it('declares the master stereo, so the demuxer has no layout to guess', () => {
    const args = muxArguments(WITH_AUDIO);
    const masterInput = args.lastIndexOf('-i');

    expect(args.slice(masterInput - 2, masterInput)).toEqual(['-ch_layout', 'stereo']);
  });

  it('maps the picture from the pipe and the sound from the master', () => {
    expect(valuesOf(muxArguments(WITH_AUDIO), '-map')).toEqual(['0:v:0', '1:a:0']);
  });

  it('converts the picture through the delivery conversion filter', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-vf')).toBe(deliveryConversionFilter());
  });

  it('encodes H.264 with libx264', () => {
    const args = muxArguments(WITH_AUDIO);

    expect(valuesOf(args, '-c:v').at(-1)).toBe('libx264');
  });

  it('encodes at High profile', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-profile:v')).toBe('high');
  });

  it('encodes at CRF 17', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-crf')).toBe('17');
  });

  it('encodes at preset medium', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-preset')).toBe('medium');
  });

  it('encodes without B-frames', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-bf')).toBe('0');
  });

  it('pins the encoder to eight threads', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-threads')).toBe('8');
  });

  it('tags BT.709 primaries, transfer and matrix in the H.264 stream', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-x264-params')).toBe(
      'colorprim=bt709:transfer=bt709:colormatrix=bt709'
    );
  });

  it('tags limited range', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-color_range')).toBe('tv');
  });

  it('pads the master by the pad samples in every channel', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-af')).toBe(`adelay=${String(PAD_SAMPLES)}S:all=1`);
  });

  it('encodes the sound with the native AAC encoder', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-c:a')).toBe('aac');
  });

  it('encodes the sound at 320 kb/s', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-b:a')).toBe('320k');
  });

  it('writes no edit list', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-use_editlist')).toBe('0');
  });

  it('leaves the timestamps unshifted', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-avoid_negative_ts')).toBe('disabled');
  });

  it('moves the index to the front of the file', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-movflags')).toBe('+faststart');
  });

  it('keeps warnings visible and hides the rest of the log', () => {
    expect(valueOf(muxArguments(WITH_AUDIO), '-loglevel')).toBe('warning');
  });

  it('overwrites the output, named last', () => {
    expect(muxArguments(WITH_AUDIO).slice(-2)).toEqual(['-y', WITH_AUDIO.output]);
  });

  it('reads no second input for a film with no score', () => {
    expect(valuesOf(muxArguments(PICTURE_ONLY), '-i')).toEqual(['pipe:0']);
  });

  it('maps only the picture for a film with no score', () => {
    expect(valuesOf(muxArguments(PICTURE_ONLY), '-map')).toEqual(['0:v:0']);
  });

  it('encodes no sound for a film with no score', () => {
    const args = muxArguments(PICTURE_ONLY);

    expect([...valuesOf(args, '-af'), ...valuesOf(args, '-c:a')]).toEqual([]);
  });
});
