import { crc32 } from 'node:zlib';

import { describe, expect, it } from 'vitest';

import { HOUR_SECONDS, MINUTE_SECONDS } from '@hushbox/shared/durations';

import { matchesZip, parseZip } from './zip.js';

interface EntrySpec {
  readonly name: string;
  readonly dosTime: number;
  readonly dosDate: number;
  readonly extra?: Buffer;
  /** Where the entry says its local record sits. Zero unless a case turns on it. */
  readonly localOffset?: number;
}

const centralEntry = (spec: EntrySpec): Buffer => {
  const name = Buffer.from(spec.name, 'latin1');
  const extra = spec.extra ?? Buffer.alloc(0);
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02_01_4b_50, 0);
  record.writeUInt16LE(spec.dosTime, 12);
  record.writeUInt16LE(spec.dosDate, 14);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt16LE(extra.length, 30);
  record.writeUInt32LE(spec.localOffset ?? 0, 42);
  return Buffer.concat([record, name, extra]);
};

const extraField = (id: number, body: Buffer): Buffer => {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(body.length, 2);
  return Buffer.concat([header, body]);
};

/** Info-ZIP extended timestamp: a flags byte, then one 32-bit UTC second per flag. */
const extendedTimestamp = (...seconds: readonly number[]): Buffer => {
  const flags = Buffer.from([(1 << seconds.length) - 1]);
  const values = Buffer.alloc(4 * seconds.length);
  for (const [index, value] of seconds.entries()) values.writeInt32LE(value, index * 4);
  return extraField(0x54_55, Buffer.concat([flags, values]));
};

const FILETIME_EPOCH_OFFSET_SECONDS = 11_644_473_600n;

/** NTFS extra field: reserved word, then a tag/size-prefixed triple of FILETIMEs. */
const ntfsTimes = (...seconds: readonly number[]): Buffer => {
  const times = Buffer.alloc(24);
  for (const [index, value] of seconds.entries()) {
    times.writeBigUInt64LE(
      (BigInt(value) + FILETIME_EPOCH_OFFSET_SECONDS) * 10_000_000n,
      index * 8
    );
  }
  const attribute = Buffer.alloc(4);
  attribute.writeUInt16LE(0x00_01, 0);
  attribute.writeUInt16LE(times.length, 2);
  return extraField(0x00_0a, Buffer.concat([Buffer.alloc(4), attribute, times]));
};

const zip = (entries: readonly EntrySpec[]): Buffer => {
  const directory = Buffer.concat(entries.map((entry) => centralEntry(entry)));
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(0, 16);
  return Buffer.concat([directory, eocd]);
};

interface MemberSpec {
  readonly name: string;
  readonly body: Buffer;
  /** The local record's own extra field, which its central counterpart need not carry. */
  readonly localExtra?: Buffer;
  /** Sizes written after the body rather than into the local record. */
  readonly descriptor?: 'plain' | 'signed';
}

const STREAMED_SIZES_FLAG = 1 << 3;

const dataDescriptor = (member: MemberSpec): Buffer => {
  if (member.descriptor === undefined) return Buffer.alloc(0);
  const trailer = Buffer.alloc(12);
  trailer.writeUInt32LE(crc32(member.body), 0);
  trailer.writeUInt32LE(member.body.length, 4);
  trailer.writeUInt32LE(member.body.length, 8);
  if (member.descriptor === 'plain') return trailer;
  const signature = Buffer.alloc(4);
  signature.writeUInt32LE(0x08_07_4b_50);
  return Buffer.concat([signature, trailer]);
};

