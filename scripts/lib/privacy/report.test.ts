import { describe, it, expect } from 'vitest';
import { HOUR_MS, TEST_DAY_START } from '@hushbox/shared/test-time';
import { ADMISSION_CLAUSES, EVIDENCED_CLAUSES } from './allowlist.js';
import { formatPrivacyReport } from './report.js';
import { ENCODING_RULE, scanTextBlobs } from './rules.js';

/** An instant with a time of day: what the datetime rule in the set is looking for. */
const DISCLOSING_INSTANT = new Date(TEST_DAY_START + 14 * HOUR_MS).toISOString();

describe('formatPrivacyReport', () => {
  const findings = scanTextBlobs(
    [{ path: 'docs/note.md', bytes: Buffer.from(`ran at ${DISCLOSING_INSTANT}`, 'utf8') }],
    []
  );

  it('names the rule and the position of every finding', () => {
    const report = formatPrivacyReport(findings);

    expect(report).toContain('iso-datetime');
    expect(report).toContain('docs/note.md:1:8');
  });

  it('never echoes the matched value', () => {
    const report = formatPrivacyReport(findings);

    expect(report).not.toContain(DISCLOSING_INSTANT);
    expect(report).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('offers both remedies and the allowlist entry skeleton', () => {
    const report = formatPrivacyReport(findings);

    expect(report).toContain('day resolution');
    expect(report).toContain('privacy-allowlist.json');
    expect(report).toContain('"literals"');
  });

  // Derived, not enumerated: a clause added to the module and left out of the
  // remedy fails here, where a count of clauses would have gone on reading true.
  it('names every admission clause the module defines, so a new one cannot be left out', () => {
    const report = formatPrivacyReport(findings);

    const unnamed = Object.entries(ADMISSION_CLAUSES).filter(
      ([name, claim]) => !report.includes(name) || !report.includes(claim)
    );

    expect(unnamed).toEqual([]);
  });

  it('states the clause set by derivation, never by a count a fifth clause would falsify', () => {
    const report = formatPrivacyReport(findings);

    expect(report).not.toMatch(/\b(two|three|four|Two|Three|Four)\b/);
  });

  it('puts the evidence key in the entry template, which is what every author copies', () => {
    const report = formatPrivacyReport(findings);

    expect(report).toContain('"clause"');
    expect(report).toContain('"evidence"');
    expect(report).toContain('"shownBy"');
  });

  // The checker refuses an anchor that is only the value, so a placeholder inviting
  // text the value itself satisfies would teach the shape the gate rejects.
  it('asks the anchor for text other than the value it places', () => {
    const report = formatPrivacyReport(findings);

    const anchorLine = report.split('\n').find((line) => line.includes('"beside"')) ?? '';

    expect(anchorLine).toMatch(/other than the value/);
  });

  it('states that no inline pragma exists', () => {
    expect(formatPrivacyReport(findings)).toContain('No inline pragma exists');
  });

  const encodingFinding = {
    rule: ENCODING_RULE,
    path: 'docs/note.md',
    line: 1,
    column: 1,
    shape: '',
  };

  it('offers the encoding remedy, and not the rewrite remedy, for an encoding finding', () => {
    const report = formatPrivacyReport([encodingFinding]);

    expect(report).toContain('re-save the file as UTF-8');
    expect(report).not.toContain('day resolution');
  });

  // A remedy that named no admission for this class would be telling a reader their
  // file has no repair available to it, which is the state the clause exists to end.
  it('offers the rule-name admission for a finding that carries no matched value', () => {
    const report = formatPrivacyReport([encodingFinding]);

    expect(report).toContain('privacy-allowlist.json');
    expect(report).toContain('"rule"');
    expect(report).not.toContain('"literals"');
  });

  // A template is a specification for everyone who copies it, and a copy of this one
  // that parsed without evidence would route every future admission past the check.
  it('carries the evidence keys in the rule-name template, which is what an author copies', () => {
    const report = formatPrivacyReport([encodingFinding]);

    expect(report).toContain('"evidence"');
    expect(report).toContain('"shownBy"');
  });

  // An author not told the gate's verdict writes the entry, watches nothing happen,
  // and cannot tell a refused entry from a stale one. What is printed is the decision,
  // never the criterion: the criterion has moved under this text repeatedly, and each
  // faithful restatement of it was falsified by the next change.
  it('states the decision on the rule-name form, so an entry is never written blind', () => {
    expect(formatPrivacyReport([encodingFinding])).toContain('judges the blob unread');
  });

  // The rule names its cause nowhere in the finding, so both blocks print and the
  // encoding block has to send the readable blob back to the admission rather than
  // telling its author to rewrite the byte that is the evidence.
  it('routes a blob the gate read whole to the admission, not to a re-save', () => {
    const report = formatPrivacyReport([encodingFinding]);

    const encodingBlock = report.slice(report.indexOf(`For ${ENCODING_RULE}`));

    expect(encodingBlock).toContain('judges the file read whole');
  });

  it('says the rule-name form reaches only a finding printed with no shape', () => {
    expect(formatPrivacyReport([encodingFinding])).toMatch(/only.*no shape/);
  });

  // Derived, not enumerated: the clauses this form admits are read off the module, so
  // a clause moving into or out of the evidenced set cannot leave this text behind.
  it('names only the evidenced clauses on the rule-name form, which always carries evidence', () => {
    const report = formatPrivacyReport([encodingFinding]);

    for (const name of EVIDENCED_CLAUSES) {
      expect(report).toContain(name);
    }
    expect(report).not.toContain('provenance');
  });

  it('omits the shape column on the line of a finding that has no matched value', () => {
    const report = formatPrivacyReport([encodingFinding]);

    const findingLine = report.split('\n').find((line) => line.includes('docs/note.md:1:1')) ?? '';

    expect(findingLine).not.toBe('');
    expect(findingLine).not.toContain('shape');
  });

  it('offers both remedy blocks when both kinds of finding are present', () => {
    const report = formatPrivacyReport([...findings, encodingFinding]);

    expect(report).toContain('day resolution');
    expect(report).toContain('re-save the file as UTF-8');
  });

  it('reports a clean scan without remedies, and says what clean covers', () => {
    const report = formatPrivacyReport([]);

    expect(report).toContain('no text findings');
    expect(report).toContain('binary gate');
    expect(report).not.toContain('privacy-allowlist.json');
  });

  it('does not advise re-saving as UTF-16, which is the shape that blinded the gate', () => {
    expect(formatPrivacyReport([encodingFinding])).not.toContain('UTF-16');
  });
});
