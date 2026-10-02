import { describe, it, expect, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execa } from 'execa';
import { TEST_DAY_START, HOUR_MS, SECOND_MS } from '@hushbox/shared/test-time';

import { PNG_SIGNATURE } from './lib/privacy/binary/png.js';
import { isBinaryBlob } from './lib/privacy/binary/scan.js';
import { ENCODING_RULE, scanTextBlobs } from './lib/privacy/rules.js';
import { readRepositories } from './configure-git-clone.js';
import {
  parsePublishedObjectIds,
  parseTreeListing,
  listTreePairs,
  unaccountedObjects,
  reportablePath,
  needsBinaryGate,
  scanBlobs,
  formatGateReport,
  runCommitStage,
  runPushStage,
  assertScopedRevisions,
} from './privacy-gate.js';
import type { AllowlistEntry, TextBlobEntry } from './lib/privacy/rules.js';
import type { PrivacyAllowlistEntry } from './lib/privacy/allowlist.js';

const ZERO = '0'.repeat(40);
/** Assembled, never written: a literal host path in this file is a finding in the tree. */
const posixSpecimen = (...segments: readonly string[]): string =>
  segments.map((segment) => `/${segment}`).join('');
const CONFORMING_SECONDS = TEST_DAY_START / SECOND_MS;
const DISCLOSING_SECONDS = (TEST_DAY_START + 14 * HOUR_MS) / SECOND_MS;
const CONFORMING_STAMP = `@${String(CONFORMING_SECONDS)} +0000`;
/** An instant with a time of day: what every text rule in the set is looking for. */
const DISCLOSING_INSTANT = new Date(TEST_DAY_START + 14 * HOUR_MS).toISOString();

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
    chunk('IDAT', Buffer.alloc(8)),
    chunk('IEND', Buffer.alloc(0)),
  ]);

const textChunk = (value: string): Buffer =>
  chunk('tEXt', Buffer.concat([Buffer.from('Software'), Buffer.alloc(1), Buffer.from(value)]));

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

const blob = (blobPath: string, bytes: Buffer | string): TextBlobEntry => ({
  path: blobPath,
  bytes: typeof bytes === 'string' ? Buffer.from(bytes) : bytes,
});

/** Bytes no registered format claims, carrying the NUL that makes them binary. */
const unrecognizedBytes = Buffer.from([0x00, 0x7f, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);

/**
 * Two MPEG frames and no NUL byte anywhere: git's own text-versus-binary test
 * calls this text, and the format registry calls it audio. It is the shape that
 * falls between the gates unless the dispatch takes both answers.
 */
const nulFreeAudio = ((): Buffer => {
  const header = Buffer.from([0xff, 0xfb, 0x90, 0x44]);
  const frame = Buffer.concat([header, Buffer.alloc(413, 0x41)]);
  return Buffer.concat([frame, frame]);
})();

const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);
const treeRecord = (objectId: string, blobPath: string, type = 'blob'): string =>
  `100644 ${type} ${objectId}\t${blobPath}\0`;

describe('parsePublishedObjectIds', () => {
  it('takes the object id and drops the path git printed beside it', () => {
    // git prints one path per object, chosen from however many the object has,
    // and truncated at its first newline. The id is the only trustworthy half.
    expect(parsePublishedObjectIds(`${OID_A} docs/one.txt\n`)).toEqual(new Set([OID_A]));
  });

  it('takes the commit, which git lists with no path at all', () => {
    expect(parsePublishedObjectIds(`${OID_B}\n${OID_A} file.txt\n`)).toEqual(
      new Set([OID_B, OID_A])
    );
  });

  it('returns nothing for an empty listing', () => {
    expect(parsePublishedObjectIds('')).toEqual(new Set());
  });
});

describe('unaccountedObjects', () => {
  it('accounts for a blob that a scanned pair locates', () => {
    expect(
      unaccountedObjects(new Set([OID_A]), [{ objectId: OID_A, path: 'one.txt' }], [])
    ).toEqual([]);
  });

  it('accounts for the commits the walk itself visited', () => {
    expect(unaccountedObjects(new Set([OID_B]), [], [OID_B])).toEqual([]);
  });

  it('reports an object no pair locates', () => {
    // The evidence is already in the pipeline: the push carries this object and
    // the enumeration cannot say where it sits, so nothing decided its scope.
    expect(unaccountedObjects(new Set([OID_A, OID_B]), [], [OID_B])).toEqual([OID_A]);
  });
});

describe('reportablePath', () => {
  // A band is pinned at its ends, not somewhere inside it.
  it.each([
    ['the bottom of the control band', '\u0001', String.raw`a\u0001b`],
    ['a carriage return', '\r', String.raw`a\rb`],
    ['the top of the control band', '\u001F', String.raw`a\u001fb`],
    [
      'delete, which sits above the band and is not escaped by JSON',
      '\u007F',
      String.raw`a\u007fb`,
    ],
  ])('escapes %s', (_name, character, expected) => {
    expect(reportablePath(`a${character}b`)).toBe(expected);
  });

  it('leaves an ordinary path exactly as it is', () => {
    expect(reportablePath('docs/a note.md')).toBe('docs/a note.md');
  });
});

describe('assertScopedRevisions', () => {
  it('refuses a revision list with nothing in it', () => {
    expect(() => {
      assertScopedRevisions([]);
    }).toThrow(/no revisions/);
  });

  it('passes a revision list that names something', () => {
    expect(() => {
      assertScopedRevisions(['oldsha..newsha']);
    }).not.toThrow();
  });
});

