import { describe, expect, it } from 'vitest';

import { matchesGif, parseGif } from './gif.js';

const subBlocks = (payload: string): Buffer => {
  const bytes = Buffer.from(payload, 'latin1');
  return Buffer.concat([Buffer.from([bytes.length]), bytes, Buffer.from([0])]);
};

const screenDescriptor = (globalTableBits = 0): Buffer => {
  const descriptor = Buffer.alloc(7);
  descriptor[4] = globalTableBits === 0 ? 0 : 0x80 | (globalTableBits - 1);
  return descriptor;
};

const gif = (body: Buffer, globalTableBits = 0): Buffer =>
  Buffer.concat([
    Buffer.from('GIF89a', 'latin1'),
    screenDescriptor(globalTableBits),
    Buffer.alloc(globalTableBits === 0 ? 0 : 3 * (1 << globalTableBits)),
    body,
    Buffer.from([0x3b]),
  ]);

const imageBlock = (): Buffer =>
  Buffer.concat([Buffer.from([0x2c]), Buffer.alloc(9), Buffer.from([2]), subBlocks('ab')]);

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('matchesGif', () => {
  it('matches the GIF89a signature', () => {
    expect(matchesGif(Buffer.from('GIF89a', 'latin1'))).toBe(true);
  });

  it('matches the GIF87a signature', () => {
    expect(matchesGif(Buffer.from('GIF87a', 'latin1'))).toBe(true);
  });

  it('does not match another container', () => {
    expect(matchesGif(Buffer.from('fLaC', 'latin1'))).toBe(false);
  });
});

describe('parseGif', () => {
  it('reports a comment extension as an identity carrier', () => {
    const body = Buffer.concat([Buffer.from([0x21, 0xfe]), subBlocks('made with SomeTool')]);
    const [region] = parseGif(gif(body));
    expect(region?.kind).toBe('gif:comment');
    expect(region?.carriesIdentity).toBe(true);
    expect(region?.text).toContain('made with SomeTool');
  });

  it('reports a plain-text extension', () => {
    const body = Buffer.concat([Buffer.from([0x21, 0x01]), Buffer.alloc(13), subBlocks('shown')]);
    expect(parseGif(gif(body))[0]?.kind).toBe('gif:plain-text');
  });

  it('reports an application extension without calling it an identity carrier', () => {
    const body = Buffer.concat([
      Buffer.from([0x21, 0xff, 11]),
      Buffer.from('NETSCAPE2.0', 'latin1'),
      subBlocks('loop'),
    ]);
    const [region] = parseGif(gif(body));
    expect(region?.kind).toBe('gif:application');
    expect(region?.carriesIdentity).toBe(false);
    expect(region?.text).toContain('NETSCAPE2.0');
  });

  it('reports no region for a graphic-control extension', () => {
    const body = Buffer.concat([Buffer.from([0x21, 0xf9, 4]), Buffer.alloc(4), Buffer.from([0])]);
    expect(parseGif(gif(body))).toEqual([]);
  });

  it('finds a comment that follows the image data', () => {
    const body = Buffer.concat([
      imageBlock(),
      Buffer.from([0x21, 0xfe]),
      subBlocks('trailing note'),
    ]);
    expect(parseGif(gif(body))[0]?.text).toContain('trailing note');
  });

  it('walks past a global colour table', () => {
    const body = Buffer.concat([Buffer.from([0x21, 0xfe]), subBlocks('after the table')]);
    expect(parseGif(gif(body, 3))[0]?.text).toContain('after the table');
  });

  it('walks past a local colour table', () => {
    const descriptor = Buffer.alloc(9);
    descriptor[8] = 0x80 | 2;
    const image = Buffer.concat([
      Buffer.from([0x2c]),
      descriptor,
      Buffer.alloc(3 * 8),
      Buffer.from([2]),
      subBlocks('ab'),
    ]);
    const body = Buffer.concat([image, Buffer.from([0x21, 0xfe]), subBlocks('after the image')]);
    expect(parseGif(gif(body))[0]?.text).toContain('after the image');
  });

  it('reads no block past the trailer', () => {
    const body = Buffer.concat([Buffer.from([0x3b, 0x21, 0xfe]), subBlocks('unreachable')]);
    const regions = parseGif(gif(body));
    expect(regions.filter((region) => region.malformed === undefined)).toEqual([]);
  });

  it('reports bytes appended past the trailer as unaccounted', () => {
    const body = Buffer.concat([Buffer.from([0x3b, 0x21, 0xfe]), subBlocks('unreachable')]);
    const regions = parseGif(gif(body));
    expect(refusals(regions)).toBe(1);
    expect(regions[0]?.kind).toBe('gif:trailing');
  });

  it('stops at an unreadable block introducer', () => {
    expect(refusals(parseGif(gif(Buffer.from([0x7f]))))).toBe(1);
  });

  it('stops at a sub-block chain that runs off the end', () => {
    const body = Buffer.concat([Buffer.from([0x21, 0xfe, 200]), Buffer.alloc(4)]);
    expect(refusals(parseGif(gif(body)))).toBe(1);
  });

  it('stops at an image block whose data runs off the end', () => {
    expect(refusals(parseGif(gif(Buffer.from([0x2c]))))).toBe(1);
  });

  it('reports nothing for a blob too short to carry a screen descriptor', () => {
    expect(refusals(parseGif(Buffer.from('GIF89a', 'latin1')))).toBe(1);
  });

  it('stops at an extension introducer with no label behind it', () => {
    expect(refusals(parseGif(gif(Buffer.from([0x21]))))).toBe(1);
  });
});

/**
 * An extension the framing declares but this gate's enumeration does not name
 * was read by nothing, which is the same blindness a padding box gave a video.
 */
describe('parseGif — a declared extension no rule names is still read', () => {
  const disclosure = ['', 'home', 'someone', 'frame'].join('/');

  it('reads an unregistered extension for values', () => {
    const extension = Buffer.concat([Buffer.from([0x21, 0xf9]), subBlocks(disclosure)]);
    const bytes = gif(Buffer.concat([extension, Buffer.from([0x3b])]));
    expect(
      parseGif(bytes)
        .map((region) => region.text)
        .join('\n')
    ).toContain(disclosure);
  });
});