const localRecord = (member: MemberSpec): Buffer => {
  const name = Buffer.from(member.name, 'latin1');
  const extra = member.localExtra ?? Buffer.alloc(0);
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04_03_4b_50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt32LE(crc32(member.body), 14);
  header.writeUInt32LE(member.body.length, 18);
  header.writeUInt32LE(member.body.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  if (member.descriptor !== undefined) header.writeUInt16LE(STREAMED_SIZES_FLAG, 6);
  return Buffer.concat([header, name, extra, member.body, dataDescriptor(member)]);
};

const memberEntry = (member: MemberSpec, localOffset: number): Buffer => {
  const name = Buffer.from(member.name, 'latin1');
  const record = Buffer.alloc(46);
  record.writeUInt32LE(0x02_01_4b_50, 0);
  record.writeUInt16LE(20, 6);
  if (member.descriptor !== undefined) record.writeUInt16LE(STREAMED_SIZES_FLAG, 8);
  record.writeUInt16LE(dosDate(1980, 1, 1), 14);
  record.writeUInt32LE(crc32(member.body), 16);
  record.writeUInt32LE(member.body.length, 20);
  record.writeUInt32LE(member.body.length, 24);
  record.writeUInt16LE(name.length, 28);
  record.writeUInt32LE(localOffset, 42);
  return Buffer.concat([record, name]);
};

/**
 * An archive laid out member by member, so a case can put bytes between two of
 * them. A raw buffer in the list is content no record enumerates; every offset
 * and size is written from the layout, so the result is an archive a standard
 * reader opens and extracts.
 */
const archive = (parts: readonly (MemberSpec | Buffer)[]): Buffer => {
  const pieces: Buffer[] = [];
  const records: Buffer[] = [];
  let at = 0;
  for (const part of parts) {
    if (Buffer.isBuffer(part)) {
      pieces.push(part);
      at += part.length;
      continue;
    }
    const record = localRecord(part);
    records.push(memberEntry(part, at));
    pieces.push(record);
    at += record.length;
  }
  const directory = Buffer.concat(records);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06_05_4b_50, 0);
  eocd.writeUInt16LE(records.length, 8);
  eocd.writeUInt16LE(records.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(at, 16);
  return Buffer.concat([...pieces, directory, eocd]);
};

const dosTime = (hour: number, minute: number, second: number): number =>
  (hour << 11) | (minute << 5) | (second >> 1);
const dosDate = (year: number, month: number, day: number): number =>
  ((year - 1980) << 9) | (month << 5) | day;

/**
 * One instant carrying every field a second-resolution stamp has, named once so
 * the cases that write it and the cases that expect it back cannot drift. Built
 * as a day plus an offset: a written-out clock in tracked text is what the
 * repository's own privacy gate refuses.
 */
const FULL_RESOLUTION_SECONDS =
  Date.UTC(2024, 4, 6) / 1000 + 17 * HOUR_SECONDS + 41 * MINUTE_SECONDS + 9;

/** Damage is a finding, never an empty region list — see the refusal channel in `region`. */
const refusals = (regions: readonly { readonly malformed?: string | undefined }[]): number =>
  regions.filter((region) => region.malformed !== undefined).length;

describe('matchesZip', () => {
  it('matches a local-file-header signature', () => {
    expect(matchesZip(Buffer.from([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
  });

  it('matches an empty-archive signature', () => {
    expect(matchesZip(Buffer.from([0x50, 0x4b, 0x05, 0x06]))).toBe(true);
  });

  it('does not match another container', () => {
    expect(matchesZip(Buffer.from('fLaC', 'latin1'))).toBe(false);
  });
});

describe('parseZip', () => {
  it('reports an entry whose modification time carries a time of day', () => {
    const bytes = zip([
      { name: 'pkg/module.py', dosTime: dosTime(16, 11, 8), dosDate: dosDate(2023, 9, 8) },
    ]);
    const [region] = parseZip(bytes);
    expect(region?.kind).toBe('zip:central-directory-entry');
    expect(region?.instants[0]?.secondsUtc).toBe(
      Date.UTC(2023, 8, 8) / 1000 + 16 * HOUR_SECONDS + 11 * MINUTE_SECONDS + 8
    );
  });

  it('reads an archive normalized to the reproducible-build epoch as midnight', () => {
    const bytes = zip([{ name: 'META-INF/MANIFEST.MF', dosTime: 0, dosDate: dosDate(1980, 1, 1) }]);
    expect(parseZip(bytes)[0]?.instants[0]?.secondsUtc).toBe(Date.UTC(1980, 0, 1) / 1000);
  });

  it('does not treat an entry timestamp as an identity carrier', () => {
    const bytes = zip([{ name: 'a', dosTime: dosTime(1, 2, 4), dosDate: dosDate(2023, 1, 1) }]);
    expect(parseZip(bytes)[0]?.carriesIdentity).toBe(false);
  });

  it('reports one region per timestamped entry', () => {
    const bytes = zip([
      { name: 'a', dosTime: dosTime(1, 0, 0), dosDate: dosDate(2023, 1, 1) },
      { name: 'b', dosTime: dosTime(2, 0, 0), dosDate: dosDate(2023, 1, 2) },
    ]);
    expect(parseZip(bytes)).toHaveLength(2);
  });

  it('reports nothing when no end-of-directory record is present', () => {
    expect(refusals(parseZip(Buffer.from([0x50, 0x4b, 0x03, 0x04])))).toBe(1);
  });

  it('stops at a central-directory record with a wrong signature', () => {
    const bytes = zip([{ name: 'a', dosTime: dosTime(1, 0, 0), dosDate: dosDate(2023, 1, 1) }]);
    const damaged = Buffer.from(bytes);
    damaged.writeUInt32LE(0, 0);
    expect(refusals(parseZip(damaged))).toBe(1);
  });

  it('stops when the declared entry count overruns the directory', () => {
    const bytes = zip([{ name: 'a', dosTime: dosTime(1, 0, 0), dosDate: dosDate(2023, 1, 1) }]);
    const damaged = Buffer.from(bytes);
    damaged.writeUInt16LE(9, bytes.length - 22 + 10);
    expect(parseZip(damaged).filter((region) => region.malformed === undefined)).toHaveLength(1);
  });

  it('does not match a blob shorter than a signature', () => {
    expect(matchesZip(Buffer.alloc(2))).toBe(false);
  });

  it('searches back only as far as a comment field could reach', () => {
    const bytes = zip([{ name: 'a', dosTime: dosTime(1, 0, 0), dosDate: dosDate(2023, 1, 1) }]);
    const padded = Buffer.concat([Buffer.alloc(70_000), bytes]);
    padded.writeUInt32LE(70_000, padded.length - 22 + 16);
    // The padding is bytes no record enumerates and is refused as such; what
    // this case is about is that the end record behind it was still found.
    expect(parseZip(padded).filter((region) => region.malformed === undefined)).toHaveLength(1);
  });

  it('steps back over an archive comment to reach the end-of-directory record', () => {
    const bytes = zip([{ name: 'a', dosTime: dosTime(1, 0, 0), dosDate: dosDate(2023, 1, 1) }]);
    bytes.writeUInt16LE(8, bytes.length - 2);
    expect(parseZip(Buffer.concat([bytes, Buffer.alloc(8)]))).toHaveLength(1);
  });

  it('reads the extended-timestamp extra field the coarse words cannot express', () => {
    const bytes = zip([
      {
        name: 'a',
        dosTime: 0,
        dosDate: dosDate(1980, 1, 1),
        extra: extendedTimestamp(86_400 * 20_000 + 3600),
      },
    ]);
    const instants = parseZip(bytes)[0]?.instants ?? [];
    expect(instants.map((instant) => instant.field)).toContain('extraModified');
    expect(instants.find((instant) => instant.field === 'extraModified')?.secondsUtc).toBe(
      86_400 * 20_000 + 3600
    );
  });

  it('reads every field the extended-timestamp flags declare', () => {
    const bytes = zip([
      {
        name: 'a',
        dosTime: 0,
        dosDate: dosDate(1980, 1, 1),
        extra: extendedTimestamp(1, 2, 3),
      },
    ]);
    expect(parseZip(bytes)[0]?.instants.map((instant) => instant.field)).toEqual([
      'entryModified',
      'extraModified',
      'extraAccessed',
      'extraCreated',
    ]);
  });

  it('stops reading extended-timestamp fields the field is too short to hold', () => {
    const truncated = extraField(0x54_55, Buffer.from([0x07, 0x01, 0x02]));
    const bytes = zip([{ name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1), extra: truncated }]);
    expect(parseZip(bytes)[0]?.instants).toHaveLength(1);
  });

  it('reads the NTFS extra field as full-resolution UTC', () => {
    const bytes = zip([
      {
        name: 'a',
        dosTime: 0,
        dosDate: dosDate(1980, 1, 1),
        extra: ntfsTimes(86_400 * 20_000 + 60, 0, 0),
      },
    ]);
    const instants = parseZip(bytes)[0]?.instants ?? [];
    expect(instants.find((instant) => instant.field === 'ntfsModified')?.secondsUtc).toBe(
      86_400 * 20_000 + 60
    );
  });

  it('ignores an NTFS attribute that is not the timestamp triple', () => {
    const attribute = Buffer.alloc(4);
    attribute.writeUInt16LE(0x00_02, 0);
    attribute.writeUInt16LE(4, 2);
    const other = extraField(0x00_0a, Buffer.concat([Buffer.alloc(4), attribute, Buffer.alloc(4)]));
    const bytes = zip([{ name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1), extra: other }]);
    expect(parseZip(bytes)[0]?.instants).toHaveLength(1);
  });

  it('stops at an NTFS attribute whose size overruns the field', () => {
    const attribute = Buffer.alloc(4);
    attribute.writeUInt16LE(0x00_01, 0);
    attribute.writeUInt16LE(200, 2);
    const bad = extraField(0x00_0a, Buffer.concat([Buffer.alloc(4), attribute]));
    const bytes = zip([{ name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1), extra: bad }]);
    expect(parseZip(bytes)[0]?.instants).toHaveLength(1);
  });

  it('stops at an extra field whose size overruns the record', () => {
    const bad = Buffer.from([0x55, 0x54, 0xff, 0x00]);
    const bytes = zip([{ name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1), extra: bad }]);
    expect(parseZip(bytes)[0]?.instants).toHaveLength(1);
  });

  it('ignores an extra field this gate does not read', () => {
    const unknown = extraField(0x99_99, Buffer.alloc(8));
    const bytes = zip([{ name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1), extra: unknown }]);
    expect(parseZip(bytes)[0]?.instants).toHaveLength(1);
  });

  it('locates an entry by ordinal rather than by its file-controlled name', () => {
    const bytes = zip([
      { name: 'first', dosTime: 0, dosDate: dosDate(1980, 1, 1) },
      { name: 'second', dosTime: 0, dosDate: dosDate(1980, 1, 1) },
    ]);
    expect(parseZip(bytes).map((region) => region.location)).toEqual([
      'centralDirectory[0]',
      'centralDirectory[1]',
    ]);
  });

  it('carries the entry name as scannable content rather than as a label', () => {
    const bytes = zip([{ name: 'pkg/module.py', dosTime: 0, dosDate: dosDate(1980, 1, 1) }]);
    expect(parseZip(bytes)[0]?.text).toBe('pkg/module.py');
  });
});

