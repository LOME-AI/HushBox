import { describe, it, expect, vi } from 'vitest';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DAY_MS, HOUR_MS, MINUTE_MS, SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { PRIVACY_ALLOWLIST_PATH, type PrivacyAllowlistEntry } from './allowlist.js';
import {
  ENCODING_RULE,
  NAMED_HOME_SOURCE,
  ROOTED_HOST_PATH_SOURCE,
  RULES,
  decodeBlob,
  scanTextBlobs,
  type TextBlobEntry,
} from './rules.js';

/**
 * The disclosing values below are written as fragments joined at run time. The gate reads
 * committed bytes, so a value assembled this way is in none of them and the gate never sees
 * it — which is what keeps the detector's own test source green while it runs the detector
 * over real matches.
 *
 * It is also the one technique the gate cannot read, so it is licensed where a match is the
 * subject of the test and nowhere else. A value of this class must be visible in the bytes
 * and admitted by an allowlist entry carrying evidence, or obtained rather than spelled —
 * the shared test-time module is where a test gets an instant — and never fragmented to
 * keep a source green. Only the sources `OWNED_TEST_SOURCES` names in
 * `allowlist.test.ts` are held to that by anything that runs, and this file is not
 * among them: everywhere else it stands as a property a reviewer applies, unmeasured.
 */
const ISO_INSTANT = ['2026-08-16', 'T', '14', ':', '30', ':', '45', 'Z'].join('');
const ISO_MIDNIGHT = ['2026-08-16', 'T', '00', ':', '00', ':', '00', '.000Z'].join('');
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const HOME_PATH = ['', 'home', 'someone', 'checkout'].join('/');

function blob(path: string, text: string): TextBlobEntry {
  return { path, bytes: Buffer.from(text, 'utf8') };
}

/**
 * A digit run in the grouped spelling JavaScript's numeric separator gives it.
 * Derived from the digits rather than written beside them: a grouped literal
 * spelled out here would be a finding in this file the moment the run is an
 * instant, which is the whole subject of the cases that use it.
 */
function groupDigits(digits: string): string {
  return digits.replaceAll(/\B(?=(?:\d{3})+$)/g, '_');
}

/**
 * An ASCII value re-encoded at a four-byte code unit, little-endian. Indexed by code
 * unit rather than split into characters: the fixtures are ASCII, so the two agree,
 * and neither string-spread nor `split('')` is reachable for a linter to object to.
 */
function wide32(text: string): Buffer {
  const out = Buffer.alloc(text.length * 4);
  for (let index = 0; index < text.length; index += 1) {
    out.writeUInt32LE(text.codePointAt(index) ?? 0, index * 4);
  }
  return out;
}

function blobWithPrefix(path: string, prefix: readonly number[], text: string): TextBlobEntry {
  return { path, bytes: Buffer.concat([Buffer.from(prefix), Buffer.from(text, 'utf8')]) };
}

describe('scanTextBlobs — ISO datetime', () => {
  it('reports an ISO datetime carrying a time of day', () => {
    const findings = scanTextBlobs([blob('docs/note.md', `ran at ${ISO_INSTANT}`)], []);

    expect(findings).toEqual([
      expect.objectContaining({ rule: 'iso-datetime', path: 'docs/note.md', line: 1 }),
    ]);
  });

  it('passes an ISO datetime whose time component is the UTC day boundary', () => {
    const findings = scanTextBlobs([blob('docs/note.md', `ran at ${ISO_MIDNIGHT}`)], []);

    expect(findings).toEqual([]);
  });

  it('reports an ISO datetime at a day boundary carrying a non-zero zone offset', () => {
    const shifted = `${['2026-08-16', 'T', '00', ':', '00', ':', '00'].join('')}+05:30`;

    const findings = scanTextBlobs([blob('docs/note.md', shifted)], []);

    expect(rulesOf(findings)).toEqual(['iso-datetime']);
  });

  it('reports a day-boundary instant whose value continues in digits past the second field', () => {
    const continued = `${['2026-08-16', 'T', '00', ':', '00', ':', '00'].join('')}1`;

    expect(rulesOf(scanTextBlobs([blob('docs/note.md', continued)], []))).toEqual(['iso-datetime']);
  });

  it('reports a day-boundary instant whose minute field is written one digit wider', () => {
    const widened = `${['2026-08-16', 'T', '00', ':', '00'].join('')}0`;

    expect(rulesOf(scanTextBlobs([blob('docs/note.md', widened)], []))).toEqual(['iso-datetime']);
  });
});

function rulesOf(findings: readonly { rule: string }[]): string[] {
  return findings.map((finding) => finding.rule);
}

