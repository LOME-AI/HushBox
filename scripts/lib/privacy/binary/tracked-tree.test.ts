import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { BINARY_FORMATS, detectBinaryFormat } from './format-registry.js';
import { TOOLCHAIN_LITERALS } from './leak-values.js';
import { LIVE_RULE_NAMES } from '../rules.js';
import { PRIVACY_ALLOWLIST_PATH, parsePrivacyAllowlist } from '../allowlist.js';
import { classifyBinaryBlob, isBinaryBlob, isBinaryExemption } from './scan.js';
import type { BinaryFormat, BinaryFormatId } from './format-registry.js';
import type { BinaryVerdict } from './scan.js';

/**
 * The tracked binaries permitted to report a finding without an allowlist entry.
 * The tree assertion that reads this constant admits it together with the
 * allowlist's binary exemptions and nothing else, so any other file that reports
 * anything fails — including one the backfill cleaned that goes dirty again.
 *
 * An entry is a deferral rather than an acceptance: a file is listed only until
 * it is re-treated, and treating it takes the entry away again.
 */
const RECORDED_DIRTY: readonly string[] = [];

/** One tracked file per registered format, so every parser is exercised on real bytes. */
const FORMAT_WITNESSES: readonly (readonly [BinaryFormatId, string])[] = [
  ['png', 'apps/web/public/assets/images/Book.png'],
  ['isobmff', 'ads/2026-07-hq-tour/02-ai-shots/s3-monetization/s3-bakeoff-veo31.mp4'],
  ['matroska', 'ads/2026-07-hq-tour/03-screen-capture/demo-take1.webm'],
  ['flac', 'ads/2026-07-hq-tour/04-voiceover/line1-take1.flac'],
  ['mp3', 'ads/2026-07-hq-tour/06-music/bed-lyria3pro-take1.mp3'],
  ['woff2', 'packages/ui/src/components/accessibility/fonts/lexend.woff2'],
  ['zip', 'apps/web/android/gradle/wrapper/gradle-wrapper.jar'],
  ['gif', '.github/readme/banner-dark.gif'],
  ['riff', 'ads/2026-07-hq-tour/04-voiceover/line1-gemini-take1.wav'],
  ['ico', 'packages/ui/src/assets/favicon.ico'],
];

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..'
);

/**
 * The repository's one allowlist, read as the gate reads it. Which of its entries
 * are binary exemptions is the scanner's own question, imported rather than
 * restated: a copy of it here reads the same set whenever no rule-keyed entry
 * ships, so it would go stale silently and stay green.
 */
const allowlist = parsePrivacyAllowlist(
  readFileSync(path.join(REPO_ROOT, PRIVACY_ALLOWLIST_PATH), 'utf8'),
  LIVE_RULE_NAMES
);
const BINARY_EXEMPTIONS = allowlist.filter((entry) => isBinaryExemption(entry));

interface SweptFile {
  readonly file: string;
  readonly formatId: BinaryFormatId | undefined;
  readonly verdict: BinaryVerdict;
  readonly extensionMismatch: boolean;
  /** Occurrences of a denylisted toolchain literal anywhere in the blob. */
  readonly literals: number;
  /**
   * Of those, the ones sitting in bytes the format's parser neither turned into
   * a region nor declared as a scanned payload.
   */
  readonly unreached: number;
}

interface LiteralReach {
  readonly literals: number;
  readonly unreached: number;
}

/**
 * Where a literal occurrence sits relative to what the parser can see, asked of
 * the tree rather than of a fixture.
 *
 * The reporting rule is one finding per literal per range, so counting findings
 * cannot answer this: a banner repeated across a thousand frames is one finding
 * and a banner in a box nobody walks into is also none. Only the spans say
 * whether the gate looked. Three tracked files failed this before the sample
 * description and the coded audio payloads were reachable, and each of them
 * classified dirty on other findings the whole time — which is why the file
 * list could not see it.
 */
function literalReach(bytes: Uint8Array, format: BinaryFormat | undefined): LiteralReach {
  const view = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const occurrences: number[] = [];
  for (const { literal } of TOOLCHAIN_LITERALS) {
    for (let at = view.indexOf(literal, 0, 'latin1'); at !== -1; ) {
      occurrences.push(at);
      at = view.indexOf(literal, at + 1, 'latin1');
    }
  }
  const literals = occurrences.length;
  if (literals === 0 || format === undefined) return { literals, unreached: literals };
  const spans: (readonly [number, number])[] = [
    ...format.parse(bytes).map((region) => [region.offset, region.offset + region.length] as const),
    ...(format.scanRanges?.(bytes) ?? []).map((range) => [range.start, range.end] as const),
  ];
  const unreached = occurrences.filter(
    (at) => !spans.some(([low, high]) => at >= low && at < high)
  ).length;
  return { literals, unreached };
}

