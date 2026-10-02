import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import {
  ADMISSION_CLAUSES,
  EVIDENCED_CLAUSES,
  PRIVACY_ALLOWLIST_PATH,
  admitsValuelessFinding,
  evidenceFailure,
  parsePrivacyAllowlist,
} from './allowlist.js';
import { HOST_PATH_ENVELOPE_GUARD_SOURCE } from './host-paths.js';
import {
  ENCODING_RULE,
  LIVE_RULE_NAMES,
  ROOTED_HOST_PATH_SOURCE,
  decodeBlob,
  scanTextBlobs,
} from './rules.js';
import type { MisreadEvidence, PrivacyAllowlistEntry } from './allowlist.js';
import type { AllowlistEntry, PrivacyFinding, TextBlobEntry } from './rules.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** An instant with a time of day: what the datetime rule in the set is looking for. */
const DISCLOSING_INSTANT = new Date(TEST_DAY_START + 14 * HOUR_MS).toISOString();

async function shippedAllowlist(): Promise<ReturnType<typeof parsePrivacyAllowlist>> {
  return parsePrivacyAllowlist(
    await readFile(path.join(REPO_ROOT, PRIVACY_ALLOWLIST_PATH), 'utf8'),
    LIVE_RULE_NAMES
  );
}

/** A second value of the same class, so a fixture can pin one value per entry on one path. */
const OTHER_DISCLOSING_INSTANT = new Date(TEST_DAY_START + 9 * HOUR_MS).toISOString();

/** The blob of every entry that pins literals; an entry without them exempts its whole file. */
async function blobsOfLiteralPinningEntries(
  entries: readonly AllowlistEntry[]
): Promise<TextBlobEntry[]> {
  return Promise.all(
    entries
      .filter((entry) => entry.literals !== undefined)
      .map(async (entry) => ({
        path: entry.path,
        bytes: await readFile(path.join(REPO_ROOT, entry.path)),
      }))
  );
}

/**
 * The pinned literals that suppress nothing, reported as `path#index` — the position of
 * a literal in its entry, never the literal, which this file may not write down.
 *
 * A literal is removed from the allowlist as a whole and the file its entry names is
 * rescanned; a literal doing work makes a finding appear. Every other entry stays
 * standing, a second entry naming the same file included: scanning that file against the
 * lone entry would leave its sibling's values unsuppressed, and a scan reporting
 * something whatever the literal under test does answers a different question.
 *
 * A path no blob covers reads every literal on it dead, rather than skipping the entry:
 * a caller handing over the wrong blobs gets a failure instead of a silent pass.
 */
function deadPinnedLiterals(
  entries: readonly PrivacyAllowlistEntry[],
  blobs: readonly TextBlobEntry[]
): string[] {
  const blobOf = new Map(blobs.map((blob) => [blob.path, blob]));
  const dead: string[] = [];
  for (const [entryIndex, entry] of entries.entries()) {
    const literals = entry.literals;
    if (literals === undefined) continue;
    const blob = blobOf.get(entry.path) ?? { path: entry.path, bytes: new Uint8Array() };
    const baseline = scanTextBlobs([blob], entries).length;
    for (const literalIndex of literals.keys()) {
      const without = entries.with(entryIndex, {
        ...entry,
        literals: literals.filter((_, index) => index !== literalIndex),
      });
      if (scanTextBlobs([blob], without).length <= baseline) {
        dead.push(`${entry.path}#${String(literalIndex)}`);
      }
    }
  }
  return dead;
}