/**
 * Everything the gate says about an archive hangs off the end record, and every
 * field in it is a field the archive wrote. A count of zero walks nothing, so
 * the honest records still sitting in front of that record are read by nobody
 * while the verdict comes back clean — and because the text gate defers to the
 * binary registry, no second gate looks either.
 */
describe('parseZip — the byte space in front of the end record is reconciled', () => {
  const disclosing = (): readonly EntrySpec[] =>
    ['one', 'two', 'three'].map((leaf) => ({
      name: ['', 'home', 'someone', leaf].join('/'),
      dosTime: dosTime(9, 41, 12),
      dosDate: dosDate(2024, 5, 6),
    }));

  const withZeroedCount = (): Buffer => {
    const bytes = Buffer.from(zip(disclosing()));
    const eocd = bytes.length - 22;
    bytes.writeUInt16LE(0, eocd + 8);
    bytes.writeUInt16LE(0, eocd + 10);
    return bytes;
  };

  const withSecondEndRecord = (): Buffer => {
    const trailer = Buffer.alloc(22);
    trailer.writeUInt32LE(0x06_05_4b_50, 0);
    return Buffer.concat([zip(disclosing()), trailer]);
  };

  it.each([
    ['an entry count of zero', withZeroedCount],
    ['a second end record appended behind the honest one', withSecondEndRecord],
  ])('refuses an archive whose directory enumerates nothing, on %s', (_label, build) => {
    expect(refusals(parseZip(build()))).toBeGreaterThan(0);
  });

  it.each([
    ['an entry count of zero', withZeroedCount],
    ['a second end record appended behind the honest one', withSecondEndRecord],
  ])('reads the unenumerated bytes for values, on %s', (_label, build) => {
    const text = parseZip(build())
      .map((region) => region.text)
      .join('\n');
    expect(text).toContain(['', 'home', 'someone', 'one'].join('/'));
  });

  it('leaves a well-formed archive with nothing unaccounted', () => {
    const bytes = zip([{ name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1) }]);
    expect(refusals(parseZip(bytes))).toBe(0);
  });

  it('refuses an archive whose entries all start behind unenumerated content', () => {
    const prefix = Buffer.from(['', 'home', 'someone', 'stub'].join('/'), 'latin1');
    const honest = zip([
      { name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1), localOffset: prefix.length },
    ]);
    const bytes = Buffer.concat([prefix, honest]);
    bytes.writeUInt32LE(prefix.length, bytes.length - 22 + 16);
    expect(refusals(parseZip(bytes))).toBeGreaterThan(0);
  });
});

