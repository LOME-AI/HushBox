import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';

import { HOUR_SECONDS, MINUTE_SECONDS } from '@hushbox/shared/durations';

import { PNG_SIGNATURE, parsePng, pngChunkExtents } from './png.js';

const chunk = (type: string, data: Buffer | Uint8Array): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), Buffer.from(data), Buffer.alloc(4)]);
};

const png = (...chunks: readonly Buffer[]): Uint8Array =>
  Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', Buffer.alloc(13)),
    ...chunks,
    chunk('IDAT', Buffer.alloc(8)),
    chunk('IEND', Buffer.alloc(0)),
  ]);

const nul = Buffer.from([0]);

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('parsePng', () => {
  it('reports no region for a file carrying only image chunks', () => {
    expect(parsePng(png())).toEqual([]);
  });

  it('decodes a tEXt keyword and value', () => {
    const [region] = parsePng(
      png(chunk('tEXt', Buffer.concat([Buffer.from('Software'), nul, Buffer.from('SomeTool 1.0')])))
    );
    expect(region?.kind).toBe('png:tEXt');
    expect(region?.text).toContain('Software');
    expect(region?.text).toContain('SomeTool 1.0');
  });

  it('treats a text chunk as an identity carrier', () => {
    const [region] = parsePng(
      png(chunk('tEXt', Buffer.concat([Buffer.from('Author'), nul, Buffer.from('someone')])))
    );
    expect(region?.carriesIdentity).toBe(true);
  });

  it('inflates a zTXt payload', () => {
    const payload = Buffer.concat([
      Buffer.from('Raw profile type iptc'),
      nul,
      Buffer.from([0]),
      deflateSync(Buffer.from('Made with SomeTool')),
    ]);
    const [region] = parsePng(png(chunk('zTXt', payload)));
    expect(region?.kind).toBe('png:zTXt');
    expect(region?.text).toContain('Made with SomeTool');
  });

  it('yields an empty text for an undecodable zTXt payload', () => {
    const payload = Buffer.concat([
      Buffer.from('broken'),
      nul,
      Buffer.from([0]),
      Buffer.from([1, 2, 3, 4]),
    ]);
    const [region] = parsePng(png(chunk('zTXt', payload)));
    expect(region?.text).toBe('broken');
  });

  it('reads an uncompressed iTXt payload', () => {
    const payload = Buffer.concat([
      Buffer.from('XML:com.adobe.xmp'),
      nul,
      Buffer.from([0, 0]),
      nul,
      nul,
      Buffer.from('<x:xmpmeta/>'),
    ]);
    const [region] = parsePng(png(chunk('iTXt', payload)));
    expect(region?.kind).toBe('png:iTXt');
    expect(region?.text).toContain('<x:xmpmeta/>');
  });

  it('inflates a compressed iTXt payload', () => {
    const payload = Buffer.concat([
      Buffer.from('XML:com.adobe.xmp'),
      nul,
      Buffer.from([1, 0]),
      nul,
      nul,
      deflateSync(Buffer.from('<x:xmpmeta compressed/>')),
    ]);
    const [region] = parsePng(png(chunk('iTXt', payload)));
    expect(region?.text).toContain('<x:xmpmeta compressed/>');
  });

  it('decodes a tIME chunk into a UTC instant', () => {
    const time = Buffer.alloc(7);
    time.writeUInt16BE(2026, 0);
    time[2] = 1;
    time[3] = 2;
    time[4] = 3;
    time[5] = 4;
    time[6] = 5;
    const [region] = parsePng(png(chunk('tIME', time)));
    expect(region?.kind).toBe('png:tIME');
    expect(region?.instants[0]?.secondsUtc).toBe(
      Date.UTC(2026, 0, 2) / 1000 + 3 * HOUR_SECONDS + 4 * MINUTE_SECONDS + 5
    );
  });

  it('does not treat a tIME chunk as an identity carrier', () => {
    const [region] = parsePng(png(chunk('tIME', Buffer.alloc(7))));
    expect(region?.carriesIdentity).toBe(false);
  });

  it('ignores a tIME chunk that is too short to decode', () => {
    expect(parsePng(png(chunk('tIME', Buffer.alloc(3))))).toEqual([]);
  });

  it('extracts printable text from an opaque C2PA chunk', () => {
    const body = Buffer.concat([Buffer.alloc(4), Buffer.from('c2pa manifest'), Buffer.alloc(4)]);
    const [region] = parsePng(png(chunk('caBX', body)));
    expect(region?.kind).toBe('png:caBX');
    expect(region?.text).toContain('c2pa manifest');
  });

  it('reports an eXIf chunk', () => {
    const [region] = parsePng(png(chunk('eXIf', Buffer.alloc(16))));
    expect(region?.kind).toBe('png:eXIf');
  });

  it('locates the region at its chunk offset and full length', () => {
    const textChunk = chunk(
      'tEXt',
      Buffer.concat([Buffer.from('Software'), nul, Buffer.from('x')])
    );
    const [region] = parsePng(png(textChunk));
    expect(region?.offset).toBe(PNG_SIGNATURE.length + 25);
    expect(region?.length).toBe(textChunk.length);
  });

  it('stops at a chunk whose declared length overruns the buffer', () => {
    const overrun = Buffer.concat([Buffer.from([0, 0, 0, 200]), Buffer.from('tEXt'), nul]);
    const bytes = Buffer.concat([Buffer.from(PNG_SIGNATURE), overrun]);
    expect(refusals(parsePng(bytes))).toBe(1);
  });

  it('reads no chunk past the end marker', () => {
    const trailing = chunk('tEXt', Buffer.concat([Buffer.from('Software'), nul, Buffer.from('x')]));
    const regions = parsePng(Buffer.concat([png(), trailing]));
    expect(regions.filter((region) => region.malformed === undefined)).toEqual([]);
  });

  it('reports a chunk appended past the end marker as unaccounted', () => {
    const trailing = chunk('tEXt', Buffer.concat([Buffer.from('Software'), nul, Buffer.from('x')]));
    const regions = parsePng(Buffer.concat([png(), trailing]));
    expect(refusals(regions)).toBe(1);
    expect(regions[0]?.kind).toBe('png:trailing');
  });

  it('reports a whole second image appended to a clean one', () => {
    const regions = parsePng(Buffer.concat([png(), png()]));
    expect(regions[0]?.kind).toBe('png:trailing');
  });

  it('reports a residue that carries no end marker of its own', () => {
    const regions = parsePng(Buffer.concat([png(), Buffer.alloc(5)]));
    expect(refusals(regions)).toBe(1);
  });

  it('falls back to the raw payload for a text chunk with no keyword separator', () => {
    const [region] = parsePng(png(chunk('tEXt', Buffer.from('no separator here'))));
    expect(region?.text).toBe('no separator here');
  });

  it('keeps only the keyword when an iTXt language tag is unterminated', () => {
    const payload = Buffer.concat([
      Buffer.from('XML:com.adobe.xmp'),
      nul,
      Buffer.from([0, 0]),
      Buffer.from('en'),
    ]);
    const [region] = parsePng(png(chunk('iTXt', payload)));
    expect(region?.text).toBe('XML:com.adobe.xmp');
  });

  it('keeps only the keyword when an iTXt translated keyword is unterminated', () => {
    const payload = Buffer.concat([
      Buffer.from('XML:com.adobe.xmp'),
      nul,
      Buffer.from([0, 0]),
      nul,
      Buffer.from('translated'),
    ]);
    const [region] = parsePng(png(chunk('iTXt', payload)));
    expect(region?.text).toBe('XML:com.adobe.xmp');
  });
});