describe('parsePrivacyAllowlist', () => {
  it('parses an entry pinning literals to a path', () => {
    const source = JSON.stringify({
      entries: [
        {
          clause: 'provenance',
          description: 'upstream data',
          path: 'a/b.json',
          literals: ['value'],
        },
      ],
    });

    expect(parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toEqual([
      { clause: 'provenance', description: 'upstream data', path: 'a/b.json', literals: ['value'] },
    ]);
  });

  it('rejects an entry with no description', () => {
    const source = JSON.stringify({ entries: [{ clause: 'provenance', path: 'a/b.json' }] });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/description/);
  });

  it('rejects an entry whose literals array is empty', () => {
    const source = JSON.stringify({
      entries: [{ clause: 'provenance', description: 'why', path: 'a/b.json', literals: [] }],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/literals/);
  });

  it('rejects an empty description, which justifies nothing while looking like an entry', () => {
    const source = JSON.stringify({
      entries: [{ clause: 'provenance', description: '', path: 'a/b.json', literals: ['value'] }],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/description/);
  });

  it('rejects an empty pinned literal, which would match no value at all', () => {
    const source = JSON.stringify({
      entries: [{ clause: 'provenance', description: 'why', path: 'a/b.json', literals: [''] }],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/literals/);
  });

  it('rejects an entry with no path', () => {
    const source = JSON.stringify({
      entries: [{ clause: 'provenance', description: 'why', literals: ['value'] }],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/path/);
  });

  it('rejects an entry whose path is empty, which would match nothing and read as a wildcard', () => {
    const source = JSON.stringify({
      entries: [{ clause: 'provenance', description: 'why', path: '', literals: ['value'] }],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/path/);
  });

  it('rejects an unknown key beside the entry list', () => {
    const source = JSON.stringify({ entries: [], exemptions: [{ path: 'a/b.json' }] });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/exemptions/);
  });

  it('rejects an unknown key rather than silently widening the entry', () => {
    const source = JSON.stringify({
      entries: [{ clause: 'provenance', description: 'why', path: 'a/b.json', literal: ['value'] }],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/literal/);
  });

  it('rejects an entry that declares no clause, which is the argument left unstated', () => {
    const source = JSON.stringify({
      entries: [{ description: 'why', path: 'a/b.json', literals: ['value'] }],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/clause/);
  });

  it('rejects a clause name that is not one of the admission clauses', () => {
    const source = JSON.stringify({
      entries: [{ clause: 'because', description: 'why', path: 'a/b.json', literals: ['value'] }],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/clause/);
  });

  it('rejects text that is not JSON without echoing the file back', () => {
    const source = 'not json at all, and this text must not be quoted';

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/position/);
    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).not.toThrow(/must not be quoted/);
  });
});

describe('the evidenced clauses', () => {
  const claiming = (
    evidence: unknown,
    literals: unknown = ['the-value'],
    clause = 'content'
  ): string =>
    JSON.stringify({
      entries: [{ clause, description: 'why', path: 'a/b.md', literals, evidence }],
    });

  it('parses an entry that names what the value is and cites the text showing it', () => {
    const source = claiming({ is: 'a content hash', shownBy: 'markup hash' });

    expect(parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toEqual([
      {
        clause: 'content',
        description: 'why',
        path: 'a/b.md',
        literals: ['the-value'],
        evidence: { is: 'a content hash', shownBy: 'markup hash' },
      },
    ]);
  });

  it('refuses a content-clause entry that carries no evidence', () => {
    const source = JSON.stringify({
      entries: [
        {
          clause: 'content',
          description: 'the argument, written here instead',
          path: 'a/b.md',
          literals: ['the-value'],
        },
      ],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/evidence/);
  });

  it('refuses a data-clause entry that carries no evidence', () => {
    const source = JSON.stringify({
      entries: [
        {
          clause: 'data',
          description: 'the argument, written here instead',
          path: 'a/b.md',
          literals: ['the-value'],
        },
      ],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/evidence/);
  });

  it('refuses evidence on a clause that never needs it, so the two claims cannot be mixed', () => {
    const source = claiming(
      { is: 'a content hash', shownBy: 'markup hash' },
      ['the-value'],
      'form'
    );

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/evidence/);
  });

  it('rejects evidence that cites nothing, which is the clause without its whole point', () => {
    const source = claiming({ is: 'a content hash' });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/shownBy/);
  });

  it('rejects evidence that does not say what the value is', () => {
    const source = claiming({ shownBy: 'markup hash' });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/evidence\.is/);
  });

  it('rejects an unknown key inside the evidence rather than silently ignoring it', () => {
    const source = claiming({ is: 'a content hash', shownBy: 'markup hash', because: 'trust me' });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(/because/);
  });

  it('rejects evidence on an entry that names no finding, which speaks for a whole file', () => {
    const source = JSON.stringify({
      entries: [
        {
          clause: 'content',
          description: 'why',
          path: 'a/b.md',
          evidence: { is: 'a content hash', shownBy: 'markup hash' },
        },
      ],
    });

    expect(() => parsePrivacyAllowlist(source, LIVE_RULE_NAMES)).toThrow(
      /evidence but names no finding/
    );
  });
});

describe('the valueless admission form', () => {
  const keyedOnRule = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      entries: [
        {
          clause: 'content',
          description: 'the byte is the record’s own demonstration',
          path: 'a/b.md',
          rule: 'undecodable-encoding',
          evidence: { is: 'a separator quoted inside prose', shownBy: 'used as a separator' },
          ...overrides,
        },
      ],
    });

  it('parses an entry keyed on a path and a rule name rather than on a pinned value', () => {
    expect(parsePrivacyAllowlist(keyedOnRule(), LIVE_RULE_NAMES)).toEqual([
      {
        clause: 'content',
        description: 'the byte is the record’s own demonstration',
        path: 'a/b.md',
        rule: 'undecodable-encoding',
        evidence: { is: 'a separator quoted inside prose', shownBy: 'used as a separator' },
      },
    ]);
  });

  it('refuses an entry that names a rule and pins values, which is two admissions in one', () => {
    expect(() =>
      parsePrivacyAllowlist(keyedOnRule({ literals: ['the-value'] }), LIVE_RULE_NAMES)
    ).toThrow(/names a rule and pins values/);
  });

  it('refuses the form under a clause that carries no evidence, so evidence stays required', () => {
    expect(() => parsePrivacyAllowlist(keyedOnRule({ clause: 'form' }), LIVE_RULE_NAMES)).toThrow(
      /needs the evidence/
    );
  });

  it('refuses the form with its evidence dropped', () => {
    expect(() =>
      parsePrivacyAllowlist(keyedOnRule({ evidence: undefined }), LIVE_RULE_NAMES)
    ).toThrow(/evidence/);
  });

  it('refuses an empty rule name, which names nothing while looking like the form', () => {
    expect(() => parsePrivacyAllowlist(keyedOnRule({ rule: '' }), LIVE_RULE_NAMES)).toThrow(/rule/);
  });

  // A key is compared against a finding's rule for equality, so a name no rule
  // carries matches nothing and the entry admits nothing — with no error anywhere.
  // The author reads it at the file, which is why the question is asked at the parse
  // and not where the comparison happens.
  it('refuses a rule key naming no live rule, which would otherwise admit nothing in silence', () => {
    expect(() =>
      parsePrivacyAllowlist(keyedOnRule({ rule: 'undecodable-encodings' }), LIVE_RULE_NAMES)
    ).toThrow(/names a rule this gate does not run/);
  });

  // A rename is what makes a live key stale, so the refusal has to follow the rules
  // rather than a name written down beside them.
  it('refuses a key that was live under a rule set the gate no longer runs', () => {
    const renamed = LIVE_RULE_NAMES.filter((name) => name !== ENCODING_RULE);

    expect(() => parsePrivacyAllowlist(keyedOnRule(), renamed)).toThrow(
      /names a rule this gate does not run/
    );
  });

  it('withholds the stale key itself, which the gate may no more echo than a value', () => {
    const stale = 'undecodable-encodings';

    expect(() => parsePrivacyAllowlist(keyedOnRule({ rule: stale }), LIVE_RULE_NAMES)).not.toThrow(
      new RegExp(stale)
    );
  });

  it('leaves an entry pinning literals alone, since only the keyed form names a rule', () => {
    const pinning = JSON.stringify({
      entries: [{ clause: 'form', description: 'why', path: 'a/b.md', literals: ['the-value'] }],
    });

    expect(parsePrivacyAllowlist(pinning, []).length).toBe(1);
  });
});

describe('admitsValuelessFinding', () => {
  const admitting = (overrides: Partial<PrivacyAllowlistEntry> = {}): PrivacyAllowlistEntry[] => [
    {
      clause: 'content',
      description: 'why',
      path: 'docs/note.md',
      rule: ENCODING_RULE,
      evidence: { is: 'a separator quoted in prose', shownBy: 'used as a separator' },
      ...overrides,
    },
  ];

  const valueless: PrivacyFinding = {
    rule: ENCODING_RULE,
    path: 'docs/note.md',
    line: 1,
    column: 1,
    shape: '',
  };

  /** A byte-order mark the payload does not bear out, ahead of prose the gate reads. */
  const uncorroboratedMarkBytes = Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(`used as a separator, ran at ${DISCLOSING_INSTANT}`, 'utf8'),
  ]);
  /** The same text in an encoding the gate does not take, so nothing in it is read. */
  const unreadBytes = Buffer.from(`used as a separator, ran at ${DISCLOSING_INSTANT}`, 'utf16le');
  const uncorroboratedMark = decodeBlob(uncorroboratedMarkBytes);
  const unread = decodeBlob(unreadBytes);

  // The rule reads its own value out of the blob, so the finding is built by the
  // scanner rather than written here: a hand-made shape could claim a mask the
  // scanner would never produce, and the mask is the whole gate on this form.
  const matched = scanTextBlobs(
    [{ path: 'docs/note.md', bytes: Buffer.from(`ran at ${DISCLOSING_INSTANT}`, 'utf8') }],
    []
  );

  it('admits a finding whose rule and path the entry names', () => {
    expect(admitsValuelessFinding(admitting(), valueless, uncorroboratedMark)).toBe(true);
  });

  // The safety of the whole widening. A rule that matched a value prints a
  // character-class mask, and a value with a mask is one a literal could have
  // pinned — so the coarse form is out of that rule's reach whatever it is named.
  it('refuses a finding from a rule that carries a matched value, path and name aside', () => {
    const carried = matched[0];

    expect(carried).toBeDefined();
    expect(carried?.shape).not.toBe('');
    expect(
      matched.filter((finding) =>
        admitsValuelessFinding(admitting({ rule: carried?.rule }), finding, uncorroboratedMark)
      )
    ).toEqual([]);
  });

  it('refuses a finding from another rule in the file the entry names', () => {
    expect(
      admitsValuelessFinding(admitting({ rule: 'some-other-rule' }), valueless, uncorroboratedMark)
    ).toBe(false);
  });

  it('refuses a finding in another file, so the entry never reaches past its path', () => {
    expect(
      admitsValuelessFinding(admitting({ path: 'docs/other.md' }), valueless, uncorroboratedMark)
    ).toBe(false);
  });

  // A sibling path is refused by any containment test as readily as by equality, so it
  // leaves the equality undefended. A directory the finding's path descends from is what
  // separates them: under containment this entry silences the whole subtree beneath it.
  it('refuses a finding whose path the entry only prefixes, so an entry names one file', () => {
    expect(admitsValuelessFinding(admitting({ path: 'docs' }), valueless, uncorroboratedMark)).toBe(
      false
    );
  });

  it('leaves a valueless finding to an entry that pins values, which claims a different form', () => {
    const pinning: PrivacyAllowlistEntry[] = [
      { clause: 'form', description: 'why', path: 'docs/note.md', literals: ['the-value'] },
    ];

    expect(admitsValuelessFinding(pinning, valueless, uncorroboratedMark)).toBe(false);
  });

  it('refuses every finding against an empty allowlist', () => {
    expect(admitsValuelessFinding([], valueless, uncorroboratedMark)).toBe(false);
  });

  // The other bound, and the one that decides how much silence the admission buys. The
  // rule fires for a second reason: bytes in an encoding the gate did not take, where
  // the decoded text is not the file and no rule has read a character of it. Admitting
  // there turns blocked-and-unread into passed-and-unread for the whole file.
  it('refuses a finding on a blob the gate could not read, whose silence covers the file', () => {
    expect(scanTextBlobs([{ path: 'docs/note.md', bytes: unreadBytes }], [])).toEqual([valueless]);
    expect(admitsValuelessFinding(admitting(), valueless, unread)).toBe(false);
  });

  // The case the form was ruled in for. The blob quotes its NUL on purpose, decodes to
  // its own contents, and every value rule reads it — checked here rather than assumed,
  // so the admission is known to be about the read blob and not the unread one. A bound
  // that widened back over it would fail here, which is the point of pinning it.
  it('admits a blob quoting a NUL on purpose, whose contents every rule read', () => {
    const quoted = Buffer.from(`used as a separator\0, ran at ${DISCLOSING_INSTANT}`, 'utf8');
    const scanned = scanTextBlobs([{ path: 'docs/note.md', bytes: quoted }], []);

    expect(scanned.filter((finding) => finding.shape !== '')).not.toEqual([]);
    expect(admitsValuelessFinding(admitting(), valueless, decodeBlob(quoted))).toBe(true);
  });

  // What separates the two causes: this blob's own contents reach every rule, so the
  // encoding finding is a report about the mark it carries rather than the gate's only
  // signal that it read nothing.
  it('leaves the contents of a blob that still decodes visible to the rest of the rules', () => {
    const scanned = scanTextBlobs([{ path: 'docs/note.md', bytes: uncorroboratedMarkBytes }], []);

    expect(scanned.filter((finding) => finding.shape !== '')).not.toEqual([]);
  });

  // Evidence is the whole of what a reader has to check this form against, and until
  // it is asked here it is asked only of the shipped file by an assertion — so an
  // entry that never passes through that assertion buys its silence with a citation
  // nobody read. The blob the gate decoded is the file the citation speaks for, so
  // the question can be asked where the admission is decided.
  it('refuses an entry whose evidence cites text the blob does not carry', () => {
    const invented = admitting({
      evidence: { is: 'a separator quoted in prose', shownBy: 'a sentence the file never had' },
    });

    expect(admitsValuelessFinding(invented, valueless, uncorroboratedMark)).toBe(false);
  });

  it('refuses an entry whose citation restates only the rule and path it already names', () => {
    const restated = `${ENCODING_RULE} docs/note.md`;
    const bytes = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from(`used as a separator, ${restated}, ran at ${DISCLOSING_INSTANT}`, 'utf8'),
    ]);
    const circular = admitting({
      evidence: { is: 'a separator quoted in prose', shownBy: restated },
    });

    // Separating the two refusals: the citation is present, so only the strike can
    // be what refuses it.
    expect(decodeBlob(bytes).text).toContain(restated);
    expect(admitsValuelessFinding(circular, valueless, decodeBlob(bytes))).toBe(false);
    expect(admitsValuelessFinding(admitting(), valueless, decodeBlob(bytes))).toBe(true);
  });

  // The parser refuses this shape, so an entry reaching here without evidence came
  // from a caller that built one rather than read one. It is the same silence either
  // way, and the predicate is what the gate consults.
  it('refuses an entry carrying no evidence, which this form may never do', () => {
    expect(
      admitsValuelessFinding(admitting({ evidence: undefined }), valueless, uncorroboratedMark)
    ).toBe(false);
  });
});