describe('scanTextBlobs — scope and allowlist', () => {
  it('states in its behaviour that a green here is not a clean verdict on its own', () => {
    // A text blob wearing a container's signature is deferred to the binary
    // gate, which is the only thing that then looks at it. `scanTextBlobs`
    // returning nothing therefore means "no text findings", never "clean".
    const disguised = blobWithPrefix('docs/a.md', PNG_SIGNATURE, ISO_INSTANT);

    expect(scanTextBlobs([disguised], [])).toEqual([]);
  });

  it('skips a blob the binary format registry recognises', () => {
    const entry = blobWithPrefix('assets/thing.png', PNG_SIGNATURE, ISO_INSTANT);

    expect(scanTextBlobs([entry], [])).toEqual([]);
  });

  it('scans a blob carrying a NUL byte that no binary format claims', () => {
    const entry = blob('docs/a.md', `\u0000 ran at ${ISO_INSTANT} in ${HOME_PATH}`);

    expect(rulesOf(scanTextBlobs([entry], []))).toEqual([
      'undecodable-encoding',
      'iso-datetime',
      'absolute-host-path',
    ]);
  });

  it('scans a UTF-16 blob rather than reading it as mojibake', () => {
    const entry = {
      path: 'docs/a.md',
      bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(ISO_INSTANT, 'utf16le')]),
    };

    expect(rulesOf(scanTextBlobs([entry], []))).toContain('iso-datetime');
  });

  // The registry is stubbed to claim everything, so this asserts the precedence
  // itself rather than which formats the binary gate happens to claim today: a
  // fixture built on a sibling's over-breadth tests that sibling's defect, and
  // breaks the moment it is fixed. The second assertion is the control — without
  // a mark, the same claim defers — so the stub cannot pass this vacuously.
  it.each([
    ['little-endian', [0xff, 0xfe]],
    ['big-endian', [0xfe, 0xff]],
  ])('lets a %s byte-order mark outrank a registry that claims the blob', async (_label, mark) => {
    vi.resetModules();
    vi.doMock('./binary/format-registry.js', () => ({
      detectBinaryFormat: () => ({ id: 'png', label: 'stub', extensions: [], parse: () => [] }),
    }));
    const { scanTextBlobs: scanAgainstClaimingRegistry } = await import('./rules.js');
    const utf16 = Buffer.from(ISO_INSTANT, 'utf16le');
    if (mark[0] === 0xfe) utf16.swap16();
    const marked = Buffer.concat([Buffer.from(mark), utf16]);

    const withMark = scanAgainstClaimingRegistry([{ path: 'docs/a.md', bytes: marked }], []);
    const withoutMark = scanAgainstClaimingRegistry(
      [{ path: 'docs/b.md', bytes: Buffer.from(ISO_INSTANT, 'utf8') }],
      []
    );

    vi.doUnmock('./binary/format-registry.js');
    vi.resetModules();
    expect(rulesOf(withMark)).toContain('iso-datetime');
    expect(withoutMark).toEqual([]);
  });

  it('scans a big-endian UTF-16 blob too', () => {
    const littleEndian = Buffer.from(ISO_INSTANT, 'utf16le');
    littleEndian.swap16();
    const entry = {
      path: 'docs/a.md',
      bytes: Buffer.concat([Buffer.from([0xfe, 0xff]), littleEndian]),
    };

    expect(rulesOf(scanTextBlobs([entry], []))).toContain('iso-datetime');
  });

  it('strips a UTF-8 byte-order mark instead of reading it as content', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(ISO_INSTANT, 'utf8'),
    ]);

    const findings = scanTextBlobs([{ path: 'docs/a.md', bytes }], []);

    expect(rulesOf(findings)).toEqual(['iso-datetime']);
    expect(findings[0]?.column).toBe(1);
  });

  // Two bytes in front of ordinary UTF-8 text was a blinding primitive: the
  // payload read as mojibake, and ASCII decoded as UTF-16 leaves no NUL for the
  // encoding rule either, so the blob passed both gates with its contents intact.
  it.each([
    ['little-endian', [0xff, 0xfe]],
    ['big-endian', [0xfe, 0xff]],
  ])('scans a UTF-8 payload behind an uncorroborated %s mark, and reports the mark', (_l, mark) => {
    const payload = `ran at ${ISO_INSTANT} on ${HOME_PATH}`;
    const bytes = Buffer.concat([Buffer.from(mark), Buffer.from(payload, 'utf8')]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'undecodable-encoding',
      'iso-datetime',
      'absolute-host-path',
    ]);
  });

  it.each([
    ['little-endian', [0xff, 0xfe]],
    ['big-endian', [0xfe, 0xff]],
  ])('reports an even-length UTF-8 payload behind a %s mark', (_label, mark) => {
    const payload = `ran at ${ISO_INSTANT}`;
    const padded = payload.length % 2 === 0 ? payload : `${payload} `;
    const bytes = Buffer.concat([Buffer.from(mark), Buffer.from(padded, 'utf8')]);

    expect(padded.length % 2).toBe(0);
    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'undecodable-encoding',
      'iso-datetime',
    ]);
  });

  it.each([
    ['little-endian', [0xff, 0xfe]],
    ['big-endian', [0xfe, 0xff]],
  ])('reports an odd-length %s payload rather than throwing on the swap', (_label, mark) => {
    const utf16 = Buffer.from(ISO_INSTANT, 'utf16le');
    const bytes = Buffer.concat([Buffer.from(mark), utf16, Buffer.from([0x20])]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toContain(
      'undecodable-encoding'
    );
  });

  // The mark says little-endian and the payload is big-endian: the NULs are on
  // the wrong parity, so the mark is not borne out and the blob is reported
  // rather than decoded through the encoding its first two bytes claim.
  // The predicate's decision boundary. One NUL on the right parity is what the
  // old threshold accepted, and it licensed a whole-file UTF-16 reading of
  // ordinary UTF-8 text; a genuine UTF-16 ASCII file has one in every two bytes.
  it.each([
    ['little-endian', [0xff, 0xfe], 1],
    ['big-endian', [0xfe, 0xff], 0],
  ])('reports a %s payload carrying a single planted NUL', (_label, mark, parity) => {
    const text = `ran at ${ISO_INSTANT} on ${HOME_PATH}`;
    const padded = text.length % 2 === 0 ? text : `${text} `;
    const payload = Buffer.from(padded, 'utf8');
    payload[parity === 1 ? 1 : 0] = 0;
    const bytes = Buffer.concat([Buffer.from(mark), payload]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'undecodable-encoding',
      'iso-datetime',
      'absolute-host-path',
    ]);
  });

  // The tie: one NUL on each parity, two code units, so the count reaches the
  // floor exactly while failing the parity comparison. Both clauses have to hold
  // for the mark to stand, and nothing else in the file sits at that boundary —
  // the decode produces two ordinary characters, so no NUL survives to raise the
  // finding through the other arm and dropping either clause loses it outright.
  it.each([
    ['little-endian', [0xff, 0xfe]],
    ['big-endian', [0xfe, 0xff]],
  ])('reports a %s payload whose parities tie at the floor', (_label, mark) => {
    const payload = Buffer.from([0x41, 0x00, 0x00, 0x41]);
    const bytes = Buffer.concat([Buffer.from(mark), payload]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'undecodable-encoding',
    ]);
  });

  // Just under the density floor: half UTF-16 ASCII, half UTF-8, so a fixture
  // that only sat near zero could not tell the floor from a much lower one.
  it('reports a payload whose parity-NUL density falls just short of the floor', () => {
    const utf16Half = Buffer.from('a'.repeat(20), 'utf16le');
    const utf8Half = Buffer.from('b'.repeat(42), 'utf8');
    const payload = Buffer.concat([utf16Half, utf8Half]);
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), payload]);

    const density = 20 / (payload.length / 2);
    expect(density).toBeGreaterThan(0.25);
    expect(density).toBeLessThan(0.5);
    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'undecodable-encoding',
    ]);
  });

  // A corroborating head says nothing about a differently-encoded tail, so
  // detection does not rest on the encoding guess: every interpretation of the
  // bytes is scanned, and whichever one carries the disclosure is reported.
  it('finds a UTF-8 tail behind a long, genuinely corroborating UTF-16 head', () => {
    const head = Buffer.from('a'.repeat(4096), 'utf16le');
    const tailText = `ran at ${ISO_INSTANT} on ${HOME_PATH}`;
    // Even, so the payload still corroborates: the point is a tail the winning
    // interpretation cannot read, not a tail that breaks the corroboration.
    const tail = Buffer.from(tailText.length % 2 === 0 ? tailText : `${tailText} `, 'utf8');
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), head, tail]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'iso-datetime',
      'absolute-host-path',
    ]);
  });

  it('reports a mark the payload contradicts', () => {
    const swapped = Buffer.from(ISO_INSTANT, 'utf16le');
    swapped.swap16();
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), swapped]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'undecodable-encoding',
    ]);
  });

  it('reports a byte-order mark with no payload at all', () => {
    const bytes = Buffer.from([0xff, 0xfe]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'undecodable-encoding',
    ]);
  });

  it('reports an unreadable encoding rather than passing a blob it cannot decode', () => {
    const bytes = Buffer.concat([Buffer.from('a'), Buffer.from([0]), Buffer.from('b')]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/a.md', bytes }], []))).toEqual([
      'undecodable-encoding',
    ]);
  });

  it('never reports on the allowlist file, whichever caller hands it over', () => {
    const entry = blob(PRIVACY_ALLOWLIST_PATH, ISO_INSTANT);

    expect(scanTextBlobs([entry], [])).toEqual([]);
  });

  it('suppresses a matched literal pinned to its own path', () => {
    const entry = blob('fixtures/upstream.json', ISO_INSTANT);
    const allowlist = [
      {
        clause: 'provenance' as const,
        description: 'upstream data',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT],
      },
    ];

    expect(scanTextBlobs([entry], allowlist)).toEqual([]);
  });

  // An entry under an evidenced clause is admitted on a citation, so the citation is
  // what the admission rests on: one the file does not bear out silences nothing, at the
  // moment it is used rather than only when the suite next reads the shipped file.
  it('suppresses a pinned literal whose entry’s evidence stands against the file', () => {
    const content = `schemaVersion ${ISO_INSTANT}`;
    const allowlist = [
      {
        clause: 'content' as const,
        description: 'a schema version, not an instant',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT],
        evidence: { is: 'a schema version', shownBy: content },
      },
    ];

    expect(scanTextBlobs([blob('fixtures/upstream.json', content)], allowlist)).toEqual([]);
  });

  it('leaves a pinned literal reported where the entry cites text the file does not carry', () => {
    const content = `schemaVersion ${ISO_INSTANT}`;
    const allowlist = [
      {
        clause: 'content' as const,
        description: 'a schema version, not an instant',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT],
        evidence: { is: 'a schema version', shownBy: 'a sentence the file does not carry' },
      },
    ];

    expect(rulesOf(scanTextBlobs([blob('fixtures/upstream.json', content)], allowlist))).toEqual([
      'iso-datetime',
    ]);
  });

  it('leaves a pinned literal reported where the entry’s citation is bound to no value it pins', () => {
    const content = `a heading\nschemaVersion ${ISO_INSTANT}`;
    const allowlist = [
      {
        clause: 'content' as const,
        description: 'a schema version, not an instant',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT],
        evidence: { is: 'a schema version', shownBy: 'a heading' },
      },
    ];

    expect(rulesOf(scanTextBlobs([blob('fixtures/upstream.json', content)], allowlist))).toEqual([
      'iso-datetime',
    ]);
  });

  it('leaves the same literal reported at a path the entry does not pin', () => {
    const entry = blob('src/a.ts', ISO_INSTANT);
    const allowlist = [
      {
        clause: 'provenance' as const,
        description: 'upstream data',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT],
      },
    ];

    expect(rulesOf(scanTextBlobs([entry], allowlist))).toEqual(['iso-datetime']);
  });

  // A literal-free entry is the binary side's shape, admissible only for a path
  // the format registry claims — and such a path is never text-scanned. On this
  // side it must therefore exempt nothing, rather than silently widening into a
  // blanket text exemption if a binary file ever stopped matching its magic bytes.
  it('gives a literal-free entry no effect on a text blob', () => {
    const entry = blob('fixtures/upstream.json', ISO_INSTANT);
    const allowlist = [
      {
        clause: 'provenance' as const,
        description: 'upstream data',
        path: 'fixtures/upstream.json',
      },
    ];

    expect(rulesOf(scanTextBlobs([entry], allowlist))).toEqual(['iso-datetime']);
  });

  it('leaves a match the entry does not pin reported', () => {
    const other = ['2026-08-16', 'T', '09', ':', '15', ':', '00'].join('');
    const entry = blob('fixtures/upstream.json', `${ISO_INSTANT} ${other}`);
    const allowlist = [
      {
        clause: 'provenance' as const,
        description: 'upstream data',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT],
      },
    ];

    expect(scanTextBlobs([entry], allowlist)).toHaveLength(1);
  });

  // The redaction mask is the one place a failure prints the value it is hiding,
  // into the terminal and into CI logs. Each fixture carries the ends of a band
  // inside the matched span, so truncating any band leaves a character visible.
  it.each([
    ['every digit', ['', 'tmp', 'run-0123456789'].join('/')],
    ['the ends of the lowercase band', ['', 'home', 'abcxyz'].join('/')],
    ['the ends of the uppercase band', ['', 'Users', 'ABCXYZ'].join('/')],
  ])('masks %s out of the reported shape', (_label, value) => {
    const [finding] = scanTextBlobs([blob('docs/a.md', value)], []);

    expect(finding).toBeDefined();
    // Strip the mask alphabet; anything alphanumeric left is a character of the
    // matched value that survived redaction.
    expect(finding?.shape.replaceAll(/[NxX]/g, '')).not.toMatch(/[\dA-Za-z]/);
  });

  it('exempts a pinned literal only on an exact match, never on containment', () => {
    const entry = blob('fixtures/upstream.json', ISO_INSTANT);
    const allowlist = [
      {
        clause: 'provenance' as const,
        description: 'upstream data',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT.slice(0, 10)],
      },
    ];

    expect(rulesOf(scanTextBlobs([entry], allowlist))).toEqual(['iso-datetime']);
  });

  // The path side of the same predicate. Exact equality is the contract: a
  // sibling that widened it to a prefix or a containment would exempt files no
  // one wrote an entry for, and both directions are reachable from one entry.
  it.each([
    ['a path the entry is a prefix of', 'fixtures/upstream.json.bak'],
    ['a path the entry names a directory of', 'fixtures/upstream.json/inner.json'],
  ])('does not exempt %s', (_label, scanned) => {
    const allowlist = [
      {
        clause: 'provenance' as const,
        description: 'upstream data',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT],
      },
    ];

    expect(rulesOf(scanTextBlobs([blob(scanned, ISO_INSTANT)], allowlist))).toEqual([
      'iso-datetime',
    ]);
  });

  it('does not exempt a path that is itself a prefix of the entry', () => {
    const allowlist = [
      {
        clause: 'provenance' as const,
        description: 'upstream data',
        path: 'fixtures/upstream.json',
        literals: [ISO_INSTANT],
      },
    ];

    expect(rulesOf(scanTextBlobs([blob('fixtures/upstream', ISO_INSTANT)], allowlist))).toEqual([
      'iso-datetime',
    ]);
  });

  // The zone designator sits inside the matched span, so an entry pinning the
  // value must carry it: a rule that stopped matching the designator would
  // silently stop honouring entries written against the whole value.
  it('exempts a value pinned with its lower-case zone designator', () => {
    const value = ['2026-08-16', 'T', '14', ':', '30', ':', '45'].join('') + 'z';
    const allowlist = [
      {
        clause: 'provenance' as const,
        description: 'upstream data',
        path: 'fixtures/x.json',
        literals: [value],
      },
    ];

    expect(scanTextBlobs([blob('fixtures/x.json', value)], allowlist)).toEqual([]);
  });

  it('masks every alphanumeric character of the match out of the reported shape', () => {
    const [finding] = scanTextBlobs([blob('docs/a.md', ISO_INSTANT)], []);

    expect(finding?.shape).toBe('NNNN-NN-NNXNN:NN:NNX');
  });

  it('orders findings by position rather than by rule', () => {
    const content = `${['14', '30'].join(':')}\n${ISO_INSTANT}\n${HOME_PATH}`;

    const findings = scanTextBlobs([blob('docs/a.md', content)], []);

    expect(findings.map((finding) => finding.line)).toEqual([1, 2, 3]);
  });

  it('orders findings sharing a line by column', () => {
    const content = `${HOME_PATH} then ${ISO_INSTANT}`;

    const findings = scanTextBlobs([blob('docs/a.md', content)], []);

    expect(findings.map((finding) => finding.rule)).toEqual(['absolute-host-path', 'iso-datetime']);
  });
});