/**
 * A span every record's own extent leaves out, inside an archive nothing else
 * is wrong with.
 *
 * Taking the lowest offset any record claims and the point the directory walk
 * stopped describes an *envelope*, and an envelope reports only what lies in
 * front of the first record and behind the last: every byte between them reads
 * as accounted because some record happened to point past it. Both specimens
 * here open, extract and verify in a standard reader with their members coming
 * back byte-exact, so nothing but the union of the declared extents separates
 * them from an honest archive.
 */
describe('parseZip — every declared record accounts for its own extent', () => {
  const disclosure = [['', 'home', 'someone', 'renders'].join('/'), 'Lavf61.7.100'].join(' ');
  const filler = (): Buffer => Buffer.from(disclosure, 'latin1');
  const first = { name: 'first.txt', body: Buffer.from('one', 'latin1') };
  const second = { name: 'second.txt', body: Buffer.from('two', 'latin1') };

  it.each([
    ['between two members', (): Buffer => archive([first, filler(), second])],
    ['in front of the central directory', (): Buffer => archive([first, filler()])],
  ])('refuses a span no record enumerates, %s', (_label, build) => {
    expect(refusals(parseZip(build()))).toBeGreaterThan(0);
  });

  it.each([
    ['between two members', (): Buffer => archive([first, filler(), second])],
    ['in front of the central directory', (): Buffer => archive([first, filler()])],
  ])('reads that span for values, %s', (_label, build) => {
    const text = parseZip(build())
      .map((region) => region.text)
      .join('\n');
    expect(text).toContain(['', 'home', 'someone', 'renders'].join('/'));
  });

  it('leaves an archive whose members and directory cover every byte alone', () => {
    expect(refusals(parseZip(archive([first, second])))).toBe(0);
  });

  it.each([['plain'], ['signed']] as const)(
    'accounts for the %s descriptor a streamed entry writes after its body',
    (descriptor) => {
      expect(refusals(parseZip(archive([{ ...first, descriptor }])))).toBe(0);
    }
  );

  it('refuses an entry whose local record is declared past the end record', () => {
    const bytes = archive([first]);
    // The central record's local-offset field, the pointer the extent is read from.
    bytes.writeUInt32LE(0xff_ff_00, localRecord(first).length + 42);
    expect(refusals(parseZip(bytes))).toBeGreaterThan(0);
  });

  it('refuses an entry whose declared body overruns the end record', () => {
    const bytes = archive([first]);
    // The central record's size field, which is what the local extent is measured from.
    bytes.writeUInt32LE(0xff_ff_00, localRecord(first).length + 20);
    expect(refusals(parseZip(bytes))).toBeGreaterThan(0);
  });

  it('reads a local record extra field the central counterpart does not carry', () => {
    const at = FULL_RESOLUTION_SECONDS;
    const bytes = archive([{ ...first, localExtra: extendedTimestamp(at) }]);

    const instants = parseZip(bytes).flatMap((region) => region.instants);

    expect(instants.map((instant) => instant.secondsUtc)).toContain(at);
  });
});