describe('evidenceFailure', () => {
  const entry = (evidence: MisreadEvidence): PrivacyAllowlistEntry => ({
    clause: 'content',
    description: 'why',
    path: 'a/b.md',
    literals: ['the-value'],
    evidence,
  });

  it('passes an entry that carries no evidence at all', () => {
    const unclaimed: PrivacyAllowlistEntry = {
      clause: 'provenance',
      description: 'why',
      path: 'a/b.md',
      literals: ['the-value'],
    };

    expect(evidenceFailure(unclaimed, 'anything')).toBeUndefined();
  });

  it('passes evidence the file carries and that says more than the value does', () => {
    const file = 'the-value sits in a markup hash column';

    expect(
      evidenceFailure(entry({ is: 'a content hash', shownBy: 'markup hash' }), file)
    ).toBeUndefined();
  });

  it('reports evidence citing text the file does not carry', () => {
    const file = 'the-value sits in a markup hash column';

    expect(evidenceFailure(entry({ is: 'a hash', shownBy: 'an epoch column' }), file)).toMatch(
      /not in the file/
    );
  });

  it('reports evidence that quotes back only the value it is meant to explain', () => {
    const file = 'a row reads the-value beside a markup hash column';

    expect(evidenceFailure(entry({ is: 'a hash', shownBy: ' the-value ' }), file)).toMatch(
      /beyond the value/
    );
  });

  it('counts the value in its surrounding syntax as saying more, not as quoting it back', () => {
    const file = 'a class written [A-the-value][0-9] in prose';

    expect(
      evidenceFailure(entry({ is: 'a character class', shownBy: '[A-the-value][0-9]' }), file)
    ).toBeUndefined();
  });

  it('reports a citation the file carries nowhere near a value the entry pins', () => {
    const file = ['# An unrelated heading', '', 'a row reads the-value in a column'].join('\n');

    expect(evidenceFailure(entry({ is: 'a hash', shownBy: 'An unrelated heading' }), file)).toMatch(
      /not bound to any value/
    );
  });

  it('passes a distant citation anchored by text from the line the value sits on', () => {
    const file = ['# What the column holds', '', 'a row reads the-value in a column'].join('\n');

    expect(
      evidenceFailure(
        entry({ is: 'a hash', shownBy: 'What the column holds', beside: 'a row reads' }),
        file
      )
    ).toBeUndefined();
  });

  it('reports an anchor the file does not carry', () => {
    const file = ['# What the column holds', '', 'a row reads the-value in a column'].join('\n');

    expect(
      evidenceFailure(
        entry({ is: 'a hash', shownBy: 'What the column holds', beside: 'invented text' }),
        file
      )
    ).toMatch(/anchor/);
  });

  it('refuses an anchor that quotes back only the value, which would bind any citation', () => {
    const file = ['# An unrelated heading', '', 'a row reads the-value in a column'].join('\n');

    expect(
      evidenceFailure(
        entry({ is: 'a hash', shownBy: 'An unrelated heading', beside: 'the-value' }),
        file
      )
    ).toMatch(/anchor cites nothing beyond/);
  });

  it('reports an anchor that carries a value but shares no file line with one', () => {
    const file = ['# What the column holds', '', 'a row reads', 'the-value in a column'].join('\n');

    expect(
      evidenceFailure(
        entry({
          is: 'a hash',
          shownBy: 'What the column holds',
          beside: 'a row reads\nthe-value',
        }),
        file
      )
    ).toMatch(/not bound to any value/);
  });

  it('reports an anchor that sits no closer to a value than the citation it rescues', () => {
    const file = ['# What the column holds', '', 'a row reads the-value in a column'].join('\n');

    expect(
      evidenceFailure(
        entry({ is: 'a hash', shownBy: 'What the column holds', beside: '# What' }),
        file
      )
    ).toMatch(/not bound to any value/);
  });

  // The rule-named form pins no value, so binding and the strike test have nothing to
  // run against — but its citation still has to be in the file it names, which is the
  // check that keeps an invented justification from passing on the entry's own word.
  const ruleNamed = (evidence: MisreadEvidence): PrivacyAllowlistEntry => ({
    clause: 'content',
    description: 'why',
    path: 'a/b.md',
    rule: 'undecodable-encoding',
    evidence,
  });

  it('passes a rule-named entry whose citation the file carries', () => {
    const file = 'the separator is written as a raw byte here';

    expect(
      evidenceFailure(
        ruleNamed({ is: 'a quoted separator', shownBy: 'written as a raw byte' }),
        file
      )
    ).toBeUndefined();
  });

  it('reports a rule-named entry citing text the file does not carry', () => {
    const file = 'the separator is written as a raw byte here';

    expect(
      evidenceFailure(ruleNamed({ is: 'a quoted separator', shownBy: 'invented' }), file)
    ).toMatch(/not in the file/);
  });

  it('reports a rule-named entry whose citation restates the rule it already names', () => {
    const file = 'undecodable-encoding fires on the separator written as a raw byte here';

    expect(
      evidenceFailure(
        ruleNamed({ is: 'a quoted separator', shownBy: 'undecodable-encoding' }),
        file
      )
    ).toMatch(/beyond what the entry already names/);
  });

  it('reports a rule-named entry whose citation restates the path it already names', () => {
    const file = 'a/b.md carries the separator written as a raw byte here';

    expect(
      evidenceFailure(ruleNamed({ is: 'a quoted separator', shownBy: 'a/b.md' }), file)
    ).toMatch(/beyond what the entry already names/);
  });

  it('leaves an entry naming neither a value nor a rule to the parser, which refuses it', () => {
    const unpinned: PrivacyAllowlistEntry = {
      clause: 'content',
      description: 'why',
      path: 'a/b.md',
      evidence: { is: 'a hash', shownBy: 'markup hash' },
    };

    expect(evidenceFailure(unpinned, 'a markup hash column')).toBeUndefined();
  });
});