describe('parseTreeListing', () => {
  it('reads an object id and its path from a NUL-framed record', () => {
    expect(parseTreeListing(treeRecord(OID_A, 'docs/note.md'))).toEqual([
      { objectId: OID_A, path: 'docs/note.md' },
    ]);
  });

  it('lists one blob once per path it sits at', () => {
    // A blob reached through two paths is two scope decisions, and judging it at
    // one path publishes it unexamined at the other.
    expect(
      parseTreeListing(treeRecord(OID_A, 'docs/one.txt') + treeRecord(OID_A, 'two.txt'))
    ).toEqual([
      { objectId: OID_A, path: 'docs/one.txt' },
      { objectId: OID_A, path: 'two.txt' },
    ]);
  });

  it('keeps a path containing a newline whole', () => {
    expect(parseTreeListing(treeRecord(OID_A, 'docs\nnotes.md'))[0]?.path).toBe('docs\nnotes.md');
  });

  it('reads a path containing spaces and a tab', () => {
    expect(parseTreeListing(treeRecord(OID_A, 'docs/a note\twith tab.md'))[0]?.path).toBe(
      'docs/a note\twith tab.md'
    );
  });

  it('skips an entry that is not a blob', () => {
    expect(parseTreeListing(treeRecord(OID_B, 'vendored', 'commit'))).toEqual([]);
  });

  it('lists the same pair once when two commits carry it', () => {
    const listing = treeRecord(OID_A, 'one.txt') + treeRecord(OID_A, 'one.txt');
    expect(parseTreeListing(listing)).toHaveLength(1);
  });

  it('returns nothing for an empty listing', () => {
    expect(parseTreeListing('')).toEqual([]);
  });
});

describe('both gates over one blob set', () => {
  it('reports a disclosing instant in a text blob', () => {
    const findings = scanBlobs([blob('notes.md', `written ${DISCLOSING_INSTANT}\n`)], []);
    expect(findings.text).toHaveLength(1);
  });

  it('reports a container the text gate alone passes', () => {
    const entry = blob('shot.png', png(textChunk(`Rendered ${DISCLOSING_INSTANT}`)));
    // The text gate defers to the binary format registry, so on its own it has
    // nothing to say about this blob — which is the seam both gates close.
    expect(scanTextBlobs([entry], [])).toEqual([]);
    const findings = scanBlobs([entry], []);
    expect(findings.text).toEqual([]);
    expect(findings.binary.map((outcome) => outcome.verdict)).toEqual(['dirty']);
  });

  it('hands a container carrying no NUL byte to the binary gate', () => {
    // Neither half of the dispatch sees this blob alone: the NUL test says text,
    // and the text gate defers every blob the registry claims.
    expect(isBinaryBlob(nulFreeAudio)).toBe(false);
    expect(scanTextBlobs([blob('take.mp3', nulFreeAudio)], [])).toEqual([]);
    expect(needsBinaryGate(nulFreeAudio)).toBe(true);
  });

  it('reports bytes no format claims rather than passing them', () => {
    const findings = scanBlobs([blob('mystery.bin', unrecognizedBytes)], []);
    expect(findings.binary[0]?.findings.map((finding) => finding.rule)).toContain(
      'unrecognized-format'
    );
  });

  it('refuses the exemption when an allowlisted path holds bytes no format claims', () => {
    const allowlist: PrivacyAllowlistEntry[] = [
      { clause: 'provenance', description: 'vendored font', path: 'vendor/font.woff2' },
    ];
    const findings = scanBlobs([blob('vendor/font.woff2', unrecognizedBytes)], allowlist);
    expect(findings.binary[0]?.verdict).toBe('dirty');
  });

  it('admits an allowlisted third-party artifact as exempt', () => {
    const allowlist: PrivacyAllowlistEntry[] = [
      { clause: 'provenance', description: 'vendored render', path: 'vendor/shot.png' },
    ];
    const findings = scanBlobs(
      [blob('vendor/shot.png', png(textChunk(`Rendered ${DISCLOSING_INSTANT}`)))],
      allowlist
    );
    expect(findings.binary[0]?.verdict).toBe('exempt');
  });

  // This entry point reaches the scan by its own call, so the admission is covered
  // here by construction and by nothing else — and construction stops covering it the
  // moment someone moves the call. Both directions, because a filter that drops
  // everything looks identical to a working one from the admitting side alone.
  it('admits a valueless finding on a blob whose contents every rule read', () => {
    const allowlist: PrivacyAllowlistEntry[] = [
      {
        clause: 'content',
        description: 'the byte is the evidence the record is making',
        path: 'docs/note.md',
        rule: ENCODING_RULE,
        evidence: { is: 'a separator quoted in prose', shownBy: 'used as a separator' },
      },
    ];
    const bytes = Buffer.from('used as a separator\0, and the prose carries on\n', 'utf8');

    expect(scanBlobs([blob('docs/note.md', bytes)], allowlist).text).toEqual([]);
  });

  it('leaves a valueless finding standing on a blob no rule read', () => {
    const allowlist: PrivacyAllowlistEntry[] = [
      {
        clause: 'content',
        description: 'the byte is the evidence the record is making',
        path: 'docs/note.md',
        rule: ENCODING_RULE,
        evidence: { is: 'a separator quoted in prose', shownBy: 'used as a separator' },
      },
    ];
    const bytes = Buffer.from('used as a separator, and the prose carries on\n', 'utf16le');

    expect(
      scanBlobs([blob('docs/note.md', bytes)], allowlist).text.map((finding) => finding.rule)
    ).toEqual([ENCODING_RULE]);
  });

  // Both gates at once, which is the only place the whole silence is visible. The
  // zero-free wide lead pushes the first zero past the binary sniff window, so that
  // gate never runs; the narrow prose clears the density floor so the wide reading
  // corroborates; the value rides at a four-byte code unit, which the taken reading
  // does not read. Without an entry the text gate reports the encoding finding alone.
  it('keeps a four-byte value reported when neither gate would otherwise see it', () => {
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('\u6F22'.repeat(4096), 'utf16le'),
      Buffer.from('a'.repeat(4200), 'utf16le'),
      wide32(DISCLOSING_INSTANT),
    ]);
    const allowlist: PrivacyAllowlistEntry[] = [
      {
        clause: 'content',
        description: 'the byte is the evidence the record is making',
        path: 'docs/note.md',
        rule: ENCODING_RULE,
        evidence: { is: 'a separator quoted in prose', shownBy: 'used as a separator' },
      },
    ];

    expect(needsBinaryGate(bytes)).toBe(false);

    const findings = scanBlobs([blob('docs/note.md', bytes)], allowlist);

    expect(findings.text.map((finding) => finding.rule)).toEqual([ENCODING_RULE]);
  });

  it('judges one blob at every path it was reached through', () => {
    const bytes = png(textChunk(`Rendered ${DISCLOSING_INSTANT}`));
    const allowlist: PrivacyAllowlistEntry[] = [
      { clause: 'provenance', description: 'vendored render', path: 'vendor/shot.png' },
    ];
    const findings = scanBlobs(
      [blob('vendor/shot.png', bytes), blob('docs/shot.png', bytes)],
      allowlist
    );
    // A path-scoped exemption is scoped to its path: the copy elsewhere is not
    // the artifact anyone approved.
    expect(findings.binary.map((outcome) => [outcome.file, outcome.verdict])).toEqual([
      ['vendor/shot.png', 'exempt'],
      ['docs/shot.png', 'dirty'],
    ]);
  });

  it('says nothing about a blob that discloses nothing', () => {
    const findings = scanBlobs(
      [blob('notes.md', 'a day, no clock\n'), blob('shot.png', png())],
      []
    );
    expect(findings).toEqual({ text: [], binary: [] });
  });
});

