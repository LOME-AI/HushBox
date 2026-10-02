import { describe, expect, it } from 'vitest';

import { BINARY_FORMATS } from './format-registry.js';
import { PNG_SIGNATURE } from './png.js';
import {
  classifyBinaryBlob,
  isBinaryBlob,
  isBinaryExemption,
  scanBinaryBlob,
  sweepCodedPayload,
} from './scan.js';
import type { ScanRange } from './format-registry.js';
import type { BinaryFinding } from './scan.js';
import type { PrivacyAllowlistEntry } from '../allowlist.js';

/** Specimens are assembled at runtime; see the note in `leak-values.test.ts`. */
const DAY = '2026-01-02';
const pad = (value: number): string => String(value).padStart(2, '0');
const clockOf = (hour: number, minute: number, second: number): string =>
  [hour, minute, second].map((part) => pad(part)).join(':');
const isoAt = (hour: number, minute: number, second: number): string =>
  `${DAY}T${clockOf(hour, minute, second)}Z`;

const EXEMPT_PATH = 'packages/ui/src/assets/vendored-artwork.png';
const EXEMPT_ENTRY: PrivacyAllowlistEntry = {
  clause: 'provenance',
  description: 'upstream binary whose disclosing values are packed fields, not text',
  path: EXEMPT_PATH,
};

const chunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
};

const png = (...chunks: readonly Buffer[]): Buffer =>
  Buffer.concat([
    Buffer.from(PNG_SIGNATURE),
    chunk('IHDR', Buffer.alloc(13)),
    ...chunks,
    chunk('IEND', Buffer.alloc(0)),
  ]);

const textChunk = (keyword: string, value: string): Buffer =>
  chunk('tEXt', Buffer.concat([Buffer.from(keyword), Buffer.from([0]), Buffer.from(value)]));

const box = (type: string, body: Buffer): Buffer => {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(body.length + 8);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, body]);
};

const mp4 = (...boxes: readonly Buffer[]): Buffer =>
  Buffer.concat([box('ftyp', Buffer.from('isom0000', 'latin1')), ...boxes]);

const rulesOf = (findings: readonly { readonly rule: string }[]): string[] =>
  findings.map((finding) => finding.rule);

describe('isBinaryBlob', () => {
  it('treats a blob containing a NUL byte as binary', () => {
    expect(isBinaryBlob(Buffer.from([0x61, 0x00, 0x62]))).toBe(true);
  });

  it('treats plain text as not binary', () => {
    expect(isBinaryBlob(Buffer.from('a line of text\n', 'utf8'))).toBe(false);
  });

  it('only inspects the leading bytes', () => {
    const bytes = Buffer.concat([Buffer.alloc(9000, 0x61), Buffer.from([0])]);
    expect(isBinaryBlob(bytes)).toBe(false);
  });

  it('treats a blob whose only NUL is its first byte as binary', () => {
    expect(isBinaryBlob(Buffer.from([0x00, 0x61, 0x62]))).toBe(true);
  });

  /**
   * The window's own endpoints, not members of the band below: a window one byte
   * short routes a blob the binary gate would have claimed to the text gate,
   * which defers to this registry for binaries and so looks at nothing.
   */
  it('sniffs the last byte of the window and no byte past it', () => {
    const at = (distance: number): Buffer =>
      Buffer.concat([Buffer.alloc(distance, 0x61), Buffer.from([0])]);
    expect(isBinaryBlob(at(7999))).toBe(true);
    expect(isBinaryBlob(at(8000))).toBe(false);
  });

  /**
   * This predicate routes a blob between the two gates, so narrowing it makes
   * the binary gate examine less while nothing goes red. Written against the
   * literal distance rather than the constant, and sized past every value a
   * shorter window would admit.
   */
  it.each([[600], [4000], [7900]])(
    'still sniffs a blob whose first NUL sits %i bytes in',
    (distance) => {
      const bytes = Buffer.concat([Buffer.alloc(distance, 0x61), Buffer.from([0])]);
      expect(isBinaryBlob(bytes)).toBe(true);
    }
  );
});