// The host-path rule recognises paths rooted at a named directory or a drive letter,
// and a tilde shorthand. The rooted half is compiled from the rule's own export rather
// than restated by hand: a restatement goes stale the moment a root is named there, and
// it fails silently, since a screen that cannot see the value it looks for still passes.
// The shorthand is a separate export, so the exception this screen makes is the rule's
// own decomposition rather than a hand-written omission to keep in step. The guard the
// rule's envelope composes is imported for the same reason as the rooted half rather than
// spelled here: without it the export reads a rooted value at an inner segment, where the
// rule refuses it. The `u` flag is what the export asks for — flagless, its segment
// class degrades to identity escapes and the pattern reads a wider language than the
// rule does.
const ROOTED_HOST_PATH = new RegExp(
  `${HOST_PATH_ENVELOPE_GUARD_SOURCE}(?:${ROOTED_HOST_PATH_SOURCE})`,
  'u'
);

// The cardinals from two upward. `one` is left out deliberately: in this module it is
// the ordinary article — "one place", "one of them" — so a gate firing on it would be
// read as noise rather than as a finding, and a gate read as noise gets suppressed.
const COUNT_WORD = /\b(?:two|three|four|five|six|seven|eight|nine|ten)\b/i;

/** The comment text on a source line: a block-comment body, or whatever follows `//`. */
function commentTextOf(line: string): string {
  const slashes = line.indexOf('//');
  if (slashes !== -1) return line.slice(slashes);
  return /^\s*\/?\*/.test(line) ? line : '';
}