describe('pngChunkExtents', () => {
  it('reports every chunk in the stream once, in order', () => {
    expect(pngChunkExtents(png()).chunks.map((entry) => entry.type)).toEqual([
      'IHDR',
      'IDAT',
      'IEND',
    ]);
  });

  it('gives a chunk the offset and length the parser reports for its region', () => {
    const textChunk = chunk(
      'tEXt',
      Buffer.concat([Buffer.from('Software'), nul, Buffer.from('x')])
    );
    const bytes = png(textChunk);
    const extent = pngChunkExtents(bytes).chunks.find((entry) => entry.type === 'tEXt');
    const [region] = parsePng(bytes);
    expect(extent?.offset).toBe(region?.offset);
    expect(extent?.length).toBe(region?.length);
  });

  it('addresses a chunk payload as the range the parser decodes', () => {
    const payload = Buffer.concat([Buffer.from('Software'), nul, Buffer.from('x')]);
    const extent = pngChunkExtents(png(chunk('tEXt', payload))).chunks.find(
      (entry) => entry.type === 'tEXt'
    );
    expect(extent?.dataEnd).toBe((extent?.dataStart ?? 0) + payload.length);
  });

  it('marks the walk damaged where the parser refuses the framing', () => {
    const overrun = Buffer.concat([Buffer.from([0, 0, 0, 200]), Buffer.from('tEXt'), nul]);
    const bytes = Buffer.concat([Buffer.from(PNG_SIGNATURE), overrun]);
    expect(pngChunkExtents(bytes)).toMatchObject({ damaged: true, unaccounted: overrun.length });
  });

  it('counts bytes past the end marker as unaccounted rather than as damage', () => {
    const residue = Buffer.alloc(5);
    const walk = pngChunkExtents(Buffer.concat([png(), residue]));
    expect(walk).toMatchObject({ damaged: false, unaccounted: residue.length });
  });

  it('accounts for the whole blob when the stream ends at the end marker', () => {
    expect(pngChunkExtents(png())).toMatchObject({ damaged: false, unaccounted: 0 });
  });
});