describe('ROOTED_HOST_PATH_SOURCE', () => {
  const rooted = (): RegExp => new RegExp(ROOTED_HOST_PATH_SOURCE, 'u');

  it.each([
    ['a home directory', ['', 'home', 'someone', 'checkout'].join('/')],
    ['a macOS home directory', ['', 'Users', 'someone', 'checkout'].join('/')],
    ['a container checkout', ['', 'workspace', 'someone', 'checkout'].join('/')],
    ['a temp path carrying a digit run', ['', 'tmp', 'run-1234'].join('/')],
    ['an optional-software checkout', ['', 'opt', 'someone', 'checkout'].join('/')],
    ['a per-user temp path', ['', 'var', 'folders', 'zz', 'T', 'checkout'].join('/')],
    [
      'a per-user temp path spelled through the resolved root',
      ['', 'private', 'var', 'folders', 'zz', 'T', 'checkout'].join('/'),
    ],
    ['a drive-lettered path', `C:\\${['Users', 'someone'].join('\\')}`],
  ])('matches %s, the same as the rule reads', (_label, value) => {
    expect(rooted().test(value)).toBe(true);
    expect(rulesOf(scanTextBlobs([blob('docs/a.md', value)], []))).toEqual(['absolute-host-path']);
  });

  it('leaves the named-home shorthand out, which is not a rooted spelling', () => {
    const shorthand = `~${['someone', 'checkout'].join('/')}`;

    expect(rooted().test(shorthand)).toBe(false);
    expect(rulesOf(scanTextBlobs([blob('docs/a.md', shorthand)], []))).toEqual([
      'absolute-host-path',
    ]);
  });

  it('leaves a repository-relative path out', () => {
    expect(rooted().test(['docs', 'plans', 'note.md'].join('/'))).toBe(false);
  });

  // One near-miss per root added alongside the three the export opened with:
  // a bare prefix names no user, and a sibling of the per-user temp directory
  // names no account.
  it.each([
    ['an optional-software prefix with no segment after it', ['', 'opt', '']],
    ['a system directory that shares the per-user temp prefix', ['', 'var', 'log', 'daemon']],
  ])('leaves %s out, and so does the rule', (_label, segments) => {
    const value = segments.join('/');

    expect(rooted().test(value)).toBe(false);
    expect(scanTextBlobs([blob('docs/a.md', value)], [])).toEqual([]);
  });

  // The export is the alternatives, not the guard in front of them: a caller
  // that composes it without one reads an inner segment as a root. The rule
  // composes the guard, so a package location under a shared prefix stays out
  // of it — which is the level the difference is observable at.
  it('reads an inner optional-software segment that the rule refuses', () => {
    const value = ['', 'usr', 'local', 'opt', 'pkg'].join('/');

    expect(rooted().test(value)).toBe(true);
    expect(scanTextBlobs([blob('docs/a.md', value)], [])).toEqual([]);
  });
});

describe('NAMED_HOME_SOURCE', () => {
  const named = (): RegExp => new RegExp(NAMED_HOME_SOURCE, 'u');

  it('matches the shorthand the rule reads, for an importer that compiles it itself', () => {
    expect(named().test(`~${['someone', 'checkout'].join('/')}`)).toBe(true);
  });

  it('matches a shorthand whose opening letter sits outside ASCII', () => {
    expect(named().test(`~${['équipe', 'checkout'].join('/')}`)).toBe(true);
  });

  // The opening letter is what makes the `u` flag load-bearing rather than
  // tidy. Dropped, the property escape degrades into an identity escape and the
  // source reads a literal brace-wrapped name, so an importer that forgets the
  // flag gets a pattern silent on every home directory rather than a wider one.
  it('goes silent on the shorthand when compiled without the flag its class needs', () => {
    expect(new RegExp(NAMED_HOME_SOURCE).test(`~${['someone', 'checkout'].join('/')}`)).toBe(false);
  });

  it('refuses a tilde that a slash has turned into an ordinary segment', () => {
    expect(named().test(['https://example.test', '~someone', 'papers'].join('/'))).toBe(false);
  });

  // The mirror of the rooted export's own asymmetry, and the reason the pair of
  // tests above would otherwise mislead: the slash is the only character this
  // source refuses in front of the tilde. The rule refuses every word character
  // and the dot too, and it does that in the guard it composes, not here — so an
  // importer that composes this source bare reads a tilde mid-word as a home.
  it('reads a tilde after a word character, which the rule refuses', () => {
    const value = `pkg${['~someone', 'checkout'].join('/')}`;

    expect(named().test(value)).toBe(true);
    expect(scanTextBlobs([blob('docs/a.md', value)], [])).toEqual([]);
  });
});

describe('the gate over its own source', () => {
  it('reports nothing in the files that implement it', async () => {
    const libraryDirectory = path.dirname(fileURLToPath(import.meta.url));
    const repositoryRoot = path.resolve(libraryDirectory, '..', '..', '..');
    const libraryNames = await readdir(libraryDirectory);
    // The directory is taken whole rather than by a list of the gate's modules, so that a
    // module added here later is scanned without anyone remembering to name it: an
    // inclusion list fails silently on a new control file, while an exclusion list fails
    // loudly on an unexpected one. The extension filter is what skips the
    // subdirectories `readdir` reports alongside the files.
    //
    // `gitleaks.test.ts` is the sole exemption, and the only file here the gate reports on
    // at all: it spells three absolute host paths that an allowlist entry naming this exact
    // file admits, and this scan is deliberately not given the allowlist.
    const libraryFiles = libraryNames
      .filter((name) => name.endsWith('.ts') && name !== 'gitleaks.test.ts')
      .map((name) => `scripts/lib/privacy/${name}`);
    const owned = [...libraryFiles, 'privacy-allowlist.json'];

    const blobs = await Promise.all(
      owned.map(async (repoPath) => ({
        path: repoPath,
        bytes: await readFile(path.join(repositoryRoot, repoPath)),
      }))
    );

    expect(scanTextBlobs(blobs, [])).toEqual([]);
  });
});

// A band is pinned by fixtures at its ends, not by one somewhere inside it: a
// single fixture leaves both edges free to be truncated away unnoticed. Each
// block below walks the ends of a band, or one member of each alternation.
describe('scanTextBlobs — band endpoints', () => {
  it.each([
    ['the first hour of the day', ['00', '01']],
    ['the last hour of the first arm', ['19', '30']],
    ['the first hour of the second arm', ['20', '30']],
    ['the last hour of the day', ['23', '30']],
    ['the first minute of the hour', ['14', '00']],
    ['the last minute of the hour', ['14', '59']],
  ])('reports a strict clock at %s', (_label, fields) => {
    const content = `at ${fields.join(':')} done`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['clock-minutes']);
  });

  it.each([
    ['the first hour', ['0', '00', '01']],
    ['the last hour', ['23', '30', '15']],
    ['the first minute', ['12', '00', '15']],
    ['the last minute', ['12', '59', '15']],
    ['the first second', ['12', '30', '00']],
    ['the last second', ['12', '30', '59']],
  ])('reports a seconds clock at %s', (_label, fields) => {
    const content = `at ${fields.join(':')} done`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['clock-seconds']);
  });

  it.each([
    ['the bottom of the era band', -1400],
    ['the top of the era band', 1600],
  ])('reports epochs at %s, at both widths', (_label, dayOffset) => {
    const base = TEST_DAY_START + dayOffset * DAY_MS + 12 * HOUR_MS + 123;
    const milliseconds = `at ${String(base)}`;
    const seconds = `at ${String(Math.floor(base / SECOND_MS))}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', milliseconds)], []))).toEqual(['epoch-ms']);
    expect(rulesOf(scanTextBlobs([blob('src/a.ts', seconds)], []))).toEqual(['epoch-seconds']);
  });

  it.each([
    ['the first hour of the first arm', ['01', '00']],
    ['the last hour of the first arm', ['09', '00']],
    ['the first hour of the second arm', ['10', '00']],
    ['the last representable hour', ['14', '00']],
    ['a quarter past', ['05', '15']],
    ['half past', ['05', '30']],
    ['three quarters past', ['05', '45']],
  ])('reports a zone offset at %s', (_label, fields) => {
    const content = `the session ran at -${fields.join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
  });

  it.each([
    ['a pacific abbreviation', ['P', 'S', 'T']],
    ['an australian abbreviation', ['A', 'E', 'S', 'T']],
    ['a hawaiian abbreviation', ['H', 'S', 'T']],
    ['a british abbreviation', ['B', 'S', 'T']],
    ['a central-european abbreviation', ['C', 'E', 'S', 'T']],
    ['an eastern-european abbreviation', ['E', 'E', 'T']],
    ['a western-european abbreviation', ['W', 'E', 'T']],
    ['an indian abbreviation', ['I', 'S', 'T']],
    ['a japanese abbreviation', ['J', 'S', 'T']],
    ['a korean abbreviation', ['K', 'S', 'T']],
    ['a new-zealand abbreviation', ['N', 'Z', 'D', 'T']],
  ])('reports %s in prose', (_label, letters) => {
    const content = `the reviewer sits in ${letters.join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual([
      'timezone-abbreviation',
    ]);
  });

  it.each([
    'Africa',
    'America',
    'Antarctica',
    'Arctic',
    'Asia',
    'Atlantic',
    'Australia',
    'Europe',
    'Indian',
    'Pacific',
  ])('reports an IANA zone under %s in prose', (continent) => {
    const content = `the reviewer sits in ${continent}/Some_Place`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['iana-timezone']);
  });

  it.each(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'])(
    'reports an RFC 1123 date on %s',
    (weekday) => {
      const content = `Date: ${weekday}, 16 Aug 2026 ${['14', '30', '45'].join(':')} GMT`;

      expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['rfc1123-date']);
    }
  );

  it.each(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'])(
    'reports an RFC 1123 date in %s',
    (month) => {
      const content = `Date: Thu, 16 ${month} 2026 ${['14', '30', '45'].join(':')} GMT`;

      expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['rfc1123-date']);
    }
  );

  it.each([
    ['an upper-case zulu designator', 'Z'],
    ['a lower-case zulu designator', 'z'],
  ])('reports an ISO datetime with %s', (_label, designator) => {
    const content = ['2026-08-16', 'T', '14', ':', '30', ':', '45'].join('') + designator;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['iso-datetime']);
  });

  it.each([
    ['a digit', '7'],
    ['a letter', 'x'],
    ['a dot', '.'],
    ['an underscore', '_'],
    ['a hyphen', '-'],
  ])('ignores an epoch-width run abutting %s on either side', (_label, boundary) => {
    const epoch = String(TEST_DAY_START + 12 * HOUR_MS + 123);

    expect(scanTextBlobs([blob('src/a.ts', `${boundary}${epoch}`)], [])).toEqual([]);
    expect(scanTextBlobs([blob('src/a.ts', `${epoch}${boundary}`)], [])).toEqual([]);
  });

  it.each([
    ['lower-case am', ['a', 'm'].join('')],
    ['upper-case AM', ['A', 'M'].join('')],
    ['lower-case pm', ['p', 'm'].join('')],
    ['upper-case PM', ['P', 'M'].join('')],
  ])('reports a %s clock', (_label, meridiem) => {
    const content = `standup at 9:30 ${meridiem}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toContain('meridiem-clock');
  });
});