describe('this module’s comments', () => {
  // A count rots on the next adjacent edit while the claim it stands in for does not,
  // so the comments state the derivation rather than the enumeration. Nothing else
  // checks comment prose: the compiler ignores it and every other gate here reads code.
  it('states no count, since a count rots and the claim it stands in for does not', async () => {
    const source = await readFile(
      path.join(REPO_ROOT, 'scripts', 'lib', 'privacy', 'allowlist.ts'),
      'utf8'
    );

    const counting = source
      .split('\n')
      .flatMap((line, index) => (COUNT_WORD.test(commentTextOf(line)) ? [index + 1] : []));

    expect(counting).toEqual([]);
  });
});

// A date or a time of day written out in a source. A test that has to reference a
// disclosing value obtains it from the shared test-time module and never spells it:
// spelling it in fragments a rule cannot join keeps the source green while the value
// it carries is provably a real match, which is worse than the plain literal a gate
// would have caught. Reported as positions, never as the text that matched.
const SPELLED_INSTANT = /\d{4}-\d{2}-\d{2}|\b\d{2}:\d{2}\b/;

// The reach is these sources and no others, which is a scope decision rather than a
// shortfall left open. The pattern reads a value spelled out, and a value assembled from
// fragments at run time is in no committed byte, so nothing reading the bytes can reach one
// — detecting assembly is a different instrument from reading a source, and building it was
// weighed and declined. Everywhere else the property stands as a rule a reviewer applies and
// nothing running measures: the head of `rules.test.ts` states it where the
// assembled fixtures live.
const OWNED_TEST_SOURCES = ['allowlist.test.ts', 'report.test.ts'];