describe('scanBinaryBlob', () => {
  it('reports nothing for a container carrying no metadata', () => {
    expect(scanBinaryBlob('image.png', png())).toEqual([]);
  });

  it('reports a metadata carrier on its own', () => {
    const findings = scanBinaryBlob('image.png', png(textChunk('Software', 'a tool')));
    expect(rulesOf(findings)).toContain('metadata-carrier');
  });

  it('names the format and the structural location of a finding', () => {
    const [finding] = scanBinaryBlob('image.png', png(textChunk('Software', 'a tool')));
    expect(finding?.format).toBe('png');
    expect(finding?.location).toBe('tEXt');
    expect(finding?.kind).toBe('png:tEXt');
  });

  it('reports a value leak found inside a metadata region', () => {
    const findings = scanBinaryBlob(
      'image.png',
      png(textChunk('Comment', `rendered ${isoAt(3, 4, 5)}`))
    );
    expect(rulesOf(findings)).toContain('iso-datetime');
  });

  it('never echoes the matched value in a finding', () => {
    const findings = scanBinaryBlob(
      'image.png',
      png(textChunk('Comment', `rendered ${isoAt(3, 4, 5)}`))
    );
    for (const finding of findings) {
      expect(finding.shape).not.toContain(clockOf(3, 4, 5));
    }
  });

  it('reports a fixed-width timestamp field carrying a time of day', () => {
    const header = Buffer.alloc(20);
    header.writeUInt32BE(2_082_844_800 + 3600, 4);
    const findings = scanBinaryBlob('clip.mp4', mp4(box('moov', box('mvhd', header))));
    expect(rulesOf(findings)).toEqual(['timestamp-field']);
  });

  it('passes a fixed-width timestamp field landing on a day boundary', () => {
    const header = Buffer.alloc(20);
    header.writeUInt32BE(2_082_844_800 + 86_400, 4);
    expect(scanBinaryBlob('clip.mp4', mp4(box('moov', box('mvhd', header))))).toEqual([]);
  });

  it('reports a toolchain literal buried in the coded payload', () => {
    const payload = Buffer.concat([
      Buffer.alloc(32),
      Buffer.from('x264 - core 163', 'latin1'),
      Buffer.alloc(32),
    ]);
    const findings = scanBinaryBlob('clip.mp4', mp4(box('mdat', payload)));
    expect(rulesOf(findings)).toEqual(['toolchain-identity']);
    expect(findings[0]?.location).toBe('mdat');
  });

  it('reports a blob whose magic bytes match no registered format', () => {
    const findings = scanBinaryBlob('mystery.bin', Buffer.from('\0\0not a container', 'latin1'));
    expect(rulesOf(findings)).toEqual(['unrecognized-format']);
  });

  it('reports an extension that contradicts the magic bytes', () => {
    const findings = scanBinaryBlob('actually-a-png.gif', png());
    expect(rulesOf(findings)).toEqual(['extension-mismatch']);
    expect(findings[0]?.shape).toContain('PNG image');
  });

  it('accepts every extension a format legitimately wears', () => {
    expect(scanBinaryBlob('audio.m4a', mp4())).toEqual([]);
  });

  it('ignores extension case', () => {
    expect(scanBinaryBlob('IMAGE.PNG', png())).toEqual([]);
  });

  it('does not report a mismatch for an extensionless name', () => {
    expect(scanBinaryBlob('image', png())).toEqual([]);
  });

  /**
   * The extension test is membership, and membership is exact in both
   * directions. `extension-mismatch` is in the class an exemption cannot absorb,
   * so it is the one rule that makes a human look at a binary wearing a name its
   * bytes contradict; widened either way — a declared extension that begins with
   * the name's, or a name that begins with a declared one — that report is
   * simply lost, and the blob passes under a name nobody approved.
   */
  it.each([
    ['is a prefix of one the format declares', 'image.pn'],
    ['has one the format declares as its prefix', 'image.pngx'],
  ])('reports an extension that %s', (_label, name) => {
    expect(rulesOf(scanBinaryBlob(name, png()))).toEqual(['extension-mismatch']);
  });
});

// The shape question on its own, published because the tracked-tree sweep needs the
// same answer to say which entries are binary exemptions at all. A second copy of it
// there went stale the moment the rule-named shape was refused here, and could not
// have caught itself: with no rule-keyed entry shipped, both readings name the same
// entries and a stale copy stays green.
describe('isBinaryExemption', () => {
  it('accepts an entry that names neither a literal nor a rule', () => {
    expect(isBinaryExemption(EXEMPT_ENTRY)).toBe(true);
  });

  it('refuses an entry that pins literals, which is a text exemption', () => {
    expect(isBinaryExemption({ ...EXEMPT_ENTRY, literals: ['some approved string'] })).toBe(false);
  });

  it('refuses an entry that names a rule, which approves a rule and not a blob', () => {
    expect(
      isBinaryExemption({
        ...EXEMPT_ENTRY,
        clause: 'content',
        rule: 'undecodable-encoding',
        evidence: { is: 'a separator quoted in prose', shownBy: 'used as a separator' },
      })
    ).toBe(false);
  });
});