describe('the gate report', () => {
  it('withholds the matched value', () => {
    const report = formatGateReport(
      scanBlobs([blob('notes.md', `written ${DISCLOSING_INSTANT}\n`)], [])
    );
    expect(report).not.toContain(DISCLOSING_INSTANT);
    expect(report).toContain('notes.md');
  });

  it('names the binary remedy for a blob the binary gate reported', () => {
    const report = formatGateReport(
      scanBlobs([blob('shot.png', png(textChunk(`Rendered ${DISCLOSING_INSTANT}`)))], [])
    );
    expect(report).toContain('fix:binary-privacy');
    expect(report).toContain('shot.png');
  });

  it('reports a whole-blob finding, which sits at no location inside a container', () => {
    const report = formatGateReport(scanBlobs([blob('mystery.bin', unrecognizedBytes)], []));
    expect(report).toContain('unrecognized-format');
    expect(report).toContain('mystery.bin');
  });

  it('counts an admitted artifact without offering a remedy for it', () => {
    const allowlist: PrivacyAllowlistEntry[] = [
      { clause: 'provenance', description: 'vendored render', path: 'vendor/shot.png' },
    ];
    const report = formatGateReport(
      scanBlobs(
        [blob('vendor/shot.png', png(textChunk(`Rendered ${DISCLOSING_INSTANT}`)))],
        allowlist
      )
    );
    expect(report).toContain('1 admitted as third-party');
    expect(report).not.toContain('fix:binary-privacy');
  });

  it('keeps a binary finding on one line whatever it is handed', () => {
    const report = formatGateReport({
      text: [],
      binary: [
        {
          file: 'shot.png',
          verdict: 'dirty',
          findings: [
            {
              file: 'shot.png',
              format: 'png',
              kind: 'png:tEXt',
              location: 'tE\nXt',
              rule: 'metadata-carrier',
              shape: 'a shape\nforging a line',
              offset: 0,
              length: 1,
            },
          ],
        },
      ],
    });
    const findingLines = report.split('\n').filter((line) => line.includes('metadata-carrier'));
    expect(findingLines).toHaveLength(1);
    expect(findingLines[0]).toContain(String.raw`\n`);
  });

  it('says both gates ran when neither found anything', () => {
    expect(formatGateReport({ text: [], binary: [] })).toContain('no findings');
  });
});

interface Harness {
  readonly directory: string;
  readonly bare: string;
  git(...args: string[]): Promise<string>;
  write(file: string, content: string | Buffer): Promise<void>;
  commit(message: string, seconds?: number, offset?: string): Promise<string>;
  /** Stamps the two sides separately, which is the shape an amend produces. */
  commitStamped(message: string, author: string, committer: string): Promise<string>;
  allow(entries: readonly PrivacyAllowlistEntry[]): Promise<void>;
  /** Adds a blob at a path git's own porcelain refuses to take, such as one carrying a newline. */
  addRawPath(blobPath: string, content: string): Promise<void>;
}

const workspaces: string[] = [];

afterAll(async () => {
  await Promise.all(workspaces.map(async (dir) => fs.rm(dir, { recursive: true, force: true })));
});

const ALLOWLIST = JSON.stringify({ entries: [] });

