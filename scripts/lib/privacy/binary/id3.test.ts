import { describe, expect, it } from 'vitest';

import { id3TagLength, parseId3 } from './id3.js';

const syncsafe = (value: number): Buffer =>
  Buffer.from([(value >>> 21) & 0x7f, (value >>> 14) & 0x7f, (value >>> 7) & 0x7f, value & 0x7f]);

interface FrameSpec {
  readonly id: string;
  readonly body: Buffer;
}

const frame = (spec: FrameSpec, major: number): Buffer => {
  const size = major >= 4 ? syncsafe(spec.body.length) : Buffer.alloc(4);
  if (major < 4) size.writeUInt32BE(spec.body.length);
  return Buffer.concat([Buffer.from(spec.id, 'latin1'), size, Buffer.alloc(2), spec.body]);
};

const tag = (major: number, frames: readonly FrameSpec[], flags = 0, padding = 0): Buffer => {
  const body = Buffer.concat([...frames.map((spec) => frame(spec, major)), Buffer.alloc(padding)]);
  const footer = (flags & 0x10) === 0 ? Buffer.alloc(0) : Buffer.alloc(10);
  return Buffer.concat([
    Buffer.from('ID3', 'latin1'),
    Buffer.from([major, 0, flags]),
    syncsafe(body.length),
    body,
    footer,
  ]);
};

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

/**
 * The frame-id band, at its edges rather than somewhere inside it.
 *
 * An id that fails the pattern stops the walk, so a following frame that would
 * be reported is the observable: put the id under test first and a reported
 * frame behind it, and the assertion says whether the walk got past it. One id
 * carries all four band edges, so narrowing any of them shows up here.
 */
describe('the frame-id band', () => {
  const behind = (id: string): readonly string[] =>
    parseId3(
      tag(4, [
        { id, body: Buffer.from('x') },
        { id: 'TSSE', body: Buffer.from('SomeTool') },
      ])
    ).map((region) => region.kind);

  it('walks past an id built from all four edges of the band', () => {
    expect(behind('A0Z9')).toEqual(['id3:TSSE']);
  });

  it.each(['@AAA', '[AAA', '/AAA', ':AAA'])(
    'stops at an id carrying %s, one step outside an edge',
    (id) => {
      expect(behind(id)).toEqual([]);
    }
  );
});

describe('id3TagLength', () => {
  it('returns zero when the blob carries no tag', () => {
    expect(id3TagLength(Buffer.from('fLaC', 'latin1'))).toBe(0);
  });

  it('returns zero for a blob too short to hold a header', () => {
    expect(id3TagLength(Buffer.from('ID3', 'latin1'))).toBe(0);
  });

  it('counts the header plus the declared body', () => {
    const bytes = tag(4, [{ id: 'TSSE', body: Buffer.from('SomeTool') }]);
    expect(id3TagLength(bytes)).toBe(bytes.length);
  });

  it('counts the footer when the footer flag is set', () => {
    const bytes = tag(4, [{ id: 'TSSE', body: Buffer.from('SomeTool') }], 0x10);
    expect(id3TagLength(bytes)).toBe(bytes.length);
  });
});