describe('scanTextBlobs — seasonless civil zone abbreviation', () => {
  const SEASONLESS = ['P', 'T'].join('');
  const CLOCK = ['17', '45'].join(':');

  it('reports a seasonless zone spelling beside a clock reading in prose', () => {
    const content = `the window closes at ${CLOCK} ${SEASONLESS}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toContain(
      'seasonless-timezone-abbreviation'
    );
  });

  it('ignores an ordinary capitalised word that spells a seasonless zone', () => {
    const content = `a fixer must not ${['A', 'C', 'T'].join('')} on my earlier words`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('ignores a seasonless zone spelling with no clock reading beside it', () => {
    const content = `the reviewer sits in ${SEASONLESS}`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('ignores a seasonless zone spelling in code', () => {
    const content = `const zone = '${SEASONLESS}'; // ${CLOCK}`;

    expect(scanTextBlobs([blob('src/a.ts', content)], []).map((finding) => finding.rule)).toEqual([
      'clock-minutes',
    ]);
  });
});

describe('scanTextBlobs — dash-spelled ISO stamp', () => {
  const DASH_STAMP = ['2026-08-16', 'T', '14', '-', '30', '-', '45'].join('');
  const DASH_MIDNIGHT = ['2026-08-16', 'T', '00', '-', '00', '-', '00'].join('');

  it('reports a stamp whose clock is spelled with dashes', () => {
    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `report ${DASH_STAMP}`)], []))).toEqual([
      'iso-datetime',
    ]);
  });

  it('reports a dash-spelled stamp in a filesystem path segment', () => {
    const content = `e2e/report/${DASH_STAMP}/REPORT.md`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['iso-datetime']);
  });

  it('passes a dash-spelled stamp that lands on the day boundary', () => {
    expect(scanTextBlobs([blob('docs/a.md', `report ${DASH_MIDNIGHT}`)], [])).toEqual([]);
  });

  it('reports a dash-spelled stamp whose value continues past the second field', () => {
    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `${DASH_MIDNIGHT}1`)], []))).toEqual([
      'iso-datetime',
    ]);
  });

  it('ignores a two-field dash pair after a calendar day, which is a range', () => {
    const content = `on ${['2026-08-16', ' ', '10', '-', '20'].join('')} items shipped`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('ignores a clock whose separators disagree', () => {
    const content = `report ${['2026-08-16', 'T', '14', '-', '30', ':', '45'].join('')}`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });
});