async function harness(): Promise<Harness> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'privacy-gate-'));
  workspaces.push(root);
  const directory = path.join(root, 'work');
  const bare = path.join(root, 'remote.git');
  await fs.mkdir(directory, { recursive: true });
  const git = async (...args: string[]): Promise<string> => {
    const result = await execa('git', args, { cwd: directory });
    return result.stdout.trim();
  };
  const write = async (file: string, content: string | Buffer): Promise<void> => {
    const absolute = path.join(directory, file);
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await fs.writeFile(absolute, content);
  };
  await execa('git', ['init', '--bare', '-q', '-b', 'main', bare]);
  await git('init', '-q', '-b', 'main');
  await git('config', 'user.email', 'agent@hushbox.ai');
  await git('config', 'user.name', 'agent');
  await git('remote', 'add', 'origin', bare);
  await write('privacy-allowlist.json', ALLOWLIST);
  await git('add', 'privacy-allowlist.json');
  const commitStamped = async (
    message: string,
    author: string,
    committer: string
  ): Promise<string> => {
    await execa('git', ['commit', '-qm', message], {
      cwd: directory,
      env: { GIT_AUTHOR_DATE: author, GIT_COMMITTER_DATE: committer },
    });
    return git('rev-parse', 'HEAD');
  };
  const commit = async (
    message: string,
    seconds: number = CONFORMING_SECONDS,
    offset = '+0000'
  ): Promise<string> => {
    const stamp = `@${String(seconds)} ${offset}`;
    return commitStamped(message, stamp, stamp);
  };
  const allow = async (entries: readonly AllowlistEntry[]): Promise<void> => {
    await write('privacy-allowlist.json', JSON.stringify({ entries }));
    await git('add', 'privacy-allowlist.json');
  };
  const addRawPath = async (blobPath: string, content: string): Promise<void> => {
    const written = await execa('git', ['hash-object', '-w', '--stdin'], {
      cwd: directory,
      input: content,
    });
    await execa('git', ['update-index', '-z', '--index-info'], {
      cwd: directory,
      input: `100644 ${written.stdout.trim()}\t${blobPath}\0`,
    });
  };
  return { directory, bare, git, write, commit, commitStamped, allow, addRawPath };
}

