import { z } from 'zod';
import type { AllowlistEntry, DecodedBlob, PrivacyFinding } from './rules.js';

/** Repo-relative. `scanTextBlobs` never reports on this path, by construction. */
export const PRIVACY_ALLOWLIST_PATH = 'privacy-allowlist.json';

/**
 * The clauses that admit an entry, each with the claim it makes. An entry
 * declares its clause, and the declaration is what makes the claim checkable:
 * a clause whose sentence has to say *or* is no longer a clause.
 *
 * The gate matches shapes, so a value of ours that collides with a rule's shape
 * is a permanent category rather than an accident, and `content` and `data` are
 * what let the corpus ever read clean. Their justification is also what a reader
 * cannot check from the entry alone, so they carry evidence — the split is
 * {@link EVIDENCED_CLAUSES}, which is what the checker reads. `provenance` and
 * `form` are refused evidence, because a provenance or form claim that needs
 * evidence is really a `content` or `data` claim wearing the wrong name.
 */
export const ADMISSION_CLAUSES = {
  provenance: 'the value is third-party data, never a record of work here',
  form: 'the value is a format string describing a shape, not a recorded event',
  content: 'the value is ours and is provably not what the rule read it as',
  data:
    'the value is what the rule read it as, but it is our data — an input, a fixture, ' +
    'a scenario — rather than a record of where or when the author is',
} as const;

export type AdmissionClause = keyof typeof ADMISSION_CLAUSES;

/**
 * The clauses whose claim rests on something outside the entry, so evidence is
 * a condition of admission rather than a courtesy.
 */
export const EVIDENCED_CLAUSES: readonly AdmissionClause[] = ['content', 'data'];

const isEvidenced = (clause: AdmissionClause): boolean => EVIDENCED_CLAUSES.includes(clause);

/**
 * What the value actually is, and text the named file itself carries that shows
 * it. Evidence the file does not bear out is no evidence, and evidence bound to
 * the file rather than to the value it speaks for is a citation that could have
 * come from any heading in it.
 */
export interface MisreadEvidence {
  /** What the value actually is. */
  readonly is: string;
  /** Text from the entry's own file that establishes it. */
  readonly shownBy: string;
  /**
   * Text from a line one of the pinned values sits on, naming the site the
   * citation speaks for. Required only where `shownBy` does not itself sit
   * with a value — an anchor pins what a distant citation is about, which no
   * character or line distance can, because a distance sized to today's
   * furthest citation is a number the next one widens again.
   */
  readonly beside?: string | undefined;
}

export interface PrivacyAllowlistEntry extends AllowlistEntry {
  readonly clause: AdmissionClause;
  /**
   * Names the rule an entry admits, in place of pinning the value it admits.
   * Reachable only where the rule reports a property of the blob rather than a
   * match, which {@link admitsValuelessFinding} decides.
   */
  readonly rule?: string | undefined;
  readonly evidence?: MisreadEvidence | undefined;
}

// `.strict()` is the whole safety of this file: under a permissive object a
// singular-for-plural key typo validates, the unknown key is stripped, and the
// entry silently becomes a whole-file exemption.
const evidenceSchema = z
  .object({
    is: z.string().min(1),
    shownBy: z.string().min(1),
    beside: z.string().min(1).optional(),
  })
  .strict();

const clauseSchema = z.enum(
  Object.keys(ADMISSION_CLAUSES) as [AdmissionClause, ...AdmissionClause[]]
);

