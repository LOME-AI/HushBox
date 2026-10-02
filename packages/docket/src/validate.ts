import { DAY_STAMP_PATTERN } from './types.ts';
import type { Finding, FindingIssue, FindingIssueCode, ValidationMode } from './types.ts';

const OPTION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;
const DISALLOWED_ID_CHARACTERS = /[^A-Za-z0-9._-]+/g;

/**
 * The filename stem is `id` with every character outside `[A-Za-z0-9._-]`
 * replaced by `-` and the runs collapsed, so `id` is always this form and stem
 * and id always match.
 */
export function sanitizeFindingId(id: string): string {
  return id.replaceAll(DISALLOWED_ID_CHARACTERS, '-');
}

function issue(code: FindingIssueCode, field: string | null, message: string): FindingIssue {
  return { code, field, message };
}

function rulingIssues(finding: Finding): FindingIssue[] {
  if (finding.ruling !== null && finding.state !== 'ruled') {
    return [issue('ruling-without-ruled-state', 'ruling', 'a ruling requires state "ruled"')];
  }
  if (finding.ruling === null && finding.state === 'ruled') {
    return [issue('ruled-state-without-ruling', 'state', 'state "ruled" requires a ruling')];
  }
  return [];
}

function denialIssues(finding: Finding): FindingIssue[] {
  if (finding.denial !== null && finding.state !== 'denied') {
    return [issue('denial-without-denied-state', 'denial', 'a denial requires state "denied"')];
  }
  if (finding.denial === null && finding.state === 'denied') {
    return [issue('denied-state-without-denial', 'state', 'state "denied" requires a denial')];
  }
  return [];
}

/**
 * A block is raised against a ruling and answered in the console, so it cannot
 * outlive the ruling it was raised against: every decision resets the status,
 * making work blocked on a decision nobody made unwritable rather than merely
 * unlikely. Other statuses stay free of the state machine by ruling.
 */
function progressIssues(finding: Finding): FindingIssue[] {
  if (finding.progress.status === 'blocked' && finding.state !== 'ruled') {
    return [
      issue(
        'blocked-without-ruling',
        'progress.status',
        'a blocked finding requires state "ruled"; a block is answered in the console'
      ),
    ];
  }
  return [];
}

/**
 * Every stamp the format holds is a day. The check reads the typed fields and
 * never the frontmatter text: notes quote ruling instants in their own prose,
 * and a text scan would make those findings unwritable.
 */
function timestampIssues(finding: Finding): FindingIssue[] {
  const issues: FindingIssue[] = [];

  const check = (field: string, value: string | null): void => {
    if (value === null || DAY_STAMP_PATTERN.test(value)) return;
    issues.push(issue('non-day-timestamp', field, `${field} "${value}" is not a day (YYYY-MM-DD)`));
  };

  if (finding.ruling !== null) check('ruling.at', finding.ruling.at);
  if (finding.denial !== null) check('denial.at', finding.denial.at);
  for (const [index, entry] of finding.history.entries()) {
    check(`history[${String(index)}].at`, entry.at);
    check(`history[${String(index)}].superseded_at`, entry.superseded_at);
  }
  for (const [index, question] of finding.questions.entries()) {
    check(`questions[${String(index)}].at`, question.at);
    check(`questions[${String(index)}].answered_at`, question.answered_at);
  }
  check('progress.updated', finding.progress.updated);
  for (const [index, note] of finding.progress.notes.entries()) {
    check(`progress.notes[${String(index)}].at`, note.at);
  }

  return issues;
}

function optionIssues(finding: Finding): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const seen = new Set<string>();

  for (const option of finding.options) {
    if (!OPTION_ID_PATTERN.test(option.id)) {
      issues.push(
        issue('invalid-option-id', null, `option id "${option.id}" is not [A-Za-z0-9_-]+`)
      );
    }
    if (seen.has(option.id)) {
      issues.push(issue('duplicate-option-id', null, `option id "${option.id}" appears twice`));
    }
    seen.add(option.id);
  }

  return issues;
}

function structuralIssues(finding: Finding): FindingIssue[] {
  const idIssues =
    finding.id === sanitizeFindingId(finding.id)
      ? []
      : [issue('unsanitized-id', 'id', `"${finding.id}" is not the sanitized form of itself`)];

  return [
    ...idIssues,
    ...rulingIssues(finding),
    ...denialIssues(finding),
    ...progressIssues(finding),
    ...timestampIssues(finding),
    ...optionIssues(finding),
  ];
}

/**
 * The audit refuted this finding, so it was never analysed for options.
 * Resurrecting one routes it to option minting, which is what `needs_options`
 * is for. `needs_ruling` records a judgement that was never reached here, so
 * neither option-count rule applies.
 */
function deniedAtEmissionIssues(finding: Finding): FindingIssue[] {
  const issues: FindingIssue[] = [];
  if (finding.options.length > 0) {
    issues.push(issue('emission-option-count', null, 'a denied finding ships no options'));
  }
  if (!finding.needs_options) {
    issues.push(
      issue('emission-needs-options', 'needs_options', 'a denied finding asks for options')
    );
  }
  return issues;
}

function needsRulingIssues(finding: Finding): FindingIssue[] {
  const issues: FindingIssue[] = [];
  const count = finding.options.length;

  if (count === 0 && !finding.needs_options) {
    issues.push(
      issue(
        'emission-needs-options',
        'needs_options',
        'a finding shipping no options asks for them'
      )
    );
  }
  if (finding.options.filter((option) => option.recommended).length > 1) {
    issues.push(issue('emission-recommended-count', null, 'at most one option is recommended'));
  }
  return issues;
}

function noRulingNeededIssues(finding: Finding): FindingIssue[] {
  const issues: FindingIssue[] = [];

  if (finding.options.length !== 1) {
    issues.push(
      issue('emission-option-count', null, 'a finding needing no ruling ships exactly one option')
    );
  }
  if (finding.state !== 'ruled') {
    issues.push(
      issue('emission-state', 'state', 'a finding needing no ruling ships state "ruled"')
    );
  }
  return issues;
}

function emissionIssues(finding: Finding): FindingIssue[] {
  // Read the three rules in order; the first that applies is the only one that
  // does. The denial has to actually be present: `state` alone without one is a
  // structural break, not a shape the emission rules describe.
  if (finding.state === 'denied' && finding.denial !== null) {
    return deniedAtEmissionIssues(finding);
  }
  return finding.needs_ruling ? needsRulingIssues(finding) : noRulingNeededIssues(finding);
}

/**
 * `structural` holds for the whole life of a finding. `emission` binds only the
 * audit agent writing a fresh audit: a reopened finding that shipped
 * `needs_ruling: false` carries one option forever, and that is not a defect.
 */
export function validateFinding(finding: Finding, mode: ValidationMode): readonly FindingIssue[] {
  return mode === 'structural' ? structuralIssues(finding) : emissionIssues(finding);
}