describe('classifyBinaryBlob', () => {
  it('calls a container with no findings clean', () => {
    expect(classifyBinaryBlob('image.png', png(), []).verdict).toBe('clean');
  });

  it('calls a container with findings dirty', () => {
    expect(classifyBinaryBlob('image.png', png(textChunk('Software', 't')), []).verdict).toBe(
      'dirty'
    );
  });

  it('calls an allowlisted container with findings exempt rather than clean', () => {
    const classification = classifyBinaryBlob(EXEMPT_PATH, png(textChunk('Software', 't')), [
      EXEMPT_ENTRY,
    ]);
    expect(classification.verdict).toBe('exempt');
  });

  it('keeps the findings of an exempt container visible', () => {
    const classification = classifyBinaryBlob(EXEMPT_PATH, png(textChunk('Software', 't')), [
      EXEMPT_ENTRY,
    ]);
    expect(classification.findings.length).toBeGreaterThan(0);
  });

  it('calls an allowlisted container with no findings clean, not exempt', () => {
    expect(classifyBinaryBlob(EXEMPT_PATH, png(), [EXEMPT_ENTRY]).verdict).toBe('clean');
  });

  it('refuses to exempt on an entry that pins literals', () => {
    const narrowed: PrivacyAllowlistEntry = { ...EXEMPT_ENTRY, literals: ['some approved string'] };
    expect(
      classifyBinaryBlob(EXEMPT_PATH, png(textChunk('Software', 't')), [narrowed]).verdict
    ).toBe('dirty');
  });

  // A rule-keyed entry pins no literal, so a literals-absent test alone reads it as
  // the binary form and hands it the whole blob. What its reviewer approved is one
  // text rule on one path, which is a different decision from exempting an artifact
  // whole, and the entry itself is what says which decision was made.
  it('refuses to exempt on an entry keyed on a rule name, which approves a rule and not a blob', () => {
    const ruleKeyed: PrivacyAllowlistEntry = {
      ...EXEMPT_ENTRY,
      clause: 'content',
      rule: 'undecodable-encoding',
      evidence: { is: 'a separator quoted in prose', shownBy: 'used as a separator' },
    };
    expect(
      classifyBinaryBlob(EXEMPT_PATH, png(textChunk('Software', 't')), [ruleKeyed]).verdict
    ).toBe('dirty');
  });

  it('normalizes a Windows-separated path before matching the allowlist', () => {
    const windowsPath = EXEMPT_PATH.replaceAll('/', '\\');
    expect(
      classifyBinaryBlob(windowsPath, png(textChunk('Software', 't')), [EXEMPT_ENTRY]).verdict
    ).toBe('exempt');
  });

  it('does not exempt a different path carrying the same bytes', () => {
    expect(
      classifyBinaryBlob('elsewhere.png', png(textChunk('Software', 't')), [EXEMPT_ENTRY]).verdict
    ).toBe('dirty');
  });

  // Exact equality is the contract on the path half as well as the literal half:
  // a sibling that widened it to a prefix or a containment would exempt files no
  // one wrote an entry for, and both directions are reachable from one entry.
  // The sibling text gate pins the same two shapes against the same predicate.
  it.each([
    ['a path the entry is a prefix of', `${EXEMPT_PATH}.bak`],
    ['a path the entry names the directory of', `${EXEMPT_PATH}/inner.png`],
    ['a path that is a prefix of the entry', EXEMPT_PATH.slice(0, -1)],
    ['a path the entry sits in a directory of', EXEMPT_PATH.slice(0, EXEMPT_PATH.lastIndexOf('/'))],
  ])('does not exempt %s', (_label, scanned) => {
    expect(
      classifyBinaryBlob(scanned, png(textChunk('Software', 't')), [EXEMPT_ENTRY]).verdict
    ).toBe('dirty');
  });
});

/** A PNG whose first chunk declares a length the blob cannot hold. */
const damagedPng = (): Buffer => {
  const overrun = Buffer.concat([
    Buffer.from([0, 0, 0, 200]),
    Buffer.from('tEXt'),
    Buffer.alloc(1),
  ]);
  return Buffer.concat([Buffer.from(PNG_SIGNATURE), overrun]);
};