const read = (file: string): Buffer => readFileSync(path.join(REPO_ROOT, file));

/**
 * Swept once and kept as small per-file verdicts: the tracked binaries run to
 * hundreds of megabytes, so neither the bytes nor a second pass over them
 * belongs in a test process.
 */
let swept: readonly SweptFile[] | undefined;

function sweep(): readonly SweptFile[] {
  if (swept !== undefined) return swept;
  // eslint-disable-next-line sonarjs/no-os-command-from-path -- git is a standard tool wherever this repo is checked out
  const listed = execFileSync('git', ['ls-files', '-z'], {
    cwd: REPO_ROOT,
    maxBuffer: 1 << 28,
  })
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  const results: SweptFile[] = [];
  for (const file of listed) {
    const absolute = path.join(REPO_ROOT, file);
    let stat;
    try {
      stat = statSync(absolute);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size === 0) continue;
    const bytes = readFileSync(absolute);
    if (!isBinaryBlob(bytes)) continue;
    const { verdict, findings } = classifyBinaryBlob(file, bytes, allowlist);
    const format = detectBinaryFormat(bytes);
    results.push({
      file,
      formatId: format?.id,
      verdict,
      extensionMismatch: findings.some((finding) => finding.rule === 'extension-mismatch'),
      ...literalReach(bytes, format),
    });
  }
  swept = results;
  return results;
}

const verdictOf = (file: string): BinaryVerdict | undefined =>
  sweep().find((entry) => entry.file === file)?.verdict;

describe('the tracked binary tree', () => {
  it('dispatches every tracked binary to a registered format', () => {
    const unrecognized = sweep()
      .filter((entry) => entry.formatId === undefined)
      .map((entry) => entry.file);
    expect(unrecognized).toEqual([]);
  });

  it('finds nothing outside the recorded baseline and the exempt class', () => {
    const admitted = new Set([...RECORDED_DIRTY, ...BINARY_EXEMPTIONS.map((entry) => entry.path)]);
    const unexpected = sweep()
      .filter((entry) => entry.verdict !== 'clean' && !admitted.has(entry.file))
      .map((entry) => entry.file);
    expect(unexpected).toEqual([]);
  });

  it('reports every third-party artifact as exempt rather than clean', () => {
    const misreported = BINARY_EXEMPTIONS.filter((entry) => verdictOf(entry.path) !== 'exempt').map(
      (entry) => entry.path
    );
    expect(misreported).toEqual([]);
    expect(BINARY_EXEMPTIONS.length).toBeGreaterThan(0);
  });

  it('leaves no toolchain literal in bytes no parser reaches', () => {
    const unreached = sweep()
      .filter((entry) => entry.unreached > 0)
      .map((entry) => entry.file);
    expect(unreached).toEqual([]);
  });

  it('asks that of a tree that carries such literals in the first place', () => {
    // The assertion above is satisfied by a tree with no literal in it at all,
    // so the question it asks has to be shown non-empty. The measure is
    // occurrences rather than files, and deliberately: the remedy empties files
    // one at a time, so a file count falls away as the tree is cleaned while the
    // question stays exactly as answerable. What is left carries its literals in
    // a coded payload no remedy reaches losslessly, which is why the count below
    // survives the tree going clean. Twenty is a floor, not the count.
    const occurrences = sweep().reduce((sum, entry) => sum + entry.literals, 0);
    expect(occurrences).toBeGreaterThan(20);
  });

  it('registers a format for every format present in the tree', () => {
    const registered = new Set<string>(BINARY_FORMATS.map((format) => format.id));
    const present = new Set(sweep().map((entry) => entry.formatId ?? 'unknown'));
    expect([...present].filter((id) => !registered.has(id))).toEqual([]);
  });
});

describe('format dispatch on real tracked files', () => {
  it.each(FORMAT_WITNESSES)('resolves a tracked file to the %s parser', (id, file) => {
    expect(detectBinaryFormat(read(file))?.id).toBe(id);
  });

  it('resolves the ID3-prefixed music bed to FLAC, not MP3', () => {
    const file = 'ads/2026-07-hq-tour/06-music/bed-stableaudio3-take1.flac';
    expect(detectBinaryFormat(read(file))?.id).toBe('flac');
  });

  it('finds no tracked binary wearing an extension its magic bytes contradict', () => {
    const mismatched = sweep()
      .filter((entry) => entry.extensionMismatch)
      .map((entry) => entry.file);
    expect(mismatched).toEqual([]);
  });

  it('reads a reproducible-build archive as clean', () => {
    expect(verdictOf('apps/web/android/gradle/wrapper/gradle-wrapper.jar')).toBe('clean');
  });

  it('reads an upstream wheel as exempt', () => {
    expect(verdictOf('apps/sandbox/test-fixtures/pypi/cowsay-6.1-py3-none-any.whl')).toBe('exempt');
  });
});
