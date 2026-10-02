import { describe, expect, it } from 'vitest';

import { DAY_MS, SECOND_MS, TEST_DAY_START } from '@hushbox/shared/test-time';

import { TOOLCHAIN_LITERALS, detectLeakValues, scanBitstreamLiterals } from './leak-values.js';

/**
 * Every disclosure specimen in this file is assembled at runtime from parts.
 * A gate's own tests are the last place a literal timestamp or host path may be
 * written down: the value is a specimen of what the rule detects, not a
 * description of its shape, so no allowlist entry could ever admit it — and an
 * entry that did would disable detection exactly where detection is defined.
 */
const DAY = '2026-01-02';
const pad = (value: number): string => String(value).padStart(2, '0');
const clockOf = (hour: number, minute: number, second: number): string =>
  [hour, minute, second].map((part) => pad(part)).join(':');

interface IsoParts {
  readonly fraction?: string;
  readonly zone?: string;
}

const isoAt = (hour: number, minute: number, second: number, parts: IsoParts = {}): string =>
  `${DAY}T${clockOf(hour, minute, second)}${parts.fraction ?? ''}${parts.zone ?? 'Z'}`;

const compactAt = (hour: number, minute: number, second: number): string =>
  `${DAY.replaceAll('-', '')}${pad(hour)}${pad(minute)}${pad(second)}Z`;

const hostPath = (root: string, ...segments: readonly string[]): string =>
  ['', root, ...segments].join('/');

const tildeHome = (name: string, ...segments: readonly string[]): string =>
  [`~${name}`, ...segments].join('/');

const drivePath = (drive: string, separator: string, ...segments: readonly string[]): string =>
  `${drive}:${separator}${segments.join(separator)}`;

/** Day arithmetic comes from the run's shared test-time module, never re-derived here. */
const DAY_BOUNDARY_MS = TEST_DAY_START;
const DAY_BOUNDARY_SECONDS = TEST_DAY_START / SECOND_MS;

/**
 * A digit run in the grouped spelling a hand-written numeric literal takes.
 * Derived from the digits: a grouped sub-day instant written out here would be a
 * specimen in the bytes, which this file's header forbids.
 */
const groupDigits = (digits: string): string => digits.replaceAll(/\B(?=(?:\d{3})+$)/gu, '_');

const rulesOf = (text: string): string[] => detectLeakValues(text).map((leak) => leak.rule);

describe('detectLeakValues — ISO datetimes', () => {
  it('reports an ISO datetime carrying a time of day', () => {
    expect(rulesOf(`created ${isoAt(3, 4, 5)}`)).toContain('iso-datetime');
  });

  it('passes an ISO datetime at exact midnight', () => {
    expect(rulesOf(`created ${isoAt(0, 0, 0)}`)).toEqual([]);
  });

  it('passes an ISO datetime at the end-of-day boundary', () => {
    expect(rulesOf(`created ${isoAt(23, 59, 59, { fraction: '.999' })}`)).toEqual([]);
  });

  it('passes an end-of-day boundary written with zero subseconds', () => {
    expect(rulesOf(`created ${isoAt(23, 59, 59, { fraction: '.000' })}`)).toEqual([]);
  });

  it('passes a bare day-resolution date', () => {
    expect(rulesOf(`created ${DAY}`)).toEqual([]);
  });

  it('reports a space-separated datetime', () => {
    expect(rulesOf(`stamp ${DAY} ${clockOf(8, 30, 0)}`)).toContain('iso-datetime');
  });

  it('reports a midnight clock carried under a non-zero zone offset', () => {
    expect(rulesOf(`created ${isoAt(0, 0, 0, { zone: '+05:30' })}`)).toContain('iso-datetime');
  });

  it('passes a midnight clock under an explicit zero offset', () => {
    expect(rulesOf(`created ${isoAt(0, 0, 0, { zone: '+00:00' })}`)).toEqual([]);
  });

  it('passes a midnight clock carrying no zone at all', () => {
    expect(rulesOf(`created ${isoAt(0, 0, 0, { zone: '' })}`)).toEqual([]);
  });
});