describe('scanTextBlobs — prose-scoped zone rules', () => {
  const ABBREVIATION = ['P', 'S', 'T'].join('');
  const IANA = ['America', 'New_York'].join('/');
  const OFFSET = `-${['07', '00'].join('')}`;

  it('reports a zone abbreviation in prose', () => {
    const content = `the reviewer sits in ${ABBREVIATION}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual([
      'timezone-abbreviation',
    ]);
  });

  it("ignores the abstract-syntax-tree acronym, which is this repo's word for a parse tree", () => {
    const content = `the ${['A', 'S', 'T'].join('')} rule walks the imports`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('ignores a zone abbreviation in code', () => {
    const content = `const zone = '${ABBREVIATION}';`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  it('treats a markdown-with-components file as prose', () => {
    const content = `the reviewer sits in ${ABBREVIATION}`;

    expect(rulesOf(scanTextBlobs([blob('apps/marketing/post.mdx', content)], []))).toEqual([
      'timezone-abbreviation',
    ]);
  });

  it('reports an IANA zone name in prose', () => {
    const content = `the reviewer sits in ${IANA}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['iana-timezone']);
  });

  it('ignores an IANA zone name in code, where it is quiet-hours product data', () => {
    const content = `const zone = '${IANA}';`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  it('reports a bare zone offset in prose', () => {
    const content = `the session ran at ${OFFSET}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
  });

  it('passes a zero zone offset, which is UTC and discloses nothing', () => {
    const content = `the rendered offset is exactly +${['00', '00'].join('')}`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('reports a zero-hour offset whose minutes are not zero', () => {
    const content = `the session ran at +${['00', '15'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
  });

  it('reports an offset in the far half of the representable hour band', () => {
    const content = `the session ran at -${['11', '00'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
  });

  it('reports an offset on a half-hour boundary', () => {
    const content = `the session ran at -${['05', '30'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
  });

  it('ignores a signed number that is not a representable zone offset', () => {
    const content = 'the card sits at top -1234 and the diff was +3000 lines';

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  // An offset's sign is written with whichever dash the author's editor left
  // behind, and a substituted one is still the sign. Both spellings are pinned
  // so that collapsing the sign class back to ASCII cannot silently drop one.
  const SIGN_SPELLINGS = [
    ['an ASCII plus', '+'],
    ['an ASCII hyphen-minus', '-'],
    ['a typographic minus', '−'],
    ['an en dash', '–'],
    ['an em dash', '—'],
  ] as const;

  const UTC = ['U', 'T', 'C'].join('');

  it.each(SIGN_SPELLINGS)(
    'reports an hour-only offset behind a zone token signed with %s',
    (_spelling, sign) => {
      const content = `the runner sits at ${UTC}${sign}5`;

      expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
    }
  );

  it.each(SIGN_SPELLINGS)(
    'reports a four-digit offset behind a zone token signed with %s',
    (_spelling, sign) => {
      const content = `the runner sits at ${UTC}${sign}${['05', '30'].join('')}`;

      expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
    }
  );

  it('reports a two-digit hour-only offset behind a zone token', () => {
    const content = `the runner sits at ${UTC}+${['1', '4'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
  });

  it('passes a zero offset behind a zone token, which is UTC by another name', () => {
    const content = `the rendered offset is exactly ${UTC}+${['00', '00'].join('')}`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('passes a zero hour-only offset behind a zone token', () => {
    const content = `the rendered offset is exactly ${UTC}+0`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('ignores a signed number behind an ordinary word', () => {
    const content = 'the version code is radix-1000 and the token cap is B+1000';

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('ignores a signed number behind a word that merely ends in a zone token', () => {
    const content = `the ${['SH', UTC].join('')}-1000 case is a numeric delta`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it.each(SIGN_SPELLINGS)('reports a compact zone offset signed with %s', (_spelling, sign) => {
    const content = `the session ran at ${sign}${['07', '00'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['timezone-offset']);
  });

  it.each(SIGN_SPELLINGS)('reports a colon zone offset signed with %s', (_spelling, sign) => {
    const content = `the session ran at ${sign}${['07', ':', '00'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toContain('timezone-offset');
  });

  // The clock rules step aside for a value behind a sign, but their own guard
  // knows only the ASCII sign, so a colon offset behind a substituted dash is
  // reported twice under two names. The duplicate is recorded rather than
  // removed: teaching those guards the wider sign would take the clock rules'
  // silence behind an ASCII sign — which hides an out-of-band clock, not an
  // offset — and widen it to every dash spelling, trading over-reporting here
  // for a larger hole there.
  it('reports a colon offset behind a substituted dash under the clock rule as well', () => {
    const content = `the session ran at −${['07', ':', '00'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual([
      'timezone-offset',
      'clock-minutes',
    ]);
  });

  it.each(SIGN_SPELLINGS)('passes a zero offset signed with %s', (_spelling, sign) => {
    const content = `the rendered offset is exactly ${sign}${['00', '00'].join('')}`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  // A dash separating two values is not a sign, and the digit it follows is what
  // says so: the guard in front of the sign refuses a dash that abuts a number
  // on its left, whichever spelling the dash was written in.
  it.each(SIGN_SPELLINGS)('ignores a range whose ends are joined by %s', (_spelling, sign) => {
    const content = `frames ${['0400', sign, '0415'].join('')} were dropped`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('reports the offset of a prose datetime only as part of the datetime', () => {
    const content = `${['2026-08-16', ' ', '14', ':', '30', ':', '45'].join('')} ${OFFSET}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['iso-datetime']);
  });
});

describe('scanTextBlobs — separator-free timestamps', () => {
  const DAY = ['2026', '08', '16'].join('');
  const TIME = ['14', '30', '45'].join('');
  const MIDNIGHT = ['00', '00', '00'].join('');

  it('reports an ASN.1 generalized time', () => {
    const content = `signed ${DAY}${TIME}Z`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['compact-datetime']);
  });

  it('reports an ASN.1 UTC time, which carries a two-digit year', () => {
    const content = `signed ${DAY.slice(2)}${TIME}Z`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['compact-datetime']);
  });

  it('reports the ISO basic form', () => {
    const content = `stamped ${DAY}T${TIME}Z`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['compact-datetime']);
  });

  it('passes a separator-free timestamp whose time field is the UTC day boundary', () => {
    const content = `signed ${DAY}${MIDNIGHT}Z ${DAY}T${MIDNIGHT}Z ${DAY.slice(2)}${MIDNIGHT}Z`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  it('ignores a digit run of the same width carrying neither designator', () => {
    const content = `id ${DAY}${TIME} and ${DAY.slice(2)}${TIME}`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  // An hour field of 24 is one past the highest legal hour: a fixture further out
  // of range would survive a loosened bound and pin nothing.
  it.each([
    ['an hour field just past the last legal hour', ['24', '00', '00']],
    ['a minute field just past the last legal minute', ['12', '60', '00']],
    ['a second field just past the last legal second', ['12', '00', '60']],
  ])('ignores a digit run with %s', (_label, fields) => {
    const content = `id ${DAY}${fields.join('')}Z`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });
});

describe('scanTextBlobs — nano-USD amounts against the epoch bands', () => {
  // Two measured collision bands, where a bare integer amount is indistinguishable
  // from an epoch: the ten-digit band is roughly $1.60 to $2.00, and the
  // thirteen-digit band roughly $1600 to $2000. The bigint suffix takes an amount
  // in either band back out; the grouped spelling no longer does, and that is the
  // false-positive class the separator close was accepted to buy.
  // Built rather than written: a literal here would be a finding in this file.
  const IN_BAND_TEN = ['175', '0000000'].join('');
  const IN_BAND_THIRTEEN = `${IN_BAND_TEN}000`;

  it('ignores amounts outside the era guard, in every form this codebase writes', () => {
    const content = [
      'const price = 250000000;',
      "const wire = '9500000000000';",
      'const total = 42_000_000_000n;',
    ].join('\n');

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  it('ignores an in-band amount written in the bigint form', () => {
    const content = `const b = ${IN_BAND_THIRTEEN}n;`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  // The cost of the separator close, stated as a case rather than left to be
  // rediscovered: an amount in the collision band, grouped, is the same digit run
  // as a grouped instant, and nothing in the value distinguishes them.
  it('reports an in-band amount written in the separator form', () => {
    const content = `const a = ${groupDigits(IN_BAND_TEN)};`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['epoch-seconds']);
  });

  it('reports a bare in-band amount, the collision the guards cannot separate', () => {
    const content = `const a = ${IN_BAND_TEN}; const b = '${IN_BAND_THIRTEEN}';`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual([
      'epoch-seconds',
      'epoch-ms',
    ]);
  });
});

describe('scanTextBlobs — RFC 1123 dates', () => {
  const RFC_PREFIX = 'Thu, 16 Aug 2026';

  it('reports an RFC 1123 date carrying a time of day', () => {
    const content = `Date: ${RFC_PREFIX} ${['14', '30', '45'].join(':')} GMT`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['rfc1123-date']);
  });

  it('passes an RFC 1123 date whose time is the UTC day boundary', () => {
    const content = `Date: ${RFC_PREFIX} ${['00', '00', '00'].join(':')} GMT`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  it('reports an RFC 1123 date at a day boundary carrying a non-zero zone offset', () => {
    const content = `Date: ${RFC_PREFIX} ${['00', '00', '00'].join(':')} -${['07', '00'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['rfc1123-date']);
  });

  it('ignores an RFC 1123 date with no time component', () => {
    expect(scanTextBlobs([blob('docs/a.md', `on ${RFC_PREFIX}`)], [])).toEqual([]);
  });
});

describe('scanTextBlobs — meridiem clock', () => {
  const AM = ['a', 'm'].join('');
  const PM = ['p', 'm'].join('');

  it('reports a meridiem clock co-occurring with a zone token', () => {
    const content = `standup at 9:30 ${AM} ${['P', 'S', 'T'].join('')}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toContain('meridiem-clock');
  });

  it('passes a meridiem clock at midnight', () => {
    const content = `cutover at 12 ${AM}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).not.toContain('meridiem-clock');
  });

  it('reports an afternoon meridiem clock', () => {
    const content = `cutover at 3 ${PM}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toContain('meridiem-clock');
  });

  it('reports noon, which is not midnight', () => {
    const content = `cutover at 12 ${PM}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toContain('meridiem-clock');
  });

  it('ignores a meridiem-shaped run inside an encoded payload', () => {
    const payload = `Zm${['9', PM].join('')}+Qw`;

    expect(scanTextBlobs([blob('src/a.ts', `digest ${payload}`)], [])).toEqual([]);
  });

  it('ignores a marker that only reaches a number across a line break', () => {
    const content = ['the count was 12', `${PM.toUpperCase()} is the heading`].join('\n');

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('reports a meridiem clock with no zone token on the line', () => {
    expect(rulesOf(scanTextBlobs([blob('src/a.ts', `standup at 9:30 ${AM}`)], []))).toContain(
      'meridiem-clock'
    );
  });
});

describe('scanTextBlobs — uuidv7', () => {
  const uuidV7At = (milliseconds: number, variant = '8'): string =>
    `${milliseconds
      .toString(16)
      .padStart(12, '0')
      .replace(/^(.{8})(.{4})$/, '$1-$2')}-7abc-${variant}def-0123456789ab`;

  it('reports a uuidv7 whose embedded epoch carries a time of day', () => {
    const content = `id ${uuidV7At(TEST_DAY_START + 12 * HOUR_MS + 123)}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['uuidv7']);
  });

  // Half a second past midnight: inside the millisecond carve-out, and not a
  // whole number of seconds, so the seconds predicate cannot pass it by accident.
  it('passes a uuidv7 whose embedded epoch is inside the first second of a UTC day', () => {
    const content = `id ${uuidV7At(TEST_DAY_START + SECOND_MS / 2)}`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('reports a uuidv7 one second past midnight', () => {
    const content = `id ${uuidV7At(TEST_DAY_START + SECOND_MS)}`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', content)], []))).toEqual(['uuidv7']);
  });

  it('reports a uuidv7 in code, not only in prose', () => {
    const content = `const id = '${uuidV7At(TEST_DAY_START + 12 * HOUR_MS)}';`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['uuidv7']);
  });

  it.each([
    ['the lowest variant nibble', '8'],
    ['a middle variant nibble', '9'],
    ['another middle variant nibble', 'a'],
    ['the highest variant nibble', 'b'],
    ['an uppercase variant nibble', 'B'],
  ])('reports a uuidv7 carrying %s', (_label, nibble) => {
    const uuid = uuidV7At(TEST_DAY_START + 12 * HOUR_MS).replace(/-8/, `-${nibble}`);

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `id ${uuid}`)], []))).toEqual(['uuidv7']);
  });

  // The variant nibble is not what makes the leading bits a clock: the version
  // does. A literal of this shape discloses a millisecond instant whether or not
  // the nibble is one the specification admits, and the difference between the
  // two is a single character.
  it.each(['0', '1', '2', '3', '4', '5', '6', '7', 'c', 'd', 'e', 'f', 'C', 'D', 'E', 'F'])(
    'reports a version-7 literal whose variant nibble is %s',
    (nibble) => {
      const uuid = uuidV7At(TEST_DAY_START + 12 * HOUR_MS, nibble);

      expect(rulesOf(scanTextBlobs([blob('docs/a.md', `id ${uuid}`)], []))).toEqual(['uuidv7']);
    }
  );

  it('passes a day-boundary version-7 literal whose variant nibble does not conform', () => {
    const content = `id ${uuidV7At(TEST_DAY_START, '0')}`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('ignores a uuid of another version', () => {
    const content = 'id 018f6b3a-0000-4000-8000-0123456789ab';

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('ignores a uuid of another version whose variant nibble does not conform either', () => {
    const content = 'id 018f6b3a-0000-4000-0000-0123456789ab';

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it.each([
    ['names no version at all', ['00000000', '0000', '0000', '0000', '000000000000'].join('-')],
    ['is every bit set', ['ffffffff', 'ffff', 'ffff', 'ffff', 'ffffffffffff'].join('-')],
  ])('ignores a uuid-shaped literal that %s', (_label, uuid) => {
    expect(scanTextBlobs([blob('docs/a.md', `id ${uuid}`)], [])).toEqual([]);
  });

  it('ignores a non-conforming variant nibble inside a longer hex run', () => {
    const content = `id ${uuidV7At(TEST_DAY_START + 12 * HOUR_MS, '0')}ab`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });
});

describe('scanTextBlobs — absolute host paths', () => {
  it.each([
    ['a home directory', ['', 'home', 'someone', 'checkout'].join('/')],
    ['a macOS home directory', ['', 'Users', 'someone', 'checkout'].join('/')],
    ['a workspace root', ['', 'workspace', 'checkout'].join('/')],
    ['a named home shorthand', `~${['someone', 'checkout'].join('/')}`],
  ])('reports %s', (_label, value) => {
    const findings = scanTextBlobs([blob('docs/a.md', `see ${value}`)], []);

    expect(rulesOf(findings)).toEqual(['absolute-host-path']);
  });

  it.each([
    ['a Windows home directory', ['C:', 'Users', 'someone'].join('\\')],
    [
      'a Windows path written with escaped separators',
      ['D:', '', 'work', '', 'checkout'].join('\\'),
    ],
  ])('reports %s', (_label, value) => {
    const findings = scanTextBlobs([blob('docs/a.md', `see ${value}`)], []);

    expect(rulesOf(findings)).toEqual(['absolute-host-path']);
  });

  it('reports a host path in code, not only in prose', () => {
    const content = `const root = '${HOME_PATH}';`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['absolute-host-path']);
  });

  it('ignores a bare drive letter, which names no user', () => {
    const value = ['C:', ''].join('\\');

    expect(scanTextBlobs([blob('docs/a.md', `the ${value} root`)], [])).toEqual([]);
  });

  it('reports a temp path whose filename carries a run of digits', () => {
    const value = `${['', 'tmp', 'session-'].join('/')}91827.log`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${value}`)], []))).toEqual([
      'absolute-host-path',
    ]);
  });

  it('reports a temp path whose digits sit in a later segment', () => {
    const value = `${['', 'tmp', 'builds', 'run-'].join('/')}4821`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${value}`)], []))).toEqual([
      'absolute-host-path',
    ]);
  });

  it('ignores a fixed temp path, which names neither a user nor a clock', () => {
    const value = ['', 'tmp', 'build-artifacts'].join('/');

    expect(scanTextBlobs([blob('docs/a.md', `see ${value}`)], [])).toEqual([]);
  });

  // One desktop platform reaches the temp root through a symlink as well as at
  // the location that symlink resolves to, so a writer copying a resolved path
  // out of a stack trace produces the long spelling. The digit condition is
  // unchanged by the prefix: it decides, exactly as it does for the short one.
  it('reports a temp path spelled through the root the platform resolves to', () => {
    const value = `${['', 'private', 'tmp', 'run-'].join('/')}4821`;

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${value}`)], []))).toEqual([
      'absolute-host-path',
    ]);
  });

  it('ignores a fixed temp path spelled through the root the platform resolves to', () => {
    const value = ['', 'private', 'tmp', 'build-artifacts'].join('/');

    expect(scanTextBlobs([blob('docs/a.md', `see ${value}`)], [])).toEqual([]);
  });

  it('ignores a temp path whose digits are too few to be a clock or a process id', () => {
    const value = `${['', 'tmp', 'shard-'].join('/')}3`;

    expect(scanTextBlobs([blob('docs/a.md', `see ${value}`)], [])).toEqual([]);
  });

  it('ignores the anonymous home shorthand, which names no user', () => {
    expect(scanTextBlobs([blob('docs/a.md', 'see ~/.cache/ms-playwright')], [])).toEqual([]);
  });

  it('ignores a prefix with no segment after it, the form the rule is described in', () => {
    const value = ['', 'home', ''].join('/');

    expect(scanTextBlobs([blob('docs/a.md', `paths under \`${value}\` are banned`)], [])).toEqual(
      []
    );
  });

  // The same elided path in the spellings a writer produces without choosing
  // between them: three ASCII periods, the single character an editor
  // substitutes for them, and its midline twin from a different Unicode block.
  // All are pinned so that collapsing the segment class back to ASCII, or back
  // to one Unicode category, cannot silently drop any of them.
  const ELISION_SPELLINGS = [
    ['three ASCII periods', '...'],
    ['a one-character ellipsis', '…'],
    ['a midline ellipsis', '⋯'],
  ] as const;

  it.each(
    ELISION_SPELLINGS.flatMap(([spelling, elision]) =>
      (
        [
          ['a home directory', ['', 'home', elision].join('/')],
          ['a macOS home directory', ['', 'Users', elision].join('/')],
          ['a workspace root', ['', 'workspace', elision].join('/')],
          ['a Windows drive path', `C:${['', elision].join('\\')}`],
        ] as const
      ).map(([family, value]) => [family, spelling, value] as const)
    )
  )('reports %s whose user segment is elided with %s', (_family, _spelling, value) => {
    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${value}`)], []))).toEqual([
      'absolute-host-path',
    ]);
  });

  it.each(ELISION_SPELLINGS)(
    'reports a host path whose surviving tail follows an elision written with %s',
    (_spelling, elision) => {
      const value = ['', 'workspace', elision, 'apps', 'web'].join('/');

      expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${value}`)], []))).toEqual([
        'absolute-host-path',
      ]);
    }
  );

  // The segment class reads a name, and a name is not ASCII. Three blocks, so a
  // class narrowed back to any one of them fails here instead of going quiet,
  // and every root family carries the case because the roots are literal and
  // the class is what they all share.
  const NON_ASCII_SEGMENTS = [
    ['a Latin letter carrying a diacritic', 'équipe'],
    ['a Cyrillic letter', 'Пapka'],
    ['an ideograph', '資liao'],
  ] as const;

  it.each(
    NON_ASCII_SEGMENTS.flatMap(([spelling, segment]) =>
      (
        [
          ['a home directory', ['', 'home', segment, 'checkout'].join('/')],
          ['a macOS home directory', ['', 'Users', segment, 'checkout'].join('/')],
          ['a workspace root', ['', 'workspace', segment].join('/')],
          ['an optional-software checkout', ['', 'opt', segment].join('/')],
          ['a temp path carrying a run of digits', ['', 'tmp', `${segment}-4821`].join('/')],
          ['a per-user temp path', ['', 'var', 'folders', segment, 'T'].join('/')],
          [
            'a per-user temp path spelled through the resolved root',
            ['', 'private', 'var', 'folders', segment, 'T'].join('/'),
          ],
          ['a Windows drive path', `C:${['', segment].join('\\')}`],
        ] as const
      ).map(([family, value]) => [family, spelling, value] as const)
    )
  )('reports %s whose segment opens on %s', (_family, _spelling, value) => {
    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${value}`)], []))).toEqual([
      'absolute-host-path',
    ]);
  });

  // The shorthand is the one family two classes govern rather than one: the
  // character straight after the tilde is what tells a home directory from a
  // tilde that opens something else, and the rest of the segment is the class
  // above. So it needs a case at each position — a fixture that prepends an
  // ASCII letter can only ever reach the second one.
  it.each(NON_ASCII_SEGMENTS)(
    'reports a named home shorthand whose user segment opens on %s',
    (_spelling, segment) => {
      const value = `~${[segment, 'checkout'].join('/')}`;

      expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${value}`)], []))).toEqual([
        'absolute-host-path',
      ]);
    }
  );

  it.each(NON_ASCII_SEGMENTS)(
    'reports a named home shorthand whose user segment continues with %s',
    (_spelling, segment) => {
      const value = `~${['h' + segment, 'checkout'].join('/')}`;

      expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${value}`)], []))).toEqual([
        'absolute-host-path',
      ]);
    }
  );

  // The other side of that first character, and the reason it is a narrower
  // class than the segment behind it: a home directory is named after a person,
  // so the opening character is a letter in some script. A digit or a hyphen
  // there is a version number or a flag, and neither names anybody.
  it.each([
    ['a digit, which opens a version rather than a name', `~${['2024', 'notes'].join('/')}`],
    ['a hyphen, which opens a flag rather than a name', `~${['-force', 'notes'].join('/')}`],
  ])('ignores a tilde opening on %s', (_label, value) => {
    expect(scanTextBlobs([blob('docs/a.md', `see ${value}`)], [])).toEqual([]);
  });

  // The other side of that class, and the one a wider spelling would lose: a
  // non-ASCII space is still a space, so a prefix wrapped in prose opens no
  // segment.
  it('ignores a prefix a non-breaking space follows, which opens prose rather than a segment', () => {
    const value = ['', 'home', ''].join('/');

    const wrapped = `paths under ${value}\u00A0are banned`;

    expect(scanTextBlobs([blob('docs/a.md', wrapped)], [])).toEqual([]);
  });
});

describe('scanTextBlobs — epochs', () => {
  const DAY_EPOCH_MS = TEST_DAY_START;

  it('reports a 13-digit epoch carrying a time of day', () => {
    const content = `mtime ${String(DAY_EPOCH_MS + 12 * HOUR_MS + 123)}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['epoch-ms']);
  });

  it('passes a 13-digit epoch on a UTC day boundary', () => {
    const content = `mtime ${String(DAY_EPOCH_MS)}`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  // A whole number of seconds past midnight, so the seconds predicate would
  // exempt it: the two predicates agree on every other fixture in this file.
  it('reports a 13-digit epoch that a seconds predicate would call a day boundary', () => {
    const content = `mtime ${String(DAY_EPOCH_MS + DAY_MS / SECOND_MS)}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['epoch-ms']);
  });

  // Near the top of the plausible-era band rather than at this run's own day:
  // every other epoch fixture sits in the band's lower half, which leaves the
  // upper half free to be truncated away unnoticed.
  it.each([
    ['13-digit', 'epoch-ms', 1],
    ['10-digit', 'epoch-seconds', SECOND_MS],
  ])('reports a late-era %s epoch', (_label, rule, divisor) => {
    const base = DAY_EPOCH_MS + 400 * DAY_MS + 12 * HOUR_MS + 123;
    const rendered = String(Math.floor(base / divisor));

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', `at ${rendered}`)], []))).toEqual([rule]);
  });

  it('reports a 10-digit epoch carrying a time of day', () => {
    const content = `stamp ${String(DAY_EPOCH_MS / SECOND_MS + 12 * (HOUR_MS / SECOND_MS))}`;

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', content)], []))).toEqual(['epoch-seconds']);
  });

  it('passes a 10-digit epoch on a UTC day boundary', () => {
    const content = `stamp ${String(DAY_EPOCH_MS / SECOND_MS)}`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  // The separator close. Grouping breaks the contiguous digit run both epoch
  // patterns read, so a grouped instant reached neither the era guard nor the
  // day-boundary carve-out — and a grouped literal is hand-written by
  // construction, which is exactly the class this gate exists to read.
  it.each([
    ['13-digit', 'epoch-ms', 1],
    ['10-digit', 'epoch-seconds', SECOND_MS],
  ])('reports a separator-formatted %s epoch carrying a time of day', (_label, rule, divisor) => {
    const grouped = groupDigits(String(Math.floor((DAY_EPOCH_MS + 12 * HOUR_MS + 123) / divisor)));

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', `at ${grouped}`)], []))).toEqual([rule]);
  });

  // The carve-out has to be reached through the separators, not merely past
  // them: `Number` reads a grouped run as a parse failure, and a NaN fails every
  // boundary predicate silently — which would report every grouped instant,
  // day boundaries included.
  it.each([
    ['13-digit', 1],
    ['10-digit', SECOND_MS],
  ])('passes a separator-formatted %s epoch on a UTC day boundary', (_label, divisor) => {
    const grouped = groupDigits(String(DAY_EPOCH_MS / divisor));

    expect(scanTextBlobs([blob('src/a.ts', `at ${grouped}`)], [])).toEqual([]);
  });

  // The second class the close buys, and the reason it is tolerable: a duration
  // constant of epoch width is grouped exactly like a grouped instant, so the
  // gate reads it as one. The remedy for a real one is a `durations` constant,
  // not a widened guard.
  it('reports a separator-formatted duration constant of epoch width', () => {
    const separated = groupDigits(String(DAY_EPOCH_MS + 12 * HOUR_MS + 123));

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', `const d = ${separated};`)], []))).toEqual([
      'epoch-ms',
    ]);
  });

  // The era guard is what bounds the money collision bands: widen it and every
  // ten-digit integer in the tree becomes a finding.
  it.each([
    ['below the era window', '1500000000', '1500000000000'],
    ['above the era window', '2000000000', '2000000000000'],
  ])('ignores a digit run of epoch width %s', (_label, tenDigit, thirteenDigit) => {
    const content = `a ${tenDigit} b ${thirteenDigit}`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  it('ignores an epoch-width digit run embedded in a longer token', () => {
    const content = `id-${String(DAY_EPOCH_MS + 12 * HOUR_MS + 123)}abc`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });
});

describe('scanTextBlobs — bare clocks', () => {
  it('reports a bare HH:MM:SS clock', () => {
    const clock = ['14', '30', '45'].join(':');

    const findings = scanTextBlobs([blob('docs/note.md', `at ${clock} done`)], []);

    expect(rulesOf(findings)).toEqual(['clock-seconds']);
  });

  it.each([
    ['a second past midnight', ['00', '00', '01']],
    ['a minute past midnight', ['00', '01', '00']],
    ['an hour past midnight', ['01', '00', '00']],
    ['a second before end of day', ['23', '59', '58']],
    ['a minute before end of day', ['23', '58', '59']],
    ['an hour before end of day', ['22', '59', '59']],
  ])('reports a clock %s', (_label, fields) => {
    const content = `at ${fields.join(':')} done`;

    expect(rulesOf(scanTextBlobs([blob('docs/note.md', content)], []))).toEqual(['clock-seconds']);
  });

  it('reports a bare clock written with a single-digit hour', () => {
    const clock = ['9', '30', '45'].join(':');

    const findings = scanTextBlobs([blob('docs/note.md', `at ${clock} done`)], []);

    expect(rulesOf(findings)).toEqual(['clock-seconds']);
  });

  it('passes a bare HH:MM:SS clock at the end-of-day boundary', () => {
    const clock = ['23', '59', '59'].join(':');

    const findings = scanTextBlobs([blob('docs/note.md', `at ${clock} done`)], []);

    expect(findings).toEqual([]);
  });

  it('passes an end-of-day clock whose subseconds are all nines', () => {
    const clock = `${['23', '59', '59'].join(':')}.999`;

    expect(scanTextBlobs([blob('docs/note.md', `at ${clock}`)], [])).toEqual([]);
  });

  it('ignores a colon-separated triple whose first field is no hour', () => {
    const triple = ['45', '30', '15'].join(':');

    expect(scanTextBlobs([blob('docs/note.md', `ratio ${triple}`)], [])).toEqual([]);
  });

  it('reports a strict bare HH:MM clock', () => {
    const clock = ['14', '30'].join(':');

    const findings = scanTextBlobs([blob('docs/note.md', `at ${clock} done`)], []);

    expect(rulesOf(findings)).toEqual(['clock-minutes']);
  });

  it('reports a strict bare HH:MM clock in the late-evening hour band', () => {
    const clock = ['21', '45'].join(':');

    const findings = scanTextBlobs([blob('docs/note.md', `at ${clock} done`)], []);

    expect(rulesOf(findings)).toEqual(['clock-minutes']);
  });

  it('passes a strict bare HH:MM clock at midnight', () => {
    const clock = ['00', '00'].join(':');

    const findings = scanTextBlobs([blob('docs/note.md', `at ${clock} done`)], []);

    expect(findings).toEqual([]);
  });

  it('ignores a ratio whose fields are not two-digit clock fields', () => {
    const findings = scanTextBlobs([blob('src/a.ts', 'aspect 16:9 and 9:16')], []);

    expect(findings).toEqual([]);
  });

  it('reports a clock inside an ISO datetime only once, as the ISO rule', () => {
    const findings = scanTextBlobs([blob('docs/note.md', ISO_INSTANT)], []);

    expect(rulesOf(findings)).toEqual(['iso-datetime']);
  });

  it('reports the minute-precision form of an ISO datetime only once', () => {
    const isoMinutes = ['2026-08-16', 'T', '14', ':', '30'].join('');

    const findings = scanTextBlobs([blob('docs/note.md', isoMinutes)], []);

    expect(rulesOf(findings)).toEqual(['iso-datetime']);
  });
});

/**
 * The report prints a shape in place of the value it withholds, so every shape
 * it prints becomes text in a run record — text this same gate then reads. A
 * shape that is itself a finding makes any document quoting one re-trigger the
 * rule that produced it, and the fix belongs to the renderer rather than to the
 * rule.
 */
describe('scanTextBlobs — the shapes the report prints in place of values', () => {
  it.each([
    ['an ISO datetime', 'docs/a.md', ISO_INSTANT],
    ['a separator-free datetime', 'docs/a.md', ['11111111', '111111Z'].join('')],
    ['a bare clock with seconds', 'docs/a.md', ['23', ':11:12'].join('')],
    ['a bare clock to the minute', 'docs/a.md', ['11', ':11'].join('')],
    ['a millisecond epoch', 'docs/a.md', ['1', '755302405000'].join('')],
    ['a second epoch', 'docs/a.md', ['1', '755302401'].join('')],
    [
      'a version-7 uuid',
      'docs/a.md',
      ['0198f2b1', '-1234', '-7abc', '-89de', '-0123456789ab'].join(''),
    ],
    ['a home directory', 'docs/a.md', HOME_PATH],
    ['a Windows home directory', 'docs/a.md', ['C:', 'Users', 'someone'].join('\\')],
    ['a named home shorthand', 'docs/a.md', `~${['someone', 'checkout'].join('/')}`],
    ['a temp path', 'docs/a.md', `${['', 'tmp', 'session-'].join('/')}91827.log`],
    ['a zone abbreviation', 'docs/a.md', 'JST'],
    ['an IANA zone', 'docs/a.md', ['Asia', 'Tokyo'].join('/')],
    ['a zone offset', 'docs/a.md', ['+', '05', ':', '30'].join('')],
    ['an am/pm clock beside a zone', 'docs/a.md', ['12', 'PM JST'].join('')],
    ['an RFC 1123 date', 'docs/a.md', ['Thu, 4 Jun 4444 11', ':11:11 GMT'].join('')],
    ['a date-constructor clock', 'src/a.test.ts', ['Date.', 'UTC(2026, 7, 16, 3, 4, 5)'].join('')],
  ])('prints no shape that is itself a finding for %s', (_label, path, value) => {
    const findings = scanTextBlobs([blob(path, value)], []);
    expect(findings.length).toBeGreaterThan(0);

    const printed = findings.map((finding) => finding.shape).join('\n');

    expect(scanTextBlobs([blob('docs/report.md', printed)], [])).toEqual([]);
  });
});

/**
 * A clock spelled as separate numeric arguments carries no separator for any
 * clock-shaped pattern to find, so every rule above reads straight past it.
 */
describe('scanTextBlobs — clocks written as date-constructor arguments', () => {
  it('reports a UTC construction carrying a time of day', () => {
    const call = ['Date.', 'UTC(2026, 7, 16, 3, 4, 5)'].join('');

    expect(rulesOf(scanTextBlobs([blob('src/a.test.ts', call)], []))).toEqual(['date-arguments']);
  });

  it('reports a local construction carrying a time of day', () => {
    const call = ['new ', 'Date(2026, 7, 16, 3, 4, 5)'].join('');

    expect(rulesOf(scanTextBlobs([blob('src/a.test.ts', call)], []))).toEqual(['date-arguments']);
  });

  it('reports an hour argument alone, with no minute or second beside it', () => {
    const call = ['Date.', 'UTC(2026, 7, 16, 12)'].join('');

    expect(rulesOf(scanTextBlobs([blob('src/a.test.ts', call)], []))).toEqual(['date-arguments']);
  });

  it('passes a construction of a calendar day, which carries no clock at all', () => {
    const call = ['Date.', 'UTC(2026, 7, 16)'].join('');

    expect(scanTextBlobs([blob('src/a.test.ts', call)], [])).toEqual([]);
  });

  it('passes clock arguments that sit on the start of the UTC day', () => {
    const call = ['Date.', 'UTC(2026, 7, 16, 0, 0, 0, 0)'].join('');

    expect(scanTextBlobs([blob('src/a.test.ts', call)], [])).toEqual([]);
  });

  it('passes clock arguments that sit on the last instant of the UTC day', () => {
    const call = ['Date.', 'UTC(2026, 7, 16, 23, 59, 59, 999)'].join('');

    expect(scanTextBlobs([blob('src/a.test.ts', call)], [])).toEqual([]);
  });

  it('reports a millisecond argument past the start of the day', () => {
    const call = ['Date.', 'UTC(2026, 7, 16, 0, 0, 0, 1)'].join('');

    expect(rulesOf(scanTextBlobs([blob('src/a.test.ts', call)], []))).toEqual(['date-arguments']);
  });

  it('passes a construction whose hour argument is not a literal', () => {
    const call = ['Date.', 'UTC(2026, 7, dayIndex, hourIndex)'].join('');

    expect(scanTextBlobs([blob('src/a.test.ts', call)], [])).toEqual([]);
  });

  it('reports a literal hour beside a day argument that is not one', () => {
    const call = ['Date.', 'UTC(2031, 0, dayOffset, 12, 0, 0)'].join('');

    expect(rulesOf(scanTextBlobs([blob('src/a.test.ts', call)], []))).toEqual(['date-arguments']);
  });

  it('reports a day-boundary hour whose minute argument cannot be read', () => {
    const call = ['Date.', 'UTC(2026, 7, 16, 0, offsetMinutes)'].join('');

    expect(rulesOf(scanTextBlobs([blob('src/a.test.ts', call)], []))).toEqual(['date-arguments']);
  });

  it('passes a single-argument construction, which names no field', () => {
    const call = ['new ', 'Date(1', '755302405000)'].join('');

    expect(rulesOf(scanTextBlobs([blob('src/a.test.ts', call)], []))).toEqual(['epoch-ms']);
  });
});

// The question that separates the causes the encoding rule reports: a blob nothing
// read, and a blob every rule read that quotes a byte on purpose. It is asked of the
// raw bytes, because the decoded text of the first is not its contents. It asks
// whether a reading this decode passed over holds two characters running, which is
// the least a rule can match — never whether the bytes bear that reading out, which
// a wide blob can fail while still having been read by nothing.
// Code points below this are the ones a UTF-16 code unit carries with a zero byte, so
// they are exactly the range the adjacency bound reasons about.
const ZERO_PADDED_CODE_POINT_LIMIT = 0x01_00;

describe('decodeBlob — text held in a reading the decode did not take', () => {
  const PROSE = 'used as a separator, in a sentence long enough to be ordinary';

  it.each([
    ['little-endian', (bytes: Buffer): Buffer => bytes],
    ['big-endian', (bytes: Buffer): Buffer => bytes.swap16()],
  ])('reports unmarked %s text, which no rule read', (_label, order) => {
    const bytes = order(Buffer.from(PROSE, 'utf16le'));

    expect(decodeBlob(bytes).carriesUnreadText).toBe(true);
  });

  // The byte count refuses a clean wide reading, which is evidence against that
  // reading and none at all that the narrow one was complete.
  it('reports wide text whose byte count rules out its own reading', () => {
    const bytes = Buffer.concat([Buffer.from(PROSE, 'utf16le'), Buffer.from([0x20])]);

    expect(decodeBlob(bytes).carriesUnreadText).toBe(true);
  });

  // Padding drives the NUL density below what taking the wide reading demands,
  // while the run of narrow characters inside it stays unread all the same.
  it('reports wide text padded past the density its reading needs', () => {
    const pad = '\u6F22'.repeat(40);
    const bytes = Buffer.from(`${pad}${PROSE}${pad}`, 'utf16le');

    expect(decodeBlob(bytes).carriesUnreadText).toBe(true);
  });

  it('reports none for prose quoting a NUL, which every rule read', () => {
    const bytes = Buffer.from(`${PROSE}\0 and it carries on`, 'utf8');

    expect(decodeBlob(bytes).carriesUnreadText).toBe(false);
  });

  it('reports none for a mark the payload does not bear out', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PROSE, 'utf8')]);

    expect(decodeBlob(bytes).carriesUnreadText).toBe(false);
  });

  it('reports none where the reading that holds the text is the one it took', () => {
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(PROSE, 'utf16le')]);

    expect(decodeBlob(bytes).carriesUnreadText).toBe(false);
  });

  // The taken reading here sees a character followed by a zero, never two adjacent
  // ones, so it read nothing of the value — while the pairs land on exactly the parity
  // the taken order excludes, and the other parity holds none because every fourth
  // byte is the character's own.
  it('reports a value at a four-byte code unit inside a corroborated blob', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('\u6F22'.repeat(64), 'utf16le'),
      Buffer.from('a'.repeat(200), 'utf16le'),
      wide32(ISO_INSTANT),
    ]);

    expect(decodeBlob(bytes).utf16).toBe(true);
    expect(decodeBlob(bytes).carriesUnreadText).toBe(true);
  });

  // Taking a wide reading is not covering every wide reading. A lead long enough to
  // carry the parity lets a region in the opposite byte order ride along inside a
  // blob the decode reads as corroborated, and that region is scanned by neither
  // interpretation — not the wide text, and not the raw bytes as narrow ones.
  it('reports text held in the byte order opposite the one it took', () => {
    const lead = Buffer.from('a note about nothing in particular '.repeat(4), 'utf16le');
    const reversed = Buffer.from(ISO_INSTANT, 'utf16le').swap16();
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      lead,
      Buffer.from([0x00, 0x00]),
      reversed,
    ]);

    expect(decodeBlob(bytes).utf16).toBe(true);
    expect(decodeBlob(bytes).carriesUnreadText).toBe(true);
  });

  // The mark claims one byte order and the payload holds its text in the other, so
  // the reading that carries the text is one the decode did not take.
  it('reports text held in the byte order its mark contradicts', () => {
    const payload = Buffer.from(PROSE, 'utf16le').swap16();
    const bytes = Buffer.concat([Buffer.from([0xff, 0xfe]), payload]);

    expect(decodeBlob(bytes).carriesUnreadText).toBe(true);
  });

  // The bound's derivation, and the whole of what it rests on: a reading holding fewer
  // than two characters running has nothing any rule could match. Swept by matching
  // rather than by reading pattern source, because a property escape spells characters
  // its source text does not contain.
  //
  // The range is the derivation's own: a code point below the two-byte boundary is what
  // a wide code unit pads with the zero this bound searches for. Sweeping only the
  // printable range would leave a rule matching a lone control or accented character
  // green here while the derivation it stands for had already failed.
  //
  // Dropping `g` is hygiene, not a hazard averted: `some` short-circuits at the first
  // match and a failed `test` resets `lastIndex`, so no call ever follows a match on the
  // same object and the verdict does not depend on the flag.
  it('matches no single code point a wide code unit pads, which is what the bound rests on', () => {
    const padded = Array.from({ length: ZERO_PADDED_CODE_POINT_LIMIT }, (_, code) =>
      String.fromCodePoint(code)
    );

    const matching = RULES.flatMap((rule) => {
      const unanchored = new RegExp(rule.pattern.source, rule.pattern.flags.replace('g', ''));
      return padded.some((character) => unanchored.test(character)) ? [rule.name] : [];
    });

    expect(matching).toEqual([]);
  });
});

// The admission the allowlist can write against a rule that pins no value. It is
// applied here because this is where the decode that answers the bound is in hand,
// and because a copy of it at each caller would be two things that have to agree.
describe('scanTextBlobs — a valueless finding an entry names', () => {
  const PROSE = 'used as a separator, in a sentence long enough to be ordinary';
  const named: PrivacyAllowlistEntry = {
    clause: 'content',
    description: 'the byte is the evidence the record is making',
    path: 'docs/note.md',
    rule: ENCODING_RULE,
    evidence: { is: 'a separator quoted in prose', shownBy: 'used as a separator' },
  };

  it('drops the finding on a blob whose contents every rule read', () => {
    const bytes = Buffer.from(`${PROSE}\0 and it carries on`, 'utf8');

    expect(scanTextBlobs([{ path: 'docs/note.md', bytes }], [named])).toEqual([]);
  });

  it('keeps the finding on a blob no rule read, whichever entry names it', () => {
    const bytes = Buffer.from(PROSE, 'utf16le');

    expect(rulesOf(scanTextBlobs([{ path: 'docs/note.md', bytes }], [named]))).toEqual([
      ENCODING_RULE,
    ]);
  });

  // Both of these are blobs no rule read: the only interpretation scanned is the
  // narrow one, which renders the wide text as mojibake, so the encoding finding is
  // the whole of the gate's signal on them. Silencing it silences everything.
  it('keeps the finding on a wide blob whose byte count rules out its own reading', () => {
    const wide = Buffer.from(`ran at ${ISO_INSTANT} in a note`, 'utf16le');
    const bytes = Buffer.concat([wide, Buffer.from([0x20])]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/note.md', bytes }], [named]))).toEqual([
      ENCODING_RULE,
    ]);
  });

  it('keeps the finding on a wide blob padded past the density its reading needs', () => {
    const pad = '\u6F22'.repeat(40);
    const bytes = Buffer.from(`${pad}ran at ${ISO_INSTANT}${pad}`, 'utf16le');

    expect(rulesOf(scanTextBlobs([{ path: 'docs/note.md', bytes }], [named]))).toEqual([
      ENCODING_RULE,
    ]);
  });

  // The corroborated decode is where the bound used to assert rather than ask. Without
  // an entry the encoding finding is the whole of the signal here: the instant sits in
  // the byte order neither interpretation reads, so no value rule ever names it.
  it('keeps the finding on a corroborated blob holding text in the opposite order', () => {
    const lead = Buffer.from('a note about nothing in particular '.repeat(4), 'utf16le');
    const reversed = Buffer.from(ISO_INSTANT, 'utf16le').swap16();
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      lead,
      Buffer.from([0x00, 0x00]),
      reversed,
    ]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/note.md', bytes }], []))).toEqual([ENCODING_RULE]);
    expect(rulesOf(scanTextBlobs([{ path: 'docs/note.md', bytes }], [named]))).toEqual([
      ENCODING_RULE,
    ]);
  });

  // The same construction at the scan, where the entry would buy the silence.
  it('keeps the finding on a blob hiding a value at a four-byte code unit', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('\u6F22'.repeat(64), 'utf16le'),
      Buffer.from('a'.repeat(200), 'utf16le'),
      wide32(ISO_INSTANT),
    ]);

    expect(rulesOf(scanTextBlobs([{ path: 'docs/note.md', bytes }], [named]))).toEqual([
      ENCODING_RULE,
    ]);
  });

  it('keeps the finding where no entry names the rule', () => {
    const bytes = Buffer.from(`${PROSE}\0 and it carries on`, 'utf8');

    expect(rulesOf(scanTextBlobs([{ path: 'docs/note.md', bytes }], []))).toEqual([ENCODING_RULE]);
  });
});

/**
 * Every reading below is obtained from a named instant and then masked, never
 * spelled: this file is scanned by the gate it tests with no exemption, and a
 * value assembled from pieces would be a match the gate cannot see, which is the
 * one route this repository forecloses for a detector's own fixtures.
 */
describe('scanTextBlobs — clock readings with a digit masked by hand', () => {
  const MASKING_LETTER = 'x';

  function readingOf(instant: number, fields: number): string {
    return new Date(instant).toISOString().slice(11, 11 + fields * 3 - 1);
  }

  function maskAt(reading: string, index: number): string {
    return reading.slice(0, index) + MASKING_LETTER + reading.slice(index + 1);
  }

  const AFTERNOON = TEST_DAY_START + 14 * HOUR_MS + 27 * MINUTE_MS + 38 * SECOND_MS;
  const MINUTES = readingOf(AFTERNOON, 2);
  const SECONDS = readingOf(AFTERNOON, 3);

  it.each([
    ['the units digit of the minute', maskAt(MINUTES, MINUTES.length - 1)],
    ['the tens digit of the minute', maskAt(MINUTES, MINUTES.length - 2)],
    ['the units digit of the hour', maskAt(MINUTES, 1)],
    ['the tens digit of the hour', maskAt(MINUTES, 0)],
    ['a digit of the second', maskAt(SECONDS, SECONDS.length - 1)],
  ])('reports a reading with %s replaced by a letter', (_label, value) => {
    const findings = scanTextBlobs([blob('docs/a.md', `ran at ${value}`)], []);

    expect(rulesOf(findings)).toEqual(['masked-digit-clock']);
  });

  it('reports the same reading in a source file, not only in prose', () => {
    const value = maskAt(MINUTES, MINUTES.length - 1);

    expect(rulesOf(scanTextBlobs([blob('src/a.ts', `// ran at ${value}`)], []))).toEqual([
      'masked-digit-clock',
    ]);
  });

  it('prints a shape carrying the masking letter rather than the reading', () => {
    const [finding] = scanTextBlobs(
      [blob('docs/a.md', `ran at ${maskAt(MINUTES, MINUTES.length - 1)}`)],
      []
    );

    expect(finding?.shape).toBe(`NN:N${MASKING_LETTER}`);
  });

  it('is silent where the whole field is letters, which is a placeholder', () => {
    const value = maskAt(maskAt(MINUTES, MINUTES.length - 1), MINUTES.length - 2);

    expect(scanTextBlobs([blob('docs/a.md', `format ${value}`)], [])).toEqual([]);
  });

  it('is silent on the unmasked reading, which the bare-clock rules already read', () => {
    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `ran at ${MINUTES}`)], []))).toEqual([
      'clock-minutes',
    ]);
  });

  /**
   * The first two carry the guards: the hardware address offers this shape at
   * two of its fields and each offer has a colon on one side, and the word tail
   * offers it with a letter on the left. The rest are silent because no field of
   * theirs is masked at all — they record what the rule is meant to leave alone
   * and pin nothing about the guards, which is why the two that do are named.
   */
  it.each([
    ['a hardware address', 'iface 01:20:3f:44:5e:60'],
    ['a masked-looking tail of a longer word', 'worker2b:30 started'],
    ['a lint position', 'src/a.ts:12:5 reported'],
    ['a port', 'http://localhost:3000/health'],
    ['an aspect ratio', 'render at 16:9 and 4:3'],
    ['an identifier pair', "expect(calls).toEqual(['c1:u1'])"],
    ['a ratio of two counts', 'passes to failures ran 50:50'],
  ])('is silent on %s', (_label, value) => {
    expect(scanTextBlobs([blob('docs/a.md', value)], [])).toEqual([]);
  });
});