/**
 * Nothing stops many central records from naming *one* local record, and
 * this shape is not one a reader necessarily accepts. Run against three:
 * `adm-zip` opens it and returns every member byte-exact, while Info-ZIP
 * and CPython's `zipfile` both list every entry and get the first out, then
 * refuse the rest as overlapped components — the usual zip-bomb defence,
 * differing in where the refusal lands: Info-ZIP aborts the whole extraction
 * and exits non-zero, while CPython raises per entry, so its first member
 * stays readable. The gate reads staged bytes rather than what a reader
 * would hand back, so it meets the shape either way: the local record's
 * extra field is expanded into text and instants, and a read that runs
 * once per pointing record turns one small field into entry-count copies
 * of itself — measured, a quarter-megabyte archive ended in a heap-limit
 * process abort, which is a dead gate rather than a catchable throw.
 */
describe('parseZip — one local record many entries point at', () => {
  const member = { name: 'shared.txt', body: Buffer.from('one', 'latin1') };

  /**
   * The layout helper writes one local record per member, so the aliased shape
   * needs its own builder: every central record here names offset zero.
   */
  const aliased = (entries: number, localExtra: Buffer = Buffer.alloc(0)): Buffer => {
    const local = localRecord({ ...member, localExtra });
    const directory = Buffer.concat(Array.from({ length: entries }, () => memberEntry(member, 0)));
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06_05_4b_50, 0);
    eocd.writeUInt16LE(entries, 8);
    eocd.writeUInt16LE(entries, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(local.length, 16);
    return Buffer.concat([local, directory, eocd]);
  };

  it('expands its extra field once rather than once per pointing entry', () => {
    const at = FULL_RESOLUTION_SECONDS;
    const bytes = aliased(3, extendedTimestamp(at));

    const instants = parseZip(bytes).flatMap((region) => region.instants);

    expect(instants.filter((instant) => instant.secondsUtc === at)).toHaveLength(1);
  });

  it('still reports every entry that points at it', () => {
    const regions = parseZip(aliased(3, extendedTimestamp(FULL_RESOLUTION_SECONDS)));

    expect(regions.filter((region) => region.kind === 'zip:central-directory-entry')).toHaveLength(
      3
    );
  });

  it('leaves the byte space reconciled', () => {
    expect(refusals(parseZip(aliased(3)))).toBe(0);
  });
});