const escapeForRegExp = (value: string): string =>
  value.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`);

/** The ref line git feeds a pre-push hook for a branch nobody has pushed yet. */
const newBranchStdin = (sha: string): string => `refs/heads/main ${sha} refs/heads/main ${ZERO}\n`;

/**
 * What a case that drives git may spend.
 *
 * The two stages below reach git through a subprocess for every step they take
 * — a scratch repository is initialised, written to, staged and committed, and
 * a push range is walked — so what such a case waits on is process creation,
 * which is what a saturated host is slowest at. Run on its own, the costliest
 * of them takes about 50 ms; driven under coverage beside this package's own
 * suite the same case took 14.2 seconds, roughly three hundred times its own
 * cost, against a runner default of 15 seconds outside a coverage run. This is
 * three times that worst.
 *
 * It sits on the two suites that spawn anything. The suites above them decide
 * pure functions and keep the runner's default: a case with no subprocess in it
 * that runs long is a defect rather than a busy host.
 */
const GIT_CASE_BUDGET_MS = 45_000;

describe('the commit stage', { timeout: GIT_CASE_BUDGET_MS }, () => {
  it('passes a staged file that discloses nothing', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await expect(runCommitStage(repo.directory)).resolves.toMatchObject({ code: 0 });
  });

  it('blocks a staged file carrying an instant', async () => {
    const repo = await harness();
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const outcome = await runCommitStage(repo.directory);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('notes.md');
  });

  it('judges the staged blob rather than the worktree file', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    // The violation exists on disk and has not been staged: what git would
    // commit is clean, and a reader pointed at the worktree would say otherwise.
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await expect(runCommitStage(repo.directory)).resolves.toMatchObject({ code: 0 });
  });

  it('ignores a tracked file this commit does not touch', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.write('other.md', 'nothing here\n');
    await repo.git('add', 'other.md');
    await expect(runCommitStage(repo.directory)).resolves.toMatchObject({ code: 0 });
  });

  it('passes when nothing is staged', async () => {
    const repo = await harness();
    await repo.commit('first');
    await expect(runCommitStage(repo.directory)).resolves.toMatchObject({ code: 0 });
  });

  it('scans a staged file whose whole name is one character', async () => {
    const repo = await harness();
    await repo.write('x', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'x');
    const outcome = await runCommitStage(repo.directory);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('x:1');
  });

  it('passes a commit that only deletes a file', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.git('rm', '-q', 'notes.md');
    await expect(runCommitStage(repo.directory)).resolves.toMatchObject({ code: 0 });
  });

  it('scans what a commit adds while it deletes something else', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.git('rm', '-q', 'notes.md');
    await repo.write('other.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'other.md');
    const outcome = await runCommitStage(repo.directory);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('other.md');
  });

  it('admits a staged value the staged allowlist pins', async () => {
    const repo = await harness();
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    await expect(runCommitStage(repo.directory)).resolves.toMatchObject({ code: 1 });
    await repo.allow([
      {
        clause: 'provenance',
        description: 'third-party record',
        path: 'notes.md',
        literals: [DISCLOSING_INSTANT],
      },
    ]);
    await expect(runCommitStage(repo.directory)).resolves.toMatchObject({ code: 0 });
  });

  it('tells the developer the hook is skippable and CI is not', async () => {
    const repo = await harness();
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const outcome = await runCommitStage(repo.directory);
    expect(outcome.report).toContain('--no-verify');
    expect(outcome.report).toContain('CI');
  });

  it('lets an allowlisted third-party artifact through the stage', async () => {
    const repo = await harness();
    await repo.allow([
      { clause: 'provenance', description: 'vendored render', path: 'vendor/shot.png' },
    ]);
    await repo.write('vendor/shot.png', png(textChunk(`Rendered ${DISCLOSING_INSTANT}`)));
    await repo.git('add', 'vendor/shot.png');
    // Admitted, not clean: the stage passes it and the report still counts it.
    const outcome = await runCommitStage(repo.directory);
    expect(outcome.code).toBe(0);
    expect(outcome.report).toContain('1 admitted as third-party');
  });

  it('fails without naming a directory it could not read', async () => {
    // git's own diagnosis quotes the directory, so the message it produces is
    // itself a disclosure channel — the gate's output is redacted or it is not.
    const missing = path.join(os.tmpdir(), 'privacy-gate-no-such-clone');
    const failure = runCommitStage(missing);
    await expect(failure).rejects.toThrow('git diff failed');
    await expect(failure).rejects.not.toThrow(new RegExp(escapeForRegExp(missing)));
  });

  it('blocks a staged container the text gate alone would pass', async () => {
    const repo = await harness();
    await repo.write('shot.png', png(textChunk(`Rendered ${DISCLOSING_INSTANT}`)));
    await repo.git('add', 'shot.png');
    const outcome = await runCommitStage(repo.directory);
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('shot.png');
  });
});

interface PushOptions {
  readonly stdin: string;
  readonly remote?: string;
  readonly remoteUrl?: string;
}

const push = async (repo: Harness, options: PushOptions): ReturnType<typeof runPushStage> =>
  runPushStage(repo.directory, {
    stdin: options.stdin,
    remote: options.remote ?? 'origin',
    remoteUrl: options.remoteUrl ?? repo.bare,
  });

describe('the push stage', { timeout: GIT_CASE_BUDGET_MS }, () => {
  it('passes a range whose commits and content disclose nothing', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    await expect(push(repo, { stdin: newBranchStdin(sha) })).resolves.toMatchObject({ code: 0 });
  });

  it('blocks a commit whose date carries a time of day', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first', DISCLOSING_SECONDS);
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('commit-date');
  });

  it('blocks a commit stamped at a day boundary in a zone that is not UTC', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first', CONFORMING_SECONDS, '+0530');
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    // The epoch is already midnight, so telling this developer to coarsen a
    // time of day sends them to a fix that changes nothing.
    expect(outcome.report).toContain('zone');
    expect(outcome.report).not.toContain('finer than a UTC day');
  });

  it('blocks a commit whose author date alone carries a time of day', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commitStamped(
      'first',
      `@${String(DISCLOSING_SECONDS)} +0000`,
      `@${String(CONFORMING_SECONDS)} +0000`
    );
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('author');
    expect(outcome.report).not.toContain('committer');
  });

  it('blocks a commit whose committer date alone carries a time of day', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commitStamped(
      'first',
      `@${String(CONFORMING_SECONDS)} +0000`,
      `@${String(DISCLOSING_SECONDS)} +0000`
    );
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('committer');
    expect(outcome.report).not.toContain('author');
  });

  it('blocks content that entered history in an earlier commit of the range', async () => {
    const repo = await harness();
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('second');
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('notes.md');
  });

  it('judges a blob at a path that is new to this push even when the blob is not', async () => {
    const repo = await harness();
    // The everyday shape: bytes already published under a path-scoped exemption
    // reappear at a path the exemption does not cover. The object is on the
    // remote, so nothing about it is new — only the path it now sits at.
    await repo.allow([
      {
        clause: 'provenance',
        description: 'third-party record',
        path: 'vendor/note.md',
        literals: [DISCLOSING_INSTANT],
      },
    ]);
    await repo.write('vendor/note.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'vendor/note.md');
    await repo.commit('exempted');
    await repo.git('push', '-q', 'origin', 'main');
    await repo.git('fetch', '-q', 'origin');
    const published = await repo.git('rev-parse', 'HEAD');
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('same bytes, a path the exemption does not cover');
    const outcome = await push(repo, {
      stdin: `refs/heads/main ${sha} refs/heads/main ${published}\n`,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('notes.md');
  });

  it('leaves a violation committed before the pushed range alone', async () => {
    const repo = await harness();
    // Diff scoping, which is the property that lets these gates be mounted
    // before the tree is scrubbed.
    await repo.write('old.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'old.md');
    await repo.commit('already published');
    await repo.git('push', '-q', 'origin', 'main');
    await repo.git('fetch', '-q', 'origin');
    const published = await repo.git('rev-parse', 'HEAD');
    await repo.write('new.md', 'a day, no clock\n');
    await repo.git('add', 'new.md');
    const sha = await repo.commit('adds nothing disclosing');
    await expect(
      push(repo, { stdin: `refs/heads/main ${sha} refs/heads/main ${published}\n` })
    ).resolves.toMatchObject({ code: 0 });
  });

  it('refuses a ref whose tip is not a commit', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    // A blob-tip ref walks no commits, so it yields no pair to decide scope with
    // — and the object it publishes is in the push all the same.
    const written = await execa('git', ['hash-object', '-w', '--stdin'], {
      cwd: repo.directory,
      input: `written ${DISCLOSING_INSTANT}\n`,
    });
    const objectId = written.stdout.trim();
    const outcome = await push(repo, {
      stdin: `refs/blobs/leak ${objectId} refs/blobs/leak ${ZERO}\n`,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('unaccounted');
    // Nothing was examined, so the report says nothing about findings.
    expect(outcome.report).not.toContain('no findings');
  });

  it('judges a blob whose path carries a newline', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    // Truncated at its newline this path reads as a directory that is not the
    // file, so a line-framed listing drops the blob entirely.
    await repo.addRawPath('docs\nleak.md', `written ${DISCLOSING_INSTANT}\n`);
    const sha = await repo.commit('first');
    // Out of the index and still in the commit: the index-side newline refusal
    // covers only a path the index currently holds, and this push carries one
    // that it does not.
    await repo.git('rm', '--cached', '--quiet', '--', 'docs\nleak.md');
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    // One finding, one line: a path is file-controlled, so an unescaped newline
    // in it would forge a line of the report.
    expect(outcome.report).toContain(String.raw`docs\nleak.md`);
  });

  it('does not let a path-scoped exemption cover the same bytes elsewhere', async () => {
    const repo = await harness();
    await repo.allow([
      {
        clause: 'provenance',
        description: 'third-party record',
        path: 'vendor/note.md',
        literals: [DISCLOSING_INSTANT],
      },
    ]);
    await repo.write('vendor/note.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'vendor/note.md', 'notes.md');
    const sha = await repo.commit('first');
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('notes.md');
    expect(outcome.report).not.toContain('vendor/note.md');
  });

  it('lists a commit tree the same way from anywhere in the clone', async () => {
    const repo = await harness();
    await repo.write('deep/nested/notes.md', 'a day, no clock\n');
    await repo.git('add', 'deep/nested/notes.md');
    const sha = await repo.commit('first');
    // `ls-tree` answers relative to the working directory unless told otherwise,
    // so a caller one directory down would see a tree with nothing in it.
    const fromRoot = await listTreePairs(repo.directory, sha);
    const fromInside = await listTreePairs(path.join(repo.directory, 'deep'), sha);
    expect(fromInside).toEqual(fromRoot);
    expect(fromRoot.map((entry) => entry.path)).toContain('deep/nested/notes.md');
  });

  it('passes a push whose commits add no content at all', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.git('push', '-q', 'origin', 'main');
    await repo.git('fetch', '-q', 'origin');
    await execa('git', ['commit', '-q', '--allow-empty', '-m', 'nothing new'], {
      cwd: repo.directory,
      env: { GIT_AUTHOR_DATE: CONFORMING_STAMP, GIT_COMMITTER_DATE: CONFORMING_STAMP },
    });
    const sha = await repo.git('rev-parse', 'HEAD');
    await expect(
      push(repo, {
        stdin: `refs/heads/main ${sha} refs/heads/main ${await repo.git('rev-parse', 'origin/main')}\n`,
      })
    ).resolves.toMatchObject({ code: 0 });
  });

  it('refuses a push carrying an annotated tag', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    await repo.git('tag', '-a', 'v1', '-m', 'release');
    const tag = await repo.git('rev-parse', 'v1');
    const outcome = await push(repo, {
      stdin: `refs/tags/v1 ${tag} refs/tags/v1 ${ZERO}\n`,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('annotated tag');
    expect(sha).not.toBe(tag);
  });

  it('redacts a ref name that arrived carrying a location', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.git('tag', '-a', 'v1', '-m', 'release');
    const tag = await repo.git('rev-parse', 'v1');
    // git's own grammar keeps an absolute path out of a ref name, but the ref
    // arrives on stdin and no output may echo an unredacted external value. A
    // relative ref name is deliberately left intact — that property has its own
    // test — so the specimen here is the shape a ref cannot legitimately have.
    const crafted = posixSpecimen('srv', 'clones', 'box');
    const outcome = await push(repo, { stdin: `${crafted} ${tag} ${crafted} ${ZERO}\n` });
    expect(outcome.code).toBe(1);
    for (const secret of ['srv', 'clones', 'box']) {
      expect(outcome.report).not.toContain(secret);
    }
  });

  it('redacts a signing format the developer set to something path-shaped', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    await repo.git('config', 'commit.gpgsign', 'true');
    // A config value is developer-set text that the refusal echoes back.
    await repo.git('config', 'gpg.format', posixSpecimen('opt', 'signer', 'box'));
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    for (const secret of ['opt', 'signer', 'box']) {
      expect(outcome.report).not.toContain(secret);
    }
  });

  it('refuses an annotated tag pushed outside the tag namespace', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.git('tag', '-a', 'v1', '-m', 'release');
    const tag = await repo.git('rev-parse', 'v1');
    // The tagger stamp is a property of the object, not of where the ref filed it.
    const outcome = await push(repo, {
      stdin: `refs/heads/release ${tag} refs/heads/release ${ZERO}\n`,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('annotated tag');
  });

  it('allows a push carrying a lightweight tag', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.git('tag', 'v1');
    const tag = await repo.git('rev-parse', 'v1');
    await expect(
      push(repo, { stdin: `refs/tags/v1 ${tag} refs/tags/v1 ${ZERO}\n` })
    ).resolves.toMatchObject({ code: 0 });
  });

  it('refuses a push from a clone that signs with a format embedding a timestamp', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    await repo.git('config', 'commit.gpgsign', 'true');
    const outcome = await push(repo, { stdin: newBranchStdin(sha) });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('gpg.format');
  });

  it('refuses a signing format that sorts after ssh but is not ssh', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    await repo.git('config', 'commit.gpgsign', 'true');
    // Only ssh carries no timestamp; a check written as an ordering rather than
    // an equality would admit every format that sorts after it.
    await repo.git('config', 'gpg.format', 'x509');
    await expect(push(repo, { stdin: newBranchStdin(sha) })).resolves.toMatchObject({ code: 1 });
  });

  it('allows a push from a clone that signs with ssh', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    await repo.git('config', 'commit.gpgsign', 'true');
    await repo.git('config', 'gpg.format', 'ssh');
    await expect(push(repo, { stdin: newBranchStdin(sha) })).resolves.toMatchObject({ code: 0 });
  });

  it('refuses a push aimed at the public repository from a staging-routed clone', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    const repositories = await readRepositories();
    await repo.git(
      'remote',
      'set-url',
      '--push',
      'origin',
      `https://github.com/${repositories.stagingRepo}.git`
    );
    const outcome = await push(repo, {
      stdin: newBranchStdin(sha),
      remoteUrl: `https://github.com/${repositories.publicRepo}.git`,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain(repositories.publicRepo);
  });

  it('still runs the guards for a push that only deletes a ref', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await repo.git('tag', '-a', 'v1', '-m', 'release');
    const tag = await repo.git('rev-parse', 'v1');
    const outcome = await push(repo, {
      stdin: `refs/tags/v1 ${tag} refs/tags/v1 ${ZERO}\nrefs/heads/gone ${ZERO} refs/heads/gone ${'c'.repeat(40)}\n`,
    });
    expect(outcome.code).toBe(1);
  });

  it('scans nothing and passes when the push only deletes a ref', async () => {
    const repo = await harness();
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    const outcome = await push(repo, {
      stdin: `refs/heads/gone ${ZERO} refs/heads/gone ${'c'.repeat(40)}\n`,
    });
    expect(outcome.code).toBe(0);
  });

  it('scans against the remote it was told about, not a remote of its own choosing', async () => {
    const repo = await harness();
    const target = path.join(repo.directory, '..', 'target.git');
    await execa('git', ['init', '--bare', '-q', '-b', 'main', target]);
    await repo.git('remote', 'add', 'target', target);
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    // The commit is already on `origin` and nowhere else, so a gate that
    // subtracted `origin` rather than the remote it was handed would enumerate
    // nothing and pass this push.
    await repo.git('push', '-q', 'origin', 'main');
    await repo.git('fetch', '-q', 'origin');
    await expect(
      push(repo, { stdin: newBranchStdin(sha), remote: 'target', remoteUrl: target })
    ).resolves.toMatchObject({ code: 1 });
  });

  it('checks commit dates against the remote it was told about', async () => {
    const repo = await harness();
    const target = path.join(repo.directory, '..', 'date-target.git');
    await execa('git', ['init', '--bare', '-q', '-b', 'main', target]);
    await repo.git('remote', 'add', 'target', target);
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first', DISCLOSING_SECONDS);
    // The commit sits on `origin` and not on the remote being pushed to, so a
    // range scoped to the wrong remote enumerates no commits and refuses nothing.
    await repo.git('push', '-q', 'origin', 'main');
    await repo.git('fetch', '-q', 'origin');
    const outcome = await push(repo, {
      stdin: newBranchStdin(sha),
      remote: 'target',
      remoteUrl: target,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('commit-date');
  });

  it('reads past a commit the forge minted, wherever the range is walked', async () => {
    const repo = await harness();
    const target = path.join(repo.directory, '..', 'forge-target.git');
    await execa('git', ['init', '--bare', '-q', '-b', 'main', target]);
    await repo.git('remote', 'add', 'target', target);
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    // A queue squash reaches a developer's push range whenever a branch that
    // carries one is pushed somewhere that has not seen it. Its stamps are the
    // platform's clock and no hook of ours ever saw them, so the same
    // disposition the continuous-integration backstop applies has to hold here.
    await repo.git('config', 'user.name', 'GitHub');
    await repo.git('config', 'user.email', 'noreply@github.com');
    const sha = await repo.commit('squashed contribution', DISCLOSING_SECONDS);

    const outcome = await push(repo, {
      stdin: newBranchStdin(sha),
      remote: 'target',
      remoteUrl: target,
    });

    expect(outcome).toMatchObject({ code: 0 });
  });

  it('judges each ref against the allowlist its own tip carries', async () => {
    const repo = await harness();
    await repo.allow([
      {
        clause: 'provenance',
        description: 'third-party record',
        path: 'notes.md',
        literals: [DISCLOSING_INSTANT],
      },
    ]);
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const exempted = await repo.commit('with the entry');
    await expect(push(repo, { stdin: newBranchStdin(exempted) })).resolves.toMatchObject({
      code: 0,
    });
    // A branch off the commit before the entry existed carries the same content
    // and no exemption, and it is judged by what its own tip holds.
    await repo.write('privacy-allowlist.json', JSON.stringify({ entries: [] }));
    await repo.git('add', 'privacy-allowlist.json');
    const unexempted = await repo.commit('without the entry');
    await expect(push(repo, { stdin: newBranchStdin(unexempted) })).resolves.toMatchObject({
      code: 1,
    });
  });

  it('scans a new ref against what the destination holds, not against what this clone fetched', async () => {
    const repo = await harness();
    // The installer's own clone shape: fetch from one repository, push to
    // another. Everything the fetch remote holds looks published to a clone that
    // asks itself; the destination has never seen any of it.
    const destination = path.join(repo.directory, '..', 'destination.git');
    await execa('git', ['init', '--bare', '-q', '-b', 'main', destination]);
    await repo.write('leak.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'leak.md');
    const sha = await repo.commit('content the fetch remote already has');
    await repo.git('push', '-q', 'origin', 'main');
    await repo.git('fetch', '-q', 'origin');
    // `origin` is a real remote here and it holds the content, which is what
    // makes a locally-derived boundary wrong: the push is going somewhere else.
    const outcome = await push(repo, {
      stdin: `refs/heads/feature ${sha} refs/heads/feature ${ZERO}\n`,
      remote: 'origin',
      remoteUrl: destination,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('leak.md');
  });

  it('leaves alone what the destination already advertises', async () => {
    const repo = await harness();
    await repo.write('leak.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'leak.md');
    const published = await repo.commit('already at the destination');
    await repo.git('push', '-q', 'origin', 'main');
    await repo.git('fetch', '-q', 'origin');
    // A second branch off the published commit: the destination holds every
    // object it reaches, so this push publishes nothing to scan.
    await repo.git('checkout', '-q', '-b', 'feature');
    const outcome = await push(repo, {
      stdin: `refs/heads/feature ${published} refs/heads/feature ${ZERO}\n`,
    });
    expect(outcome.code).toBe(0);
  });

  it('cannot exclude what the destination holds and this clone has never seen', async () => {
    const repo = await harness();
    const destination = path.join(repo.directory, '..', 'stranger.git');
    await execa('git', ['init', '--bare', '-q', '-b', 'main', destination]);
    // The destination holds history from somewhere else entirely; naming an
    // object this clone lacks would fail the walk, so it cannot be an exclusion.
    const stranger = path.join(repo.directory, '..', 'stranger-work');
    await fs.mkdir(stranger, { recursive: true });
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: stranger });
    await execa('git', ['config', 'user.email', 'agent@hushbox.ai'], { cwd: stranger });
    await execa('git', ['config', 'user.name', 'agent'], { cwd: stranger });
    await fs.writeFile(path.join(stranger, 'other.md'), 'unrelated\n');
    await execa('git', ['add', '-A'], { cwd: stranger });
    await execa('git', ['commit', '-qm', 'unrelated'], {
      cwd: stranger,
      env: { GIT_AUTHOR_DATE: CONFORMING_STAMP, GIT_COMMITTER_DATE: CONFORMING_STAMP },
    });
    await execa('git', ['push', '-q', destination, 'main'], { cwd: stranger });

    await repo.write('leak.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'leak.md');
    const sha = await repo.commit('first');
    const outcome = await push(repo, {
      stdin: newBranchStdin(sha),
      remote: 'stranger',
      remoteUrl: destination,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('leak.md');
  });

  it('refuses a new ref when the destination cannot be asked what it holds', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    const missing = path.join(repo.directory, '..', 'no-such-destination.git');
    const outcome = await push(repo, {
      stdin: newBranchStdin(sha),
      remote: 'gone',
      remoteUrl: missing,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('destination');
    // The reason travels; the path to it does not.
    expect(outcome.report).not.toContain(missing);
  });

  it('redacts the destination on the refusal line, whichever field carries it', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    // `git push <location> <ref>` passes the location as the remote name, so the
    // field that looks like a name is a path on an ordinary invocation. The
    // previous pin varied the URL field only and was blind to this one.
    const location = `agent@build-01:${posixSpecimen('srv', 'clones', 'box')}`;
    const outcome = await push(repo, {
      stdin: newBranchStdin(sha),
      remote: location,
      remoteUrl: path.join(repo.directory, '..', 'no-such-destination.git'),
    });
    expect(outcome.code).toBe(1);
    for (const secret of ['srv', 'clones', 'box']) {
      expect(outcome.report).not.toContain(secret);
    }
  });

  it('says why the destination could not be asked when none was given', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    const outcome = await push(repo, {
      stdin: newBranchStdin(sha),
      remote: 'nowhere',
      remoteUrl: '',
    });
    expect(outcome.code).toBe(1);
    // Both designs refuse here; only one of them says anything about why.
    expect(outcome.report).toContain('no destination was given');
  });

  it('needs no advertisement to judge a ref the destination already named', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const published = await repo.commit('first');
    await repo.git('push', '-q', 'origin', 'main');
    await repo.write('leak.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'leak.md');
    const sha = await repo.commit('second');
    // git's own protocol line already carries what the destination holds for
    // this ref, so an unreachable URL changes nothing about an update.
    const outcome = await push(repo, {
      stdin: `refs/heads/main ${sha} refs/heads/main ${published}\n`,
      remoteUrl: path.join(repo.directory, '..', 'unreachable.git'),
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('leak.md');
    expect(outcome.report).not.toContain('destination advertisement');
  });

  it('judges each ref of one push against its own tip, not against a single winner', async () => {
    const repo = await harness();
    // One push, two refs, same content: the exempting entry lives on one tip
    // only, so choosing a winner among the tips exempts content nobody exempted.
    await repo.allow([
      {
        clause: 'provenance',
        description: 'third-party record',
        path: 'notes.md',
        literals: [DISCLOSING_INSTANT],
      },
    ]);
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const exempted = await repo.commit('tip carrying the entry');
    await repo.git('checkout', '-q', '-b', 'other');
    await repo.write('privacy-allowlist.json', JSON.stringify({ entries: [] }));
    await repo.git('add', 'privacy-allowlist.json');
    const unexempted = await repo.commit('tip carrying no entry');
    const outcome = await push(repo, {
      stdin:
        `refs/heads/main ${exempted} refs/heads/main ${ZERO}\n` +
        `refs/heads/other ${unexempted} refs/heads/other ${ZERO}\n`,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('notes.md');
  });

  it('scans every ref in the push, not the first one', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const clean = await repo.commit('clean branch');
    await repo.git('checkout', '-q', '-b', 'other');
    await repo.write('leak.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'leak.md');
    const dirty = await repo.commit('the second ref');
    const outcome = await push(repo, {
      stdin:
        `refs/heads/main ${clean} refs/heads/main ${ZERO}\n` +
        `refs/heads/other ${dirty} refs/heads/other ${ZERO}\n`,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.report).toContain('leak.md');
  });

  it('judges a tip that carries no allowlist at all', async () => {
    const repo = await harness();
    await repo.git('rm', '--cached', '--quiet', 'privacy-allowlist.json');
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('no allowlist in this tip');
    // Nothing exempts anything, which is the fail-closed reading.
    await expect(push(repo, { stdin: newBranchStdin(sha) })).resolves.toMatchObject({ code: 1 });
  });

  it('does not honour an allowlist entry that was staged but never committed', async () => {
    const repo = await harness();
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('the commit that publishes it');
    // Staged after the commit: the push carries the content and not the
    // suppression, so the suppression is not what judges the push.
    await repo.allow([
      {
        clause: 'provenance',
        description: 'third-party record',
        path: 'notes.md',
        literals: [DISCLOSING_INSTANT],
      },
    ]);
    await expect(push(repo, { stdin: newBranchStdin(sha) })).resolves.toMatchObject({ code: 1 });
  });

  it('fails without naming the machine it is running on', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    // git reports a failure by quoting the invocation, and the invocation
    // carries this clone's absolute path.
    const missing = 'f'.repeat(40);
    const failure = push(repo, {
      stdin: `refs/heads/main ${sha} refs/heads/main ${missing}\n`,
    });
    await expect(failure).rejects.toThrow(/git/);
    await expect(failure).rejects.not.toThrow(new RegExp(escapeForRegExp(repo.directory)));
  });

  it('refuses to run at all without the remote git is pushing to', async () => {
    const repo = await harness();
    await repo.write('notes.md', 'a day, no clock\n');
    await repo.git('add', 'notes.md');
    const sha = await repo.commit('first');
    await expect(push(repo, { stdin: newBranchStdin(sha), remote: '' })).rejects.toThrow(
      'needs the remote'
    );
  });

  it('falls back to the last commit when it is run without ref lines', async () => {
    const repo = await harness();
    await repo.write('notes.md', `written ${DISCLOSING_INSTANT}\n`);
    await repo.git('add', 'notes.md');
    await repo.commit('first');
    await expect(push(repo, { stdin: '' })).resolves.toMatchObject({ code: 1 });
  });
});