/**
 * A chunk the framing declares but this gate's enumeration does not name was
 * read by nothing. The remedy reconciles the byte space rather than lengthening
 * the list of chunk types worth reading — a list only ever covers the carriers
 * somebody thought of.
 */
describe('parsePng — a declared chunk no rule names is still read', () => {
  const disclosure = ['', 'home', 'someone', 'render'].join('/');

  it('reads a private chunk for values', () => {
    const bytes = png(chunk('prVt', Buffer.from(disclosure, 'latin1')));
    expect(
      parsePng(bytes)
        .map((region) => region.text)
        .join('\n')
    ).toContain(disclosure);
  });

  it('does not report a private chunk that carries nothing', () => {
    expect(parsePng(png(chunk('prVt', Buffer.alloc(16))))).toEqual([]);
  });

  it('leaves the image chunks alone', () => {
    expect(parsePng(png(chunk('IDAT', Buffer.from(disclosure, 'latin1'))))).toEqual([]);
  });

  it('reports an unrecognised ancillary chunk under the skippable kind', () => {
    const [region] = parsePng(png(chunk('prVt', Buffer.from(disclosure, 'latin1'))));
    expect(region?.kind).toBe('png:unnamed');
  });

  it('reports an unrecognised critical chunk under a kind of its own', () => {
    const [region] = parsePng(png(chunk('PrVt', Buffer.from(disclosure, 'latin1'))));
    expect(region?.kind).toBe('png:unnamed-critical');
  });

  it('still reads a critical chunk for values', () => {
    const bytes = png(chunk('PrVt', Buffer.from(disclosure, 'latin1')));
    expect(
      parsePng(bytes)
        .map((region) => region.text)
        .join('\n')
    ).toContain(disclosure);
  });

  it('does not report a critical chunk that carries nothing', () => {
    expect(parsePng(png(chunk('PrVt', Buffer.alloc(16))))).toEqual([]);
  });
});