/**
 * The half a memo cannot see: records at *different* offsets whose declared
 * extra fields are the same window. Each is a distinct record, so each expands,
 * and what they cost is the bytes they read rather than the findings they
 * yield — a window of unread fields produces neither region nor text, so a
 * bound counting results never fires on it.
 */
describe('parseZip — distinct local records declaring one window', () => {
  const LOCAL_RECORD_BYTES = 30;

  /** One field this gate does not read, so a window of them yields nothing. */
  const unread = (bytes: number): Buffer => extraField(0x99_99, Buffer.alloc(bytes - 4));

  /** A window of nothing but full-resolution timestamps. */
  const packed = (attributes: number): Buffer =>
    Buffer.concat(
      Array.from({ length: attributes }, () => {
        const at = FULL_RESOLUTION_SECONDS;
        return extendedTimestamp(at, at, at);
      })
    );

  const sharedWindow = (count: number, window: Buffer): Buffer => {
    const headers = Buffer.alloc(LOCAL_RECORD_BYTES * count);
    for (let index = 0; index < count; index++) {
      const at = index * LOCAL_RECORD_BYTES;
      headers.writeUInt32LE(0x04_03_4b_50, at);
      // The name length is what lands every record's extra field on one window.
      headers.writeUInt16LE(headers.length - at - LOCAL_RECORD_BYTES, at + 26);
      headers.writeUInt16LE(window.length, at + 28);
    }
    const directory = Buffer.concat(
      Array.from({ length: count }, (_unused, index) => {
        const record = Buffer.alloc(46);
        record.writeUInt32LE(0x02_01_4b_50, 0);
        record.writeUInt16LE(dosDate(1980, 1, 1), 14);
        record.writeUInt32LE(index * LOCAL_RECORD_BYTES, 42);
        return record;
      })
    );
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06_05_4b_50, 0);
    eocd.writeUInt16LE(count, 8);
    eocd.writeUInt16LE(count, 10);
    eocd.writeUInt32LE(directory.length, 12);
    eocd.writeUInt32LE(headers.length + window.length, 16);
    return Buffer.concat([headers, window, directory, eocd]);
  };

  it('refuses the blob once the expansions have spent its walk budget', () => {
    expect(parseZip(sharedWindow(513, unread(65_535))).at(-1)?.kind).toBe('blob:budget');
  });

  it('leaves a blob one expansion short of that budget alone', () => {
    expect(refusals(parseZip(sharedWindow(512, unread(65_535))))).toBe(0);
  });

  /**
   * A window small enough that the walk budget never fires, packed with the
   * fields the walk turns into findings. Nothing counts those: the regions stay
   * far inside their ceiling while the finding list does not.
   */
  it('refuses the blob once the expansions have spent its instant budget', () => {
    expect(parseZip(sharedWindow(300, packed(100))).at(-1)?.kind).toBe('blob:budget');
  });

  it('leaves a blob whose expansions stay inside that budget alone', () => {
    expect(refusals(parseZip(sharedWindow(100, packed(100))))).toBe(0);
  });
});