describe('detectLeakValues — ASN.1 GeneralizedTime', () => {
  it('reports a 14-digit GeneralizedTime with a time of day', () => {
    expect(rulesOf(`signedAt ${compactAt(3, 4, 5)}`)).toContain('generalized-time');
  });

  it('passes a GeneralizedTime at midnight', () => {
    expect(rulesOf(`signedAt ${compactAt(0, 0, 0)}`)).toEqual([]);
  });
});

describe('detectLeakValues — bare clocks', () => {
  it('reports a bare clock at second resolution', () => {
    expect(rulesOf(`at ${clockOf(7, 41, 22)} in the run`)).toContain('clock');
  });

  it('passes the midnight clock literal', () => {
    expect(rulesOf(`at ${clockOf(0, 0, 0)} in the run`)).toEqual([]);
  });

  it('passes the end-of-day clock literal', () => {
    expect(rulesOf(`at ${clockOf(23, 59, 59)} in the run`)).toEqual([]);
  });

  it('does not double-report the clock inside an ISO datetime', () => {
    expect(rulesOf(isoAt(3, 4, 5))).toEqual(['iso-datetime']);
  });
});

describe('detectLeakValues — epochs', () => {
  it('reports a 13-digit millisecond epoch', () => {
    expect(rulesOf(`ts=${String(DAY_BOUNDARY_MS + 60_000)}`)).toContain('epoch-millis');
  });

  it('passes a 13-digit epoch in the first second of a day', () => {
    expect(rulesOf(`ts=${String(DAY_BOUNDARY_MS)}`)).toEqual([]);
  });

  it('reports a 10-digit second epoch', () => {
    expect(rulesOf(`ts ${String(DAY_BOUNDARY_SECONDS + 3600)} end`)).toContain('epoch-seconds');
  });

  it('passes a 10-digit epoch at exact midnight', () => {
    expect(rulesOf(`ts ${String(DAY_BOUNDARY_SECONDS)} end`)).toEqual([]);
  });

  it('ignores a digit run glued to an identifier', () => {
    expect(rulesOf(`build_${String(DAY_BOUNDARY_MS + 60_000)}x`)).toEqual([]);
  });

  /**
   * The separator posture. A grouped run denotes the same instant as a
   * contiguous one, so both spellings are read: the digit run tolerates the
   * separator and the classifier strips it before the era window and the
   * day-boundary carve-out are consulted.
   *
   * The first two carry a sub-day specimen and enforce that themselves: they
   * assert a report, so a whole-day value reds them rather than passing on the
   * carve-out's silence.
   *
   * The third case is that carve-out, and it is what proves the classifier
   * reaches it THROUGH the separators: read raw, a grouped run is NaN, which
   * sits on no day boundary, so every grouped instant would be reported —
   * the exempt ones included.
   */
  const SEPARATOR_SPECIMEN_MS = DAY_BOUNDARY_MS + 60_000;

  it('reports an underscore-separated numeric literal', () => {
    expect(rulesOf(`const ttl = ${groupDigits(String(SEPARATOR_SPECIMEN_MS))};`)).toContain(
      'epoch-millis'
    );
  });

  it('reports that same literal with its separators removed', () => {
    expect(rulesOf(`const ttl = ${String(SEPARATOR_SPECIMEN_MS)};`)).toContain('epoch-millis');
  });

  it('passes an underscore-separated literal on a UTC day boundary', () => {
    expect(rulesOf(`const ttl = ${groupDigits(String(DAY_BOUNDARY_MS))};`)).toEqual([]);
  });

  it('ignores a digit run outside the plausible era', () => {
    expect(rulesOf('code 9999999999 end')).toEqual([]);
  });
});

/**
 * The carve-out these two pin used to admit the last second of a day for both
 * epoch widths. It was ruled out, and the ruled predicate now lives in the
 * repository's one instants module — so these are the evidence the collapse
 * actually changed behaviour rather than merely moving code.
 */
