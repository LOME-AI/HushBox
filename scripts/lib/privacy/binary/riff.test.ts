import { describe, expect, it } from 'vitest';

import { matchesRiff, parseRiff } from './riff.js';

const chunk = (id: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.write(id, 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  const padding = body.length % 2 === 0 ? Buffer.alloc(0) : Buffer.alloc(1);
  return Buffer.concat([header, body, padding]);
};

const riff = (...chunks: readonly Buffer[]): Buffer => {
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), ...chunks]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
};

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('matchesRiff', () => {
  it('matches a RIFF container', () => {
    expect(matchesRiff(riff(chunk('fmt ', Buffer.alloc(16))))).toBe(true);
  });

  it('does not match another container', () => {
    expect(matchesRiff(Buffer.from('fLaC', 'latin1'))).toBe(false);
  });

  it('does not match a blob shorter than the signature', () => {
    expect(matchesRiff(Buffer.from('RI', 'latin1'))).toBe(false);
  });
});

describe('parseRiff', () => {
  it('reports no region for a file carrying only format and sample chunks', () => {
    const bytes = riff(chunk('fmt ', Buffer.alloc(16)), chunk('data', Buffer.alloc(64)));
    expect(parseRiff(bytes)).toEqual([]);
  });

  it('reports an INFO list as an identity carrier', () => {
    const info = Buffer.concat([
      Buffer.from('INFO', 'latin1'),
      chunk('ISFT', Buffer.from('SomeTool\0')),
    ]);
    const [region] = parseRiff(riff(chunk('LIST', info)));
    expect(region?.kind).toBe('riff:LIST/INFO');
    expect(region?.carriesIdentity).toBe(true);
    expect(region?.text).toContain('SomeTool');
  });

  it('ignores a list that is not an INFO list', () => {
    const other = Buffer.concat([Buffer.from('adtl', 'latin1'), chunk('labl', Buffer.alloc(8))]);
    expect(parseRiff(riff(chunk('LIST', other)))).toEqual([]);
  });

  it('reports a broadcast-extension chunk', () => {
    const [region] = parseRiff(
      riff(chunk('bext', Buffer.concat([Buffer.alloc(4), Buffer.from('OriginatorRef')])))
    );
    expect(region?.kind).toBe('riff:bext');
    expect(region?.text).toContain('OriginatorRef');
  });

  it('reports an embedded XMP packet', () => {
    const [region] = parseRiff(riff(chunk('_PMX', Buffer.from('<x:xmpmeta/>'))));
    expect(region?.kind).toBe('riff:_PMX');
  });

  it('reports the frames of an embedded ID3 chunk', () => {
    const tagBody = Buffer.concat([
      Buffer.from('TSSE'),
      Buffer.from([0, 0, 0, 9]),
      Buffer.alloc(2),
      Buffer.from('\0SomeTool'),
    ]);
    const tag = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0]),
      Buffer.from([0, 0, 0, tagBody.length]),
      tagBody,
    ]);
    const regions = parseRiff(riff(chunk('id3 ', tag)));
    expect(regions.map((region) => region.kind)).toEqual(['id3:TSSE']);
  });

  it('keeps an embedded tag region at its absolute offset', () => {
    const tagBody = Buffer.concat([
      Buffer.from('TSSE'),
      Buffer.from([0, 0, 0, 9]),
      Buffer.alloc(2),
      Buffer.from('\0SomeTool'),
    ]);
    const tag = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0]),
      Buffer.from([0, 0, 0, tagBody.length]),
      tagBody,
    ]);
    expect(parseRiff(riff(chunk('id3 ', tag)))[0]?.offset).toBe(12 + 8 + 10);
  });

  it('pads an odd-length chunk before reading the next one', () => {
    const bytes = riff(chunk('data', Buffer.alloc(3)), chunk('bext', Buffer.from('OriginatorRef')));
    expect(parseRiff(bytes)[0]?.kind).toBe('riff:bext');
  });

  it('stops at a chunk whose declared length overruns the buffer', () => {
    const overrun = Buffer.alloc(8);
    overrun.write('bext', 0, 'latin1');
    overrun.writeUInt32LE(9999, 4);
    const bytes = Buffer.concat([
      Buffer.from('RIFF', 'latin1'),
      Buffer.alloc(4),
      Buffer.from('WAVE', 'latin1'),
      overrun,
    ]);
    expect(refusals(parseRiff(bytes))).toBe(1);
  });

  it('reports bytes past the declared chunks as unaccounted', () => {
    const bytes = Buffer.concat([riff(chunk('fmt ', Buffer.alloc(16))), Buffer.alloc(5, 0x41)]);
    const regions = parseRiff(bytes);
    expect(refusals(regions)).toBe(1);
    expect(regions[0]?.kind).toBe('riff:trailing');
  });

  it('does not match a form type the gate cannot name', () => {
    const bytes = Buffer.from('RIFF is a chunk format', 'latin1');
    expect(matchesRiff(bytes)).toBe(false);
  });
});

/**
 * A chunk the framing declares but this gate's enumeration does not name was
 * read by nothing. Reconciled rather than enumerated: a longer list of chunk ids
 * only ever covers the carriers somebody thought of.
 */
describe('parseRiff — a declared chunk no rule names is still read', () => {
  const disclosure = ['', 'home', 'someone', 'take'].join('/');

  it('reads an unregistered chunk for values', () => {
    const bytes = riff(chunk('junk', Buffer.from(disclosure, 'latin1')));
    expect(
      parseRiff(bytes)
        .map((region) => region.text)
        .join('\n')
    ).toContain(disclosure);
  });

  it('leaves the sample data to the format that declares it', () => {
    expect(parseRiff(riff(chunk('data', Buffer.from(disclosure, 'latin1'))))).toEqual([]);
  });
});