describe('scanTextBlobs — epochs carrying a fractional part', () => {
  const NOON = TEST_DAY_START + 12 * HOUR_MS;

  it.each([
    ['epoch-seconds', String(NOON / SECOND_MS)],
    ['epoch-ms', String(NOON)],
  ])('reports a %s value written with a fraction', (rule, integer) => {
    const findings = scanTextBlobs([blob('src/a.ts', `at ${integer}.25`)], []);

    expect(rulesOf(findings)).toEqual([rule]);
  });

  it.each([
    ['epoch-seconds', String(NOON / SECOND_MS)],
    ['epoch-ms', String(NOON)],
  ])('reports a %s fraction that ends a sentence', (rule, integer) => {
    const findings = scanTextBlobs([blob('src/a.ts', `ran at ${integer}.25.`)], []);

    expect(rulesOf(findings)).toEqual([rule]);
  });

  it('passes a day-boundary epoch whose fraction is all zeros', () => {
    const content = `stamp ${String(TEST_DAY_START / SECOND_MS)}.000`;

    expect(scanTextBlobs([blob('src/a.ts', content)], [])).toEqual([]);
  });

  it.each([
    ['a word character follows the fraction', `${String(NOON / SECOND_MS)}.25n`],
    ['the separator is followed by letters', `${String(NOON / SECOND_MS)}.beta`],
    ['the separator ends the value with no fraction', `${String(NOON / SECOND_MS)}.`],
  ])('stays silent where %s', (_label, value) => {
    expect(scanTextBlobs([blob('src/a.ts', `at ${value}`)], [])).toEqual([]);
  });
});

describe('scanTextBlobs — a named home shorthand inside a URL', () => {
  const SHORTHAND = `~${['someone', 'papers'].join('/')}`;

  it('is silent where the shorthand is a path segment of a URL', () => {
    const content = `see https://example.test/${SHORTHAND}/paper.pdf`;

    expect(scanTextBlobs([blob('docs/a.md', content)], [])).toEqual([]);
  });

  it('still reports the same shorthand written as a path of its own', () => {
    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${SHORTHAND}/`)], []))).toEqual([
      'absolute-host-path',
    ]);
  });

  it('still reports a rooted path, which a URL cannot make innocent', () => {
    const rooted = ['', 'home', 'someone', 'checkout'].join('/');

    expect(rulesOf(scanTextBlobs([blob('docs/a.md', `see ${rooted}/`)], []))).toEqual([
      'absolute-host-path',
    ]);
  });
});