/**
 * Damage inside intact outer framing. The end record still parses, so nothing
 * about the archive's outermost structure is wrong; a central record that
 * declares more than the directory holds would otherwise carry the walk past
 * every span the reconciliation can see, in one jump.
 */
describe('parseZip — a central record that overruns the directory', () => {
  it('refuses rather than stepping over the rest of it', () => {
    const bytes = Buffer.from(zip([{ name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1) }]));
    // The name-length field of the first central record, which sits at the
    // directory start this fixture puts at zero.
    bytes.writeUInt16LE(0xff_ff, 28);
    expect(refusals(parseZip(bytes))).toBeGreaterThan(0);
  });
});

describe('parseZip — the reconciliation on the edges of its own inputs', () => {
  it('leaves an archive that is nothing but an end record alone', () => {
    expect(parseZip(zip([]))).toEqual([]);
  });

  it('refuses the records the declared entry count stops short of', () => {
    const bytes = Buffer.from(
      zip([
        { name: 'a', dosTime: 0, dosDate: dosDate(1980, 1, 1) },
        { name: ['', 'home', 'someone', 'b'].join('/'), dosTime: 0, dosDate: dosDate(1980, 1, 1) },
      ])
    );
    bytes.writeUInt16LE(1, bytes.length - 22 + 10);

    const regions = parseZip(bytes);

    expect(refusals(regions)).toBe(1);
    expect(regions.map((region) => region.text).join('\n')).toContain(
      ['', 'home', 'someone', 'b'].join('/')
    );
  });

  it('reconciles nothing once the blob has spent its budget', () => {
    const entries = 5000;
    const bytes = zip(
      Array.from({ length: entries }, (_unused, index) => ({
        name: `f${String(index)}`,
        dosTime: dosTime(1, 2, 4),
        dosDate: dosDate(2023, 1, 1),
      }))
    );

    const regions = parseZip(bytes);

    expect(regions.length).toBeLessThan(entries);
    expect(regions.at(-1)?.kind).toBe('blob:budget');
  });
});