const entrySchema = z
  .object({
    clause: clauseSchema,
    description: z.string().min(1),
    path: z.string().min(1),
    // Absent is legal only when the description says why per-literal pinning is
    // impossible; an empty array is the accidental whole-file exemption.
    literals: z.array(z.string().min(1)).min(1).optional(),
    rule: z.string().min(1).optional(),
    evidence: evidenceSchema.optional(),
  })
  .strict()
  // An evidenced clause without evidence is the argument moved into the prose,
  // where nothing can check it — which is the state that made the requirement
  // opt-in rather than a requirement.
  .refine((entry) => !isEvidenced(entry.clause) || entry.evidence !== undefined, {
    message: 'claims a clause whose whole point is its evidence, and carries none',
  })
  .refine((entry) => isEvidenced(entry.clause) || entry.evidence === undefined, {
    message: 'claims a clause that needs no evidence, and carries some',
  })
  // The evidenced clauses speak for a named finding, so they can never ride a
  // whole-file exemption: there would be nothing for the evidence to be about.
  // Pinned values are one such naming and a rule name is the other, which is why
  // this asks for either rather than for literals.
  .refine(
    (entry) =>
      entry.evidence === undefined || entry.literals !== undefined || entry.rule !== undefined,
    { message: 'carries evidence but names no finding, so its evidence speaks for nothing' }
  )
  // Naming a rule is what an entry does when no literal can be written down, so an
  // entry doing both is claiming a value it could pin cannot be pinned. Which
  // admission it meant is then unanswerable from the entry itself.
  .refine((entry) => entry.rule === undefined || entry.literals === undefined, {
    message: 'names a rule and pins values, so which admission it claims cannot be read off it',
  })
  // The rule-named form admits a finding without naming the value it admits, so it
  // is the one form whose reader has nothing to check the claim against but the
  // evidence. Leaving its clause free would let it be declared under a clause that
  // refuses evidence, and the widening would arrive with nothing holding it.
  .refine((entry) => entry.rule === undefined || isEvidenced(entry.clause), {
    message:
      'names a rule under a clause that carries no evidence, and this form needs the evidence',
  });

const fileSchema = z.object({ entries: z.array(entrySchema) }).strict();

const PARSE_POSITION = /at position \d+|line \d+ column \d+/;

/**
 * The entries of an allowlist source, or a throw naming what is wrong with it.
 *
 * `liveRules` is the names the gate's rules actually carry, and it is required
 * rather than defaulted: a rule key is compared to a finding's rule for equality,
 * so a key naming no live rule matches nothing, admits nothing, and reports
 * nothing. A default would let a call site that did not pass the real set turn
 * every key stale at once, in the same silence. The names cannot be read from the
 * rules here — the rules module already imports this one — so they arrive from the
 * caller that holds both.
 *
 * The check belongs at the parse because that is where a human is reading. At the
 * comparison there is nobody: a stale key simply never equals anything.
 */
export function parsePrivacyAllowlist(
  source: string,
  liveRules: readonly string[]
): PrivacyAllowlistEntry[] {
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch (error: unknown) {
    // The parser quotes the offending bytes back; this file is the one place
    // matched values are written down, so its text may never reach a log.
    const where = PARSE_POSITION.exec(String(error))?.[0] ?? 'a position it did not report';
    throw new Error(
      `The privacy allowlist is not valid JSON: the parse failed at ${where}. ` +
        `The parser's own message is withheld because it quotes file content.`
    );
  }
  const parsed = fileSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(
      `The privacy allowlist is malformed: ${parsed.error.issues
        .map((issue) => `${issue.path.join('.')} ${issue.message}`)
        .join('; ')}`
    );
  }
  // The key itself is withheld for the reason the parse failure above withholds the
  // parser's message: this file is where matched values are written down, and a key
  // is a field of it like any other.
  const stale = parsed.data.entries.filter(
    (entry) => entry.rule !== undefined && !liveRules.includes(entry.rule)
  );
  if (stale.length > 0) {
    throw new Error(
      `The privacy allowlist names a rule this gate does not run, at ${stale
        .map((entry) => entry.path)
        .join(
          ', '
        )}. The rules it runs are: ${liveRules.toSorted((a, b) => a.localeCompare(b)).join(', ')}.`
    );
  }
  return parsed.data.entries;
}

