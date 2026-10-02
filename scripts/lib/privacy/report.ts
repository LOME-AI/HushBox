import { ADMISSION_CLAUSES, EVIDENCED_CLAUSES, PRIVACY_ALLOWLIST_PATH } from './allowlist.js';
import { ENCODING_RULE, type PrivacyFinding } from './rules.js';
import type { AdmissionClause } from './allowlist.js';

/**
 * The gate must never become the disclosure channel it exists to prevent: the
 * report carries the rule, the position and the match's character-class shape,
 * and never the matched value.
 */

function findingLine(finding: PrivacyFinding): string {
  const position = `${finding.path}:${String(finding.line)}:${String(finding.column)}`;
  const shape = finding.shape === '' ? '' : `  shape ${finding.shape}`;
  return `  ${finding.rule}  ${position}${shape}`;
}

// The clause set is derived, never enumerated: an author reads this text and
// copies what it shows, so a clause the module gains and this block does not
// name would be a rule nobody was told about. A count would go on reading true.
const clauseLine = (name: AdmissionClause): string => {
  const evidenced = EVIDENCED_CLAUSES.includes(name) ? ' (needs evidence)' : '';
  return `       ${name}${evidenced} — ${ADMISSION_CLAUSES[name]}`;
};

const clauseLines = (Object.keys(ADMISSION_CLAUSES) as AdmissionClause[]).map((name) =>
  clauseLine(name)
);

// The remedies are bulleted rather than numbered because which of them applies is
// decided per report: a numeral would name a position that the report above it may
// not have printed, and a reader following "the second remedy" would be following a
// reference to something that is not there.
const VALUE_REMEDIES = [
  '  - Rewrite the value to day resolution, describe it structurally, or cite',
  '    its position rather than reproducing it.',
  '  - Where the value records no event of ours, add an entry to',
  `    ${PRIVACY_ALLOWLIST_PATH} declaring the clause that admits it:`,
  '',
  ...clauseLines,
  '',
  '     {',
  '       "clause": "<the clause above that admits it>",',
  '       "description": "why this value records no event of ours",',
  '       "path": "<repo-relative path>",',
  '       "literals": ["<the exact value>"],',
  '       "evidence": {',
  '         "is": "<what the value actually is>",',
  '         "shownBy": "<text the file itself carries that shows it>",',
  '         "beside": "<text on the value\'s own line other than the value, where shownBy sits elsewhere>"',
  '       }',
  '     }',
  '',
  '     The evidence keys are required by the clauses marked above and refused by',
  '     the rest; drop them for a clause that does not need them.',
];

/**
 * The reader of this block has no rewrite available to them, so it is the one place
 * the gate must not leave an admission unstated. It states the gate's *decision* and
 * never the criterion behind it: an author needs to tell a refused entry from a stale
 * one, which the decision gives them, while a sentence about what makes the gate so
 * judge has been falsified by every change to how it judges. The clauses it names are read off
 * the evidenced set for the same reason {@link VALUE_REMEDIES} derives its own —
 * this form always carries evidence, so a clause leaving that set must leave this
 * text with it.
 */
const VALUELESS_REMEDY = [
  '  - A finding printed with no shape column carries no matched value: its rule',
  '    reported a property of the blob rather than a match, so there is nothing to',
  '    rewrite and no value to pin. Where the gate read the blob whole and the byte it',
  '    reports is one the file carries on purpose, key the entry in',
  `    ${PRIVACY_ALLOWLIST_PATH} on the path and the rule name instead,`,
  `    under ${EVIDENCED_CLAUSES.join(' or ')}, which carry the evidence:`,
  '',
  ...EVIDENCED_CLAUSES.map((name) => clauseLine(name)),
  '',
  '     {',
  '       "clause": "<one of the clauses above>",',
  '       "description": "why this file carries it on purpose",',
  '       "path": "<repo-relative path>",',
  '       "rule": "<the rule name printed above>",',
  '       "evidence": {',
  '         "is": "<what the file is actually doing>",',
  '         "shownBy": "<text the file itself carries that shows it>"',
  '       }',
  '     }',
  '',
  '     This form reaches only a finding printed with no shape column, and only a blob',
  '     the gate judges it read whole. Where it judges the blob unread, no entry admits',
  '     it: repair the encoding instead. A rule that matched a value is refused this',
  '     form, and pins that value in an entry’s literals instead. Its evidence keys are',
  '     required, never optional.',
];

const NO_PRAGMA =
  'No inline pragma exists — the central allowlist is the only exemption mechanism.';

/**
 * The repair for the cause {@link VALUELESS_REMEDY} cannot admit. Both blocks print
 * together, because the finding names no cause: the report cannot say which one this
 * blob is, only what separates them and what each one's repair is. Only this rule
 * knows that re-saving is the repair on its side of that split.
 */
const ENCODING_REMEDY = [
  `For ${ENCODING_RULE}: where the gate judges the file unread, nothing the rules saw`,
  '  is what the file says — re-save the file as UTF-8. Where instead it',
  '  judges the file read whole and the byte is one the file carries on purpose, that',
  '  byte is the evidence the file is making, and the entry above is the repair:',
  '  rewriting it would leave a record claiming something it no longer shows.',
];

export function formatPrivacyReport(findings: readonly PrivacyFinding[]): string {
  if (findings.length === 0) {
    // Says what it covers: a blob the binary gate claims is never scanned here.
    return 'Privacy gate: no text findings. Binary blobs are the binary gate’s to report.';
  }

  // Which remedy a finding gets is decided by the shape it printed, not by its rule
  // name: the shape is what says whether a value exists to rewrite or pin, so a rule
  // added to the gate is routed correctly here without this text being edited.
  const hasValueFinding = findings.some((finding) => finding.shape !== '');
  const hasValuelessFinding = findings.some((finding) => finding.shape === '');
  const hasEncodingFinding = findings.some((finding) => finding.rule === ENCODING_RULE);

  return [
    `Privacy gate: ${String(findings.length)} finding(s). Values are withheld by design — open the cited position to see them.`,
    '',
    ...findings.map((finding) => findingLine(finding)),
    '',
    'Remedies:',
    ...(hasValueFinding ? VALUE_REMEDIES : []),
    ...(hasValueFinding && hasValuelessFinding ? [''] : []),
    ...(hasValuelessFinding ? VALUELESS_REMEDY : []),
    '',
    NO_PRAGMA,
    ...(hasEncodingFinding ? ['', ...ENCODING_REMEDY] : []),
  ].join('\n');
}