describe('these test sources', () => {
  it('spell no instant, since a value assembled to stay green is itself the finding', async () => {
    const sources = await Promise.all(
      OWNED_TEST_SOURCES.map(async (file) => ({
        file,
        text: await readFile(path.join(REPO_ROOT, 'scripts', 'lib', 'privacy', file), 'utf8'),
      }))
    );

    const spelling = sources.flatMap(({ file, text }) =>
      text
        .split('\n')
        .flatMap((line, index) =>
          SPELLED_INSTANT.test(line) ? [`${file}:${String(index + 1)}`] : []
        )
    );

    expect(spelling).toEqual([]);
  });
});

function pinnedEntry(
  description: string,
  atPath: string,
  literals: readonly string[]
): PrivacyAllowlistEntry {
  return { clause: 'provenance', description, path: atPath, literals };
}

function textBlob(atPath: string, text: string): TextBlobEntry {
  return { path: atPath, bytes: Buffer.from(text, 'utf8') };
}

describe('deadPinnedLiterals', () => {
  it('reports a literal that matches nothing in the file its entry names', () => {
    const entries = [
      pinnedEntry('upstream data', 'fixtures/a.json', [DISCLOSING_INSTANT, 'absent']),
    ];
    const blobs = [textBlob('fixtures/a.json', DISCLOSING_INSTANT)];

    expect(deadPinnedLiterals(entries, blobs)).toEqual(['fixtures/a.json#1']);
  });

  it('reports nothing where every pinned literal matches', () => {
    const entries = [pinnedEntry('upstream data', 'fixtures/a.json', [DISCLOSING_INSTANT])];
    const blobs = [textBlob('fixtures/a.json', DISCLOSING_INSTANT)];

    expect(deadPinnedLiterals(entries, blobs)).toEqual([]);
  });

  // The sibling entry is what a per-entry rescan would drop, and dropping it leaves its
  // own values reported: the file then never scans clean, so no literal of either entry
  // can be told apart from one doing work.
  it('reports a dead literal in a file a second entry also names', () => {
    const entries = [
      pinnedEntry('upstream data', 'fixtures/a.json', [DISCLOSING_INSTANT, 'absent']),
      pinnedEntry('a sibling entry on the same file', 'fixtures/a.json', [
        OTHER_DISCLOSING_INSTANT,
      ]),
    ];
    const blobs = [
      textBlob('fixtures/a.json', `${DISCLOSING_INSTANT} ${OTHER_DISCLOSING_INSTANT}`),
    ];

    expect(deadPinnedLiterals(entries, blobs)).toEqual(['fixtures/a.json#1']);
  });

  it('reports nothing where a file two entries name has every literal of both live', () => {
    const entries = [
      pinnedEntry('upstream data', 'fixtures/a.json', [DISCLOSING_INSTANT]),
      pinnedEntry('a sibling entry on the same file', 'fixtures/a.json', [
        OTHER_DISCLOSING_INSTANT,
      ]),
    ];
    const blobs = [
      textBlob('fixtures/a.json', `${DISCLOSING_INSTANT} ${OTHER_DISCLOSING_INSTANT}`),
    ];

    expect(deadPinnedLiterals(entries, blobs)).toEqual([]);
  });

  it('reports every literal on a path no blob covers', () => {
    const entries = [pinnedEntry('upstream data', 'fixtures/a.json', [DISCLOSING_INSTANT])];

    expect(deadPinnedLiterals(entries, [])).toEqual(['fixtures/a.json#0']);
  });
});