/**
 * Whether the allowlist admits a finding that carries no matched value.
 *
 * A rule that reports a property of the blob rather than a match leaves nothing
 * for a literal to equal, so the pinned-value forms cannot reach it and no entry
 * of any shape could exempt it. That is a defect in the instrument rather than in
 * the file it reports on, and the file has no repair available to it: there is no
 * value to rewrite. This form closes that, keyed on the path and the rule name.
 *
 * The empty shape is what keeps the form from becoming a general silencer, and it
 * is checked against the finding rather than against a list of rule names: a rule
 * that matched something prints a character-class mask of it, and a value with a
 * mask is one a literal could have pinned, so a rule able to name its value is
 * refused this form by its own report. A list would have had to be kept in step
 * with the rules instead, and a rule added to one and not the other is exactly the
 * hole this exists to close.
 *
 * The empty shape says the rule pinned no value; it does not say how much silence
 * admitting the finding buys, which is the other thing this has to bound. That bound is
 * {@link DecodedBlob.carriesUnreadText}: a blob may be silenced only where the reading
 * the gate passed over holds nothing a rule could have matched.
 *
 * Refusing the blob that holds its text elsewhere is the point. What the rules read is
 * not its contents, and admitting it would turn the gate's only signal that it read
 * nothing into a pass over the whole file — the encoding finding is the whole of the
 * signal there, because only the reading that was taken is ever scanned.
 *
 * A blob that carries a NUL on purpose is admitted. It decodes to text equal to the
 * file's contents and every value rule runs over them, so it is the case this form was
 * ruled in for, and an entry is the only repair it has: the byte is the evidence the file
 * is making, so rewriting it would leave a record claiming something it no longer shows.
 * Neither the mark nor the presence of a NUL separates that blob from the unread one, and
 * neither does asking whether the bytes bear a wide reading out — a wide blob can fail
 * that test and still have been read by nothing. What separates them is whether the
 * reading passed over holds a pair of adjacent characters — the least a rule matches.
 *
 * The evidence is asked of the blob here rather than left to a reviewer, because this
 * form names no value and the evidence is the whole of what a reader can check it
 * against. Asked only of the shipped file by an assertion, it would be enforced against
 * entries that pass through that assertion and against no others, which is a requirement
 * that holds wherever it happens to be looked at. The text the gate decoded is the file
 * the citation speaks for, so the question is answerable exactly where the admission is
 * decided.
 */
export function admitsValuelessFinding(
  allowlist: readonly PrivacyAllowlistEntry[],
  finding: PrivacyFinding,
  decoded: DecodedBlob
): boolean {
  if (finding.shape !== '') return false;
  if (decoded.carriesUnreadText) return false;
  return allowlist.some(
    (entry) =>
      entry.rule === finding.rule &&
      entry.path === finding.path &&
      entry.evidence !== undefined &&
      evidenceFailure(entry, decoded.text) === undefined
  );
}

/** Whether the file carries the cited text on a line one of the pinned values sits on. */
function sharesAFileLineWithAValue(
  cited: string,
  literals: readonly string[],
  fileText: string
): boolean {
  return fileText
    .split('\n')
    .some((line) => line.includes(cited) && literals.some((literal) => line.includes(literal)));
}

/**
 * Whether a cited text sits with one of the values it speaks for: it names a
 * pinned value outright, or the file carries it on a line one of them sits on.
 *
 * Only the citation gets the naming branch, and only because the strike test keeps
 * that branch honest. An anchor allowed the same branch could be set to a pinned
 * value itself, which every file carrying that value satisfies — a tautology that
 * would bind a citation sitting anywhere at all, which is the hole the anchor exists
 * to close.
 */
function sitsWithAValue(cited: string, literals: readonly string[], fileText: string): boolean {
  if (literals.some((literal) => cited.includes(literal))) return true;
  return sharesAFileLineWithAValue(cited, literals, fileText);
}

/**
 * Whether a citation says anything once the values it is meant to explain are
 * struck out of it. A citation that does not has quoted the value back.
 */
function saysMoreThanTheValue(cited: string, literals: readonly string[]): boolean {
  let beyond = cited;
  for (const literal of literals) {
    beyond = beyond.replaceAll(literal, '');
  }
  return beyond.trim() !== '';
}