describe('parseId3', () => {
  it('reports no region for a blob carrying no tag', () => {
    expect(parseId3(Buffer.from('fLaC', 'latin1'))).toEqual([]);
  });

  it('reports an encoder-settings frame as an identity carrier', () => {
    const [region] = parseId3(tag(4, [{ id: 'TSSE', body: Buffer.from('\0SomeTool 9') }]));
    expect(region?.kind).toBe('id3:TSSE');
    expect(region?.carriesIdentity).toBe(true);
    expect(region?.text).toContain('SomeTool 9');
  });

  it('extracts printable text from an opaque GEOB payload', () => {
    const body = Buffer.concat([Buffer.alloc(3), Buffer.from('c2pa manifest store')]);
    const [region] = parseId3(tag(3, [{ id: 'GEOB', body }]));
    expect(region?.kind).toBe('id3:GEOB');
    expect(region?.text).toContain('c2pa manifest store');
  });

  it('reads a version-3 frame size as a plain integer', () => {
    const body = Buffer.alloc(200, 0x41);
    const [region] = parseId3(tag(3, [{ id: 'TXXX', body }]));
    expect(region?.length).toBe(210);
  });

  it('does not treat a date frame as an identity carrier', () => {
    const [region] = parseId3(tag(4, [{ id: 'TDRC', body: Buffer.from('\u00032026-01-02') }]));
    expect(region?.kind).toBe('id3:TDRC');
    expect(region?.carriesIdentity).toBe(false);
  });

  it('ignores frames that carry no disclosure class', () => {
    expect(parseId3(tag(4, [{ id: 'TIT2', body: Buffer.from('\0A title') }]))).toEqual([]);
  });

  it('stops at the padding that follows the last frame', () => {
    const regions = parseId3(tag(4, [{ id: 'TSSE', body: Buffer.from('\0x') }], 0, 64));
    expect(regions).toHaveLength(1);
  });

  it('locates a frame at its absolute offset', () => {
    const [region] = parseId3(tag(4, [{ id: 'TSSE', body: Buffer.from('\0x') }]));
    expect(region?.offset).toBe(10);
  });

  it('skips an extended header before the first frame', () => {
    const extended = Buffer.concat([syncsafe(6), Buffer.from([1, 0])]);
    const frames = Buffer.concat([extended, frame({ id: 'TSSE', body: Buffer.from('\0x') }, 4)]);
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0x40]),
      syncsafe(frames.length),
      frames,
    ]);
    const [region] = parseId3(bytes);
    expect(region?.kind).toBe('id3:TSSE');
  });

  it('reports a version-2 tag as one opaque region', () => {
    const body = Buffer.concat([Buffer.from('TT2'), Buffer.alloc(3), Buffer.from('legacy text')]);
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([2, 0, 0]),
      syncsafe(body.length),
      body,
    ]);
    const [region] = parseId3(bytes);
    expect(region?.kind).toBe('id3:tag');
    expect(region?.text).toContain('legacy text');
  });

  it('stops when a frame size overruns the tag', () => {
    const bad = Buffer.concat([Buffer.from('TXXX'), syncsafe(9000), Buffer.alloc(2)]);
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0]),
      syncsafe(bad.length),
      bad,
    ]);
    expect(refusals(parseId3(bytes))).toBe(1);
  });

  it('refuses a tag whose body cannot hold the extended header it declares', () => {
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0x40]),
      syncsafe(3),
      Buffer.alloc(3),
    ]);
    expect(refusals(parseId3(bytes))).toBe(1);
  });

  it('stops at a frame declaring no body at all', () => {
    const empty = Buffer.concat([Buffer.from('TSSE'), syncsafe(0), Buffer.alloc(2)]);
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([4, 0, 0]),
      syncsafe(empty.length),
      empty,
    ]);
    expect(parseId3(bytes)).toEqual([]);
  });

  it('skips a version-three extended header, whose size excludes its own size field', () => {
    const extended = Buffer.concat([Buffer.alloc(4), Buffer.alloc(6)]);
    extended.writeUInt32BE(6, 0);
    const frames = Buffer.concat([extended, frame({ id: 'TSSE', body: Buffer.from('\0x') }, 3)]);
    const bytes = Buffer.concat([
      Buffer.from('ID3', 'latin1'),
      Buffer.from([3, 0, 0x40]),
      syncsafe(frames.length),
      frames,
    ]);
    expect(parseId3(bytes)[0]?.kind).toBe('id3:TSSE');
  });
});

/**
 * A frame the tag declares but this gate's enumeration does not name was read by
 * nothing, so a host path in an unlisted frame rode through untouched.
 */
describe('parseId3 — a declared frame no rule names is still read', () => {
  const disclosure = ['', 'home', 'someone', 'bed'].join('/');

  it('reads an unlisted frame for values', () => {
    const bytes = tag(4, [{ id: 'TIT2', body: Buffer.from(disclosure, 'latin1') }]);
    expect(
      parseId3(bytes)
        .map((region) => region.text)
        .join('\n')
    ).toContain(disclosure);
  });
});