describe('the shipped allowlist', () => {
  it('gives every entry a description and a path', async () => {
    const entries = await shippedAllowlist();

    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry.description.length).toBeGreaterThan(0);
      expect(entry.path.length).toBeGreaterThan(0);
    }
  });

  it('pins literals wherever a literal can be written down', async () => {
    const entries = await shippedAllowlist();

    for (const entry of entries) {
      expect(entry.literals === undefined || entry.literals.length > 0).toBe(true);
    }
  });

  // `carries no pinned literal that suppresses nothing in the file its entry names` and
  // `leaves nothing unsuppressed in a file an entry names beyond the literals it pins`
  // collect across every entry before asserting: asserting inside the loop would name one
  // failing entry and hide its siblings, turning a shortfall the run can see whole into a
  // queue of single fixes.
  //
  // The per-literal question subsumes the file-granular one — an entry whose file yields
  // nothing has no literal in it whose removal changes anything — so a file-granular
  // sibling would only restate a case this already covers.
  it('carries no pinned literal that suppresses nothing in the file its entry names', async () => {
    const entries = await shippedAllowlist();
    const blobs = await blobsOfLiteralPinningEntries(entries);

    expect(deadPinnedLiterals(entries, blobs)).toEqual([]);
  });

  it('leaves nothing unsuppressed in a file an entry names beyond the literals it pins', async () => {
    const entries = await shippedAllowlist();
    const blobs = await blobsOfLiteralPinningEntries(entries);

    expect(scanTextBlobs(blobs, entries)).toEqual([]);
  });

  it('backs every evidenced entry with evidence the file it names bears out', async () => {
    const entries = await shippedAllowlist();

    const failures = await Promise.all(
      entries
        .filter((entry) => entry.evidence !== undefined)
        .map(async (entry) =>
          evidenceFailure(entry, await readFile(path.join(REPO_ROOT, entry.path), 'utf8'))
        )
    );

    expect(failures.filter((failure) => failure !== undefined)).toEqual([]);
  });

  it('declares an admission clause on every entry', async () => {
    const entries = await shippedAllowlist();

    const undeclared = entries
      .filter((entry) => !Object.hasOwn(ADMISSION_CLAUSES, entry.clause))
      .map((entry) => entry.path);

    expect(undeclared).toEqual([]);
  });

  // A rooted path in the allowlist is not itself the defect. Some are ours — a case's
  // input, an option a case hands a resolver — and those are admitted at an exact path
  // under a clause that demands evidence, which a reviewer re-reads and which fails
  // loudly once the text it cites leaves the file. The hole is one admitted under a
  // clause that asks for none, where nothing holds the admission but its own word.
  it('admits no rooted host path under a clause that asks for no evidence', async () => {
    const entries = await shippedAllowlist();

    const unevidenced = entries
      .filter((entry) => !EVIDENCED_CLAUSES.includes(entry.clause))
      .filter((entry) => (entry.literals ?? []).some((literal) => ROOTED_HOST_PATH.test(literal)))
      .map((entry) => entry.path);

    expect(unevidenced).toEqual([]);
  });

  it('is named at the repository root', () => {
    expect(PRIVACY_ALLOWLIST_PATH).toBe('privacy-allowlist.json');
  });
});