/**
 * The seam, not the parser.
 *
 * Every parser's refusal is well pinned at `parse()`, but nothing routed a
 * malformed region through the classifier — so deleting the conversion,
 * throwing inside it, or reporting it under another rule all left the suite
 * green while a damaged container read clean again.
 */
describe('classifyBinaryBlob — a refusal reaches the verdict', () => {
  const damagedMp4 = (): Buffer => {
    const overrun = Buffer.alloc(8);
    overrun.writeUInt32BE(9999);
    overrun.write('uuid', 4, 'latin1');
    return Buffer.concat([box('ftyp', Buffer.from('isom0000', 'latin1')), overrun]);
  };

  const overDeepMp4 = (): Buffer => {
    let nested = box('mvhd', Buffer.alloc(20));
    for (let depth = 0; depth < 64; depth++) nested = box('moov', nested);
    return Buffer.concat([box('ftyp', Buffer.from('isom0000', 'latin1')), nested]);
  };

  const trailingPng = (): Buffer => Buffer.concat([png(), Buffer.alloc(5, 0x41)]);

  it.each([
    ['mid-stream framing damage', 'image.png', damagedPng()],
    ['a box walk that stops parsing', 'clip.mp4', damagedMp4()],
    ['container nesting past the depth limit', 'clip.mp4', overDeepMp4()],
    ['bytes the framing never accounts for', 'image.png', trailingPng()],
  ])('reports %s as dirty with an unparseable-structure finding', (_label, name, bytes) => {
    const { verdict, findings } = classifyBinaryBlob(name, bytes, []);
    expect(verdict).toBe('dirty');
    expect(findings.map((finding) => finding.rule)).toContain('unparseable-structure');
  });

  it('carries the refusal shape from the parser through to the finding', () => {
    const [finding] = scanBinaryBlob('image.png', damagedPng());
    expect(finding?.rule).toBe('unparseable-structure');
    expect(finding?.shape.length).toBeGreaterThan(0);
  });

  it('leaves an undamaged container free of any refusal', () => {
    const rules = scanBinaryBlob('image.png', png()).map((finding) => finding.rule);
    expect(rules).not.toContain('unparseable-structure');
  });
});

/**
 * An exemption is granted for known third-party content; content the gate could
 * not read is not that content. Without this the verdict reads as a pass while
 * the gate examined nothing.
 */
describe('classifyBinaryBlob — an exemption cannot absorb a refusal', () => {
  it('refuses to exempt an allowlisted path whose bytes will not parse', () => {
    const { verdict } = classifyBinaryBlob(EXEMPT_PATH, damagedPng(), [EXEMPT_ENTRY]);
    expect(verdict).toBe('dirty');
  });

  it('refuses to exempt an allowlisted path carrying unaccounted trailing bytes', () => {
    const bytes = Buffer.concat([png(), Buffer.alloc(5, 0x41)]);
    expect(classifyBinaryBlob(EXEMPT_PATH, bytes, [EXEMPT_ENTRY]).verdict).toBe('dirty');
  });

  it('refuses to exempt an allowlisted path holding bytes of no known container', () => {
    const bytes = Buffer.from('not any container at all', 'latin1');
    expect(classifyBinaryBlob(EXEMPT_PATH, bytes, [EXEMPT_ENTRY]).verdict).toBe('dirty');
  });

  it('refuses to exempt an allowlisted path holding a well-formed file of another format', () => {
    // An entry names a specific vendored artifact. A parseable image at a font's
    // path is not that artifact, however well formed it is.
    const bytes = png(textChunk('Software', 'some other tool'));
    expect(
      classifyBinaryBlob('packages/ui/src/styles/fonts/vendored.woff2', bytes, [
        {
          clause: 'provenance',
          description: 'upstream font',
          path: 'packages/ui/src/styles/fonts/vendored.woff2',
        },
      ]).verdict
    ).toBe('dirty');
  });

  it('still exempts the allowlisted path when the bytes parse', () => {
    const bytes = png(textChunk('Software', 'a vendored tool'));
    expect(classifyBinaryBlob(EXEMPT_PATH, bytes, [EXEMPT_ENTRY]).verdict).toBe('exempt');
  });
});

/**
 * A lossy or lossless coded payload is not opaque to its own encoder: LAME
 * drains its version string into the unused ancillary bits of the frames it
 * writes, so a stripped tag leaves the identity behind in the audio. Measured
 * on this repository's own recordings, where it survives every metadata remedy.
 */