/** Why the evidence cites text the file does not carry, or `undefined` where it does. */
function absentTextFailure(
  entry: PrivacyAllowlistEntry,
  evidence: MisreadEvidence,
  fileText: string
): string | undefined {
  if (!fileText.includes(evidence.shownBy)) {
    return `${entry.path}: the text its evidence cites is not in the file`;
  }
  if (evidence.beside !== undefined && !fileText.includes(evidence.beside)) {
    return `${entry.path}: the text its evidence anchors to is not in the file`;
  }
  return undefined;
}

/**
 * Why a rule-named entry's citation does not stand, or `undefined` where it does.
 *
 * The strike its pinned-value sibling runs against the values, this runs against what
 * the entry already names: a citation that is only the entry's own rule or path has
 * restated the entry rather than shown anything about the file.
 */
function ruleNamedFailure(
  entry: PrivacyAllowlistEntry,
  evidence: MisreadEvidence
): string | undefined {
  const rule = entry.rule;
  if (rule !== undefined && !saysMoreThanTheValue(evidence.shownBy, [rule, entry.path])) {
    return `${entry.path}: its evidence cites nothing beyond what the entry already names`;
  }
  return undefined;
}

/**
 * Why an entry's evidence does not stand against the file it names, or
 * `undefined` where it does — including where the entry carries no evidence
 * because its clause needs none.
 *
 * Every question asked here is about whether the evidence *can* come out
 * false. Its citation must be in the file, so an invented justification fails
 * rather than passing on the entry's own word. It must be bound to a value the
 * entry pins rather than merely to the file, so a sentence copied from an
 * unrelated heading cannot stand in for one about the value — where the
 * citation itself sits away from every value, `beside` carries the binding, and
 * it carries it by sharing a file line with a value rather than by naming one.
 * And a citation must say something the value does not: one that survives
 * having the pinned values struck out of it has quoted the value back instead
 * of explaining it, while the same value inside the syntax that gives it away
 * survives the strike and is exactly the evidence wanted. The anchor faces that
 * strike too, so it cannot be the value itself.
 *
 * None of them judges how well the evidence argues; that stays a reviewer's
 * job, and it is the reason an entry under an evidenced clause is a reviewed
 * decision rather than a passing gate.
 */
export function evidenceFailure(
  entry: PrivacyAllowlistEntry,
  fileText: string
): string | undefined {
  const evidence = entry.evidence;
  if (evidence === undefined) return undefined;
  const absent = absentTextFailure(entry, evidence, fileText);
  if (absent !== undefined) return absent;
  // A rule-named entry pins no value, so the binding test has nothing to run against.
  // The strike runs instead against what the entry already names, and its reach is
  // exactly that: it refuses a citation that restates the entry's own rule or path.
  // It does not bound triviality. A citation that is one common word carried by the
  // file passes here and admits the finding — measured, not inferred. So on this
  // branch the check establishes that the citation is in the file and is not the
  // entry read back; whether it shows anything is a reviewer's judgement, which is
  // what makes an entry under an evidenced clause a reviewed decision. An entry
  // carrying evidence and naming neither a value nor a rule is refused by the parser.
  const literals = entry.literals;
  if (literals === undefined) return ruleNamedFailure(entry, evidence);
  if (evidence.beside !== undefined && !saysMoreThanTheValue(evidence.beside, literals)) {
    return `${entry.path}: its anchor cites nothing beyond the value it is meant to place`;
  }
  const bound =
    sitsWithAValue(evidence.shownBy, literals, fileText) ||
    (evidence.beside !== undefined &&
      sharesAFileLineWithAValue(evidence.beside, literals, fileText));
  if (!bound) {
    return `${entry.path}: its evidence is in the file but not bound to any value it pins`;
  }
  if (!saysMoreThanTheValue(evidence.shownBy, literals)) {
    return `${entry.path}: its evidence cites nothing beyond the value it is meant to explain`;
  }
  return undefined;
}