describe('detectLeakValues — the end-of-day epoch admission that was ruled out', () => {
  it('reports a 10-digit epoch at the last second of a day', () => {
    expect(rulesOf(`ts ${String(DAY_BOUNDARY_SECONDS - 1)} end`)).toContain('epoch-seconds');
  });

  it('reports a 13-digit epoch in the last second of a day', () => {
    expect(rulesOf(`ts=${String(DAY_BOUNDARY_MS - 1)}`)).toContain('epoch-millis');
  });
});

describe('detectLeakValues — uuidv7', () => {
  const uuidWithMillis = (millis: number): string => {
    const hex = millis.toString(16).padStart(12, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
  };

  it('reports a version-7 uuid whose embedded clock is mid-day', () => {
    expect(rulesOf(uuidWithMillis(DAY_BOUNDARY_MS + 60_000))).toContain('uuidv7');
  });

  it('passes a version-7 uuid whose embedded clock is a day boundary', () => {
    expect(rulesOf(uuidWithMillis(DAY_BOUNDARY_MS))).toEqual([]);
  });

  it('ignores a version-4 uuid', () => {
    expect(rulesOf('9b2c1d4e-5f60-4a71-8b92-0123456789ab')).toEqual([]);
  });

  it('reports a uuid abutted by framing bytes that decoded as hex', () => {
    const specimen = uuidWithMillis(DAY_BOUNDARY_MS + 60_000);
    expect(rulesOf(`ee${specimen}ff`)).toContain('uuidv7');
  });

  it('reports a uuid butted against a preceding hex run', () => {
    const specimen = uuidWithMillis(DAY_BOUNDARY_MS + 60_000);
    expect(rulesOf(`deadbeef${specimen}`)).toContain('uuidv7');
  });
});

describe('detectLeakValues — host paths', () => {
  it.each([
    [hostPath('home', 'someone', 'project', 'file.txt')],
    [hostPath('Users', 'someone', 'project', 'file.txt')],
    [hostPath('tmp', 'render-scratch', 'out.png')],
    [hostPath('workspace', 'checkout', 'out.png')],
  ])('reports an absolute host path', (value) => {
    expect(rulesOf(value)).toContain('host-path');
  });

  it('reports a tilde home reference', () => {
    expect(rulesOf(`cwd ${tildeHome('someone', 'project')}`)).toContain('host-path');
  });

  it('passes a repo-relative path', () => {
    expect(rulesOf('scripts/lib/example.ts')).toEqual([]);
  });

  it('reports a path under the optional-software root', () => {
    expect(rulesOf(hostPath('opt', 'vendor', 'tool'))).toContain('host-path');
  });

  it.each([
    [hostPath('var', 'folders', 'ab', 'cd', 'T', 'scratch')],
    [hostPath('private', 'var', 'folders', 'ab', 'cd', 'T', 'scratch')],
  ])('reports the per-user temp root', (value) => {
    expect(rulesOf(value)).toContain('host-path');
  });

  it.each([
    [drivePath('C', '\\', 'Users', 'someone')],
    [drivePath('C', '\\\\', 'Users', 'someone')],
  ])('reports a drive-lettered path', (value) => {
    expect(rulesOf(value)).toContain('host-path');
  });

  it('reports a system temp path holding no digit run', () => {
    expect(rulesOf(hostPath('tmp', 'scratch', 'frame.png'))).toContain('host-path');
  });

  it('reports a rooted spelling framed directly behind a word character', () => {
    expect(rulesOf(`origin${hostPath('home', 'someone', 'file.txt')}`)).toContain('host-path');
  });

  it('reports a tilde home reference framed directly behind a word character', () => {
    expect(rulesOf(`origin${tildeHome('someone', 'project')}`)).toContain('host-path');
  });

  it('passes a shorthand prefix opening a path segment', () => {
    expect(rulesOf(`docs/${tildeHome('someone', 'project')}`)).toEqual([]);
  });
});

describe('detectLeakValues — toolchain identity', () => {
  it('reports an encoder build banner', () => {
    expect(rulesOf('x264 - core 999')).toContain('toolchain-identity');
  });

  it('names the identity class without echoing the matched literal', () => {
    const [leak] = detectLeakValues('x264 - core 999');
    expect(leak?.shape).not.toContain('x264');
  });

  it('passes text carrying no known toolchain literal', () => {
    expect(rulesOf('a caption written by a person')).toEqual([]);
  });
});

describe('detectLeakValues — redaction', () => {
  it('never echoes the matched value in a finding shape', () => {
    const time = clockOf(3, 4, 5);
    const home = hostPath('home', 'someone', 'x');
    const leaks = detectLeakValues(`created ${isoAt(3, 4, 5)} at ${home}`);
    expect(leaks).toHaveLength(2);
    for (const leak of leaks) {
      expect(leak.shape).not.toContain(time);
      expect(leak.shape).not.toContain('someone');
    }
  });
});

describe('detectLeakValues — cost', () => {
  /**
   * A region arrives capped at 64 KB, and the scan has to stay linear in that
   * size. The previous implementation rebuilt the whole string once per match,
   * which turned one dense region into minutes of gate time; at this size that
   * cost exceeds the suite's own timeout, so completing is the assertion.
   */
  it('scans a full-size region dense with matches', () => {
    const specimen = `${clockOf(7, 41, 22)} `.repeat(7000);
    const leaks = detectLeakValues(specimen);
    expect(leaks).toHaveLength(7000);
    expect(new Set(leaks.map((leak) => leak.rule))).toEqual(new Set(['clock']));
  });
});

describe('detectLeakValues — minute-resolution datetimes', () => {
  it('reports an ISO datetime carrying only hours and minutes', () => {
    expect(rulesOf(`at ${DAY}T${pad(3)}:${pad(4)}`)).toContain('iso-datetime');
  });

  it('passes an ISO datetime at midnight without a seconds field', () => {
    expect(rulesOf(`at ${DAY}T${pad(0)}:${pad(0)}`)).toEqual([]);
  });
});

describe('scanBitstreamLiterals', () => {
  it('finds a toolchain literal inside an opaque byte range', () => {
    const bytes = Buffer.concat([
      Buffer.alloc(64),
      Buffer.from('x264 - core 163', 'latin1'),
      Buffer.alloc(64),
    ]);
    const hits = scanBitstreamLiterals(bytes, 0, bytes.length);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.offset).toBe(64);
  });

  it('reports nothing for a range holding no known literal', () => {
    expect(scanBitstreamLiterals(Buffer.alloc(256), 0, 256)).toEqual([]);
  });

  it('reports a literal only once even when it repeats', () => {
    const needle = Buffer.from('Lavc58', 'latin1');
    const bytes = Buffer.concat([needle, Buffer.alloc(32), needle]);
    expect(scanBitstreamLiterals(bytes, 0, bytes.length)).toHaveLength(1);
  });

  it('confines the search to the requested range', () => {
    const bytes = Buffer.concat([Buffer.from('x264', 'latin1'), Buffer.alloc(32)]);
    expect(scanBitstreamLiterals(bytes, 4, bytes.length)).toEqual([]);
  });

  it('finds a literal that starts inside the range and runs past its end', () => {
    const needle = 'VideoToolbox';
    const bytes = Buffer.concat([Buffer.alloc(16), Buffer.from(needle, 'latin1')]);
    expect(scanBitstreamLiterals(bytes, 0, 16 + 2)).toHaveLength(1);
  });

  it('exposes a non-empty literal denylist', () => {
    expect(TOOLCHAIN_LITERALS.length).toBeGreaterThan(0);
  });

  /**
   * The cost of the sweep is the range, never the blob behind it.
   *
   * Searching from the range's start to the end of the whole buffer and
   * discarding out-of-range hits afterwards reads the same to every behavioural
   * test — the findings are identical — while costing blob length once per range
   * per literal. The range count comes out of the blob's own structure table, so
   * that multiplier is chosen by the file. Only the clock can see it, which is
   * why this is a cost assertion rather than a value one.
   */
  it('costs the range rather than the blob behind it', () => {
    const bytes = Buffer.alloc(2_000_000);
    const ranges = 2000;

    const started = process.hrtime.bigint();
    for (let index = 0; index < ranges; index++) {
      scanBitstreamLiterals(bytes, index * 8, index * 8 + 8);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

    expect(elapsedMs).toBeLessThan(2000);
  });
});

/**
 * Boundary fixtures for every character-class band and range bound in the rule
 * set. A gate fails open by narrowing a rule exactly as surely as by widening a
 * carve-out, and a band edge is where a narrowing shows: a fixture in the middle
 * of a band cannot tell a truncated band from an intact one.
 */
describe('detectLeakValues — band and range edges', () => {
  it('reports a clock in the last hour of the day', () => {
    expect(rulesOf(`at ${clockOf(23, 0, 1)} in the run`)).toContain('clock');
  });

  it('reports a clock in the last minute of an hour', () => {
    expect(rulesOf(`at ${clockOf(1, 59, 1)} in the run`)).toContain('clock');
  });

  it('reports a clock in the last second of a minute', () => {
    expect(rulesOf(`at ${clockOf(1, 1, 59)} in the run`)).toContain('clock');
  });

  it('reports a GeneralizedTime in the last hour of the day', () => {
    expect(rulesOf(`signedAt ${compactAt(23, 0, 1)}`)).toContain('generalized-time');
  });

  it('reports an ISO datetime in the last hour of the day', () => {
    expect(rulesOf(`created ${isoAt(23, 0, 1)}`)).toContain('iso-datetime');
  });

  it('reports a second epoch near the top of the plausible era', () => {
    expect(rulesOf(`ts 2499999999 end`)).toContain('epoch-seconds');
  });

  it('reports a second epoch near the bottom of the plausible era', () => {
    expect(rulesOf(`ts 1000000001 end`)).toContain('epoch-seconds');
  });

  it('reports a millisecond epoch near the top of the plausible era', () => {
    expect(rulesOf(`ts=2499999999999`)).toContain('epoch-millis');
  });

  it('reports a millisecond epoch near the bottom of the plausible era', () => {
    expect(rulesOf(`ts=1000000000001`)).toContain('epoch-millis');
  });

  it.each([['8'], ['9'], ['a'], ['b']])(
    'reports a version-7 uuid carrying the variant nibble %s',
    (variant) => {
      const hex = (DAY_BOUNDARY_MS + 60_000).toString(16).padStart(12, '0');
      const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-${variant}def-0123456789ab`;
      expect(rulesOf(uuid)).toContain('uuidv7');
    }
  );
});

/**
 * A fixture that satisfies two predicates cannot distinguish them. Each of these
 * satisfies one day-boundary predicate and fails its sibling, so swapping a
 * millisecond carve-out for its seconds twin — or the reverse — is a hole rather
 * than a wash.
 */
describe('detectLeakValues — millisecond and second carve-outs are not interchangeable', () => {
  it('reports a millisecond epoch that only the seconds predicate would exempt', () => {
    // Divisible by 86_400, so the seconds predicate clears it; a real time of
    // day in milliseconds, so the millisecond predicate does not.
    const specimen = DAY_BOUNDARY_MS + DAY_MS / SECOND_MS;
    expect(specimen % (DAY_MS / SECOND_MS)).toBe(0);
    expect(specimen % DAY_MS).toBeGreaterThanOrEqual(SECOND_MS);
    expect(rulesOf(`ts=${String(specimen)}`)).toContain('epoch-millis');
  });

  it('reports a second epoch that only the millisecond predicate would exempt', () => {
    // Under a second past a millisecond-day boundary, but a real time of day in
    // seconds.
    const specimen = DAY_MS * 12 + 500;
    expect(specimen % DAY_MS).toBeLessThan(SECOND_MS);
    expect(specimen % (DAY_MS / SECOND_MS)).not.toBe(0);
    expect(rulesOf(`ts ${String(specimen)} end`)).toContain('epoch-seconds');
  });

  it('reports a version-7 uuid that only the seconds predicate would exempt', () => {
    const millis = DAY_BOUNDARY_MS + DAY_MS / SECOND_MS;
    const hex = millis.toString(16).padStart(12, '0');
    const uuid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-0123456789ab`;
    expect(millis % (DAY_MS / SECOND_MS)).toBe(0);
    expect(rulesOf(uuid)).toContain('uuidv7');
  });
});

/**
 * Deleting any one literal used to leave the suite green while removing a real
 * disclosure from this tree — the muxer strings in the capture files and the
 * encoder banners in the container metadata are all on this list.
 */
describe('the toolchain denylist', () => {
  it.each([
    ['x264'],
    ['x265'],
    ['libvpx'],
    ['libaom'],
    ['SVT-AV1'],
    ['Lavc'],
    ['Lavf'],
    ['Lavu'],
    ['ffmpeg'],
    ['FFmpeg'],
    ['LAME'],
    ['VideoToolbox'],
    ['HandBrake'],
    ['Remotion'],
    ['ImageMagick'],
    ['Photoshop'],
    ['Matplotlib'],
  ])('reports %s as a toolchain identity', (literal) => {
    expect(rulesOf(`encoder ${literal} 1.0`)).toContain('toolchain-identity');
    expect(scanBitstreamLiterals(Buffer.from(`..${literal}..`, 'latin1'), 0, 64)).toHaveLength(1);
  });

  it('carries every pinned literal in the exported denylist', () => {
    expect(TOOLCHAIN_LITERALS).toHaveLength(17);
  });
});

/**
 * A day-boundary carve-out is a statement about a whole value, and this
 * pattern's time fields are fixed width with no trailing guard — so a field
 * written one digit wider matches at its first two digits and the surplus is
 * left over. Clearing that prefix would exempt a value nobody proved is a day
 * boundary. Reported values are unaffected: the match is kept either way, and
 * only the carve-out is withheld.
 */
describe('detectLeakValues — a datetime whose value continues past the match', () => {
  it('reports a midnight datetime whose seconds field is written wider', () => {
    expect(rulesOf(`${isoAt(0, 0, 0, { zone: '' })}1`)).toEqual(['iso-datetime']);
  });

  it('reports a midnight datetime whose minutes field is written wider', () => {
    expect(rulesOf(`${DAY}T${clockOf(0, 0, 0).slice(0, 5)}0`)).toEqual(['iso-datetime']);
  });

  it('reports an end-of-day datetime whose seconds field is written wider', () => {
    expect(rulesOf(`${isoAt(23, 59, 59, { zone: '' })}9`)).toEqual(['iso-datetime']);
  });

  it('exempts the same midnight datetime where the value ends at the match', () => {
    expect(rulesOf(isoAt(0, 0, 0, { zone: '' }))).toEqual([]);
  });

  it('exempts a midnight datetime whose subsecond field ends the value', () => {
    expect(rulesOf(isoAt(0, 0, 0, { fraction: '.000', zone: '' }))).toEqual([]);
  });
});

/**
 * The claim map records which bytes a narrower rule already accounted for, so
 * two rules cannot report the same span twice. It is read over the match's own
 * bytes and no further: reading one byte past would let a value that merely
 * *abuts* an earlier claim be swallowed by it, which loses a real detection
 * whenever two disclosures are written with nothing between them.
 */
describe('detectLeakValues — the claim map covers the match and not its neighbour', () => {
  it('reports a literal whose last byte abuts an earlier rule claim', () => {
    const rules = detectLeakValues(`x264${hostPath('home', 'someone', 'render')}`).map(
      (leak) => leak.rule
    );
    expect(rules).toContain('toolchain-identity');
    expect(rules).toContain('host-path');
  });
});