const MPEG_FRAME_BYTES = 417;

const mp3Frame = (fill: Buffer = Buffer.alloc(0)): Buffer =>
  Buffer.concat([
    Buffer.from([0xff, 0xfb, 0x90, 0x00]),
    fill,
    Buffer.alloc(MPEG_FRAME_BYTES - 4 - fill.length),
  ]);

const flacBlock = (type: number, body: Buffer, last = false): Buffer => {
  const header = Buffer.alloc(4);
  header[0] = (last ? 0x80 : 0) | type;
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
};

const flacStream = (audio: Buffer): Buffer =>
  Buffer.concat([
    Buffer.from('fLaC', 'latin1'),
    flacBlock(0, Buffer.alloc(34), true),
    Buffer.from([0xff, 0xf8]),
    audio,
  ]);

describe('scanBinaryBlob — an encoder banner inside a coded payload', () => {
  const banner = Buffer.from(['LAME', '3.100'].join(''), 'latin1');

  it('reports a banner an encoder left in the MPEG frames', () => {
    const bytes = Buffer.concat([mp3Frame(), mp3Frame(banner)]);
    expect(rulesOf(scanBinaryBlob('bed.mp3', bytes))).toEqual(['toolchain-identity']);
  });

  it('names the payload rather than the banner it found there', () => {
    const bytes = Buffer.concat([mp3Frame(), mp3Frame(banner)]);
    const [finding] = scanBinaryBlob('bed.mp3', bytes);
    expect(finding).toMatchObject({ location: 'frames', shape: 'audio encoder identity string' });
  });

  it('does not re-read the tag the block walk already reported', () => {
    const bytes = Buffer.concat([mp3Frame(), mp3Frame()]);
    expect(scanBinaryBlob('bed.mp3', bytes)).toEqual([]);
  });

  it('reports a banner an encoder left in the FLAC audio', () => {
    expect(rulesOf(scanBinaryBlob('take.flac', flacStream(banner)))).toEqual([
      'toolchain-identity',
    ]);
  });

  it('reports nothing for coded audio carrying no known banner', () => {
    expect(scanBinaryBlob('take.flac', flacStream(Buffer.alloc(64)))).toEqual([]);
  });
});

/**
 * The sweep is the one path in the gate that walks bytes the file chose the
 * extent of, and it had no meter at all. The bound belongs on the work rather
 * than on what the work produced: a payload that yields no hit still costs its
 * own length to search, so counting findings can never bound it.
 */
describe('the coded-payload sweep is metered', () => {
  const mp3Format = BINARY_FORMATS.find((format) => format.id === 'mp3');
  const banner = Buffer.from(['LAME', '3.100'].join(''), 'latin1');
  const payload = Buffer.concat([Buffer.alloc(16), banner]);

  const sweep = (ranges: readonly ScanRange[]): BinaryFinding[] => {
    if (mp3Format === undefined) throw new Error('the registry lost its audio format');
    return sweepCodedPayload('bed.mp3', mp3Format, payload, ranges);
  };

  // Written as literals rather than read out of the module under test: a
  // fixture derived from the constant it pins moves with any mutation of it.
  const OVER_CEILING = 2_147_483_649;

  it('does not search a range that costs more than one blob may spend', () => {
    const findings = sweep([{ location: 'frames', start: 0, end: OVER_CEILING }]);

    expect(findings.map((finding) => finding.rule)).toEqual(['unparseable-structure']);
    expect(findings[0]?.kind).toBe('blob:budget');
  });

  it('stops at the range that spent the budget rather than sweeping the next one', () => {
    const findings = sweep([
      { location: 'frames', start: 0, end: OVER_CEILING },
      { location: 'frames', start: 0, end: payload.length },
    ]);

    expect(findings.map((finding) => finding.rule)).toEqual(['unparseable-structure']);
  });

  it('sweeps a range inside the budget', () => {
    const findings = sweep([{ location: 'frames', start: 0, end: payload.length }]);

    expect(findings.map((finding) => finding.rule)).toEqual(['toolchain-identity']);
  });

  it('sweeps a payload inside the budget without a refusal', () => {
    const bytes = Buffer.concat([mp3Frame(), mp3Frame(), Buffer.alloc(1_000_000)]);
    expect(scanBinaryBlob('bed.mp3', bytes)).toEqual([]);
  });
});
