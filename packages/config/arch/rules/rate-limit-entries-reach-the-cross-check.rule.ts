import { Node } from 'ts-morph';
import { failWith, isTestFile, relativePath, sourceFileAt } from '../lib/paths.js';
import { limitDeclarations } from './rate-limit-keys-use-the-primitive.rule.js';
import type { ObjectLiteralExpression, Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * Doctrine (`docs/CODE-RULES.md` §Security): "One counting implementation, no
 * exceptions … A hand-rolled counter is a defect." A cross-check over a
 * hand-typed list of counters is that defect one level up — it holds whatever
 * someone remembered to list, and reports green over everything else.
 *
 * The properties that must hold ACROSS counters — the namespace the sibling
 * rule recognises, the retired keys a reuse would 503 on, a window and a cap
 * the Lua script can use, a dev reset that can clear the counter, and which
 * surfaces are secret-guessing reservations — are asserted in one test, over a
 * subject written as one object literal. This rule makes that subject TOTAL, in
 * both directions: a limit declared anywhere in the api and missing from it is
 * a violation at the declaration, and a subject entry no declaration answers is
 * a violation at the subject.
 *
 * # what it does not prove
 *
 * That a NAME is in the subject, never that any case says anything about it —
 * the same ceiling `single-writer-per-table` has over `TABLE_OWNER`. A member
 * that every case happens to pass over is invisible here.
 *
 * Its reading is also syntactic: a limit-shaped object literal handed straight
 * to a posture layer, declared under no `satisfies`, is named by nothing and so
 * is seen by neither this rule nor the subject. That direction is covered at
 * runtime instead — the cross-check walks the assembled router and reports any
 * counter the pipeline spends that the subject does not hold.
 *
 * And its comparison is by NAME ALONE. Declarations reach a set of names, each
 * asked only whether the subject holds that name; the reverse direction asks
 * only whether some declaration carried it. Two limits declared under one name
 * in different files therefore both pass on the one subject entry — the second
 * bound to nothing and read by no case — and neither direction can see it. No
 * two limits this tree declares share a name, so nothing sits in that gap
 * today. Keying the comparison on file and name would close it, at the price of
 * teaching the subject where each entry is declared: an entry named by property
 * path (`IDENTITY_KEYS.*`, `MEDIA_RATE_LIMITS.*`) is written in the subject
 * without the file that declares it.
 *
 * # why unreadable input throws
 *
 * A spread, a computed key or a subject that is not a literal at all would let
 * entries through unread, and a check that passes over what it cannot see
 * reports exactly like one that saw nothing wrong. The subject's own decay —
 * a renamed module, a renamed declaration — throws for the same reason: what
 * went missing is the rule's subject, so there is no violation to report.
 */

const RULE = 'rate-limit-entries-reach-the-cross-check';

const fail: (message: string) => never = failWith(RULE);

/** The test whose cases quantify over every counter the api declares. */
export const CROSS_CHECK_MODULE =
  'apps/api/src/whole-app/app-rate-limit-counters.integration.test.ts';

/** The subject those cases quantify over, declared in that module. */
const SUBJECT_DECLARATION = 'DECLARED_LIMITS';

/** The tree whose declarations the subject must hold. */
const API_TREE = 'apps/api/src/';

function subjectLiteral(file: SourceFile): ObjectLiteralExpression {
  const declaration = file.getVariableDeclaration(SUBJECT_DECLARATION);
  if (declaration === undefined) {
    fail(
      `'${SUBJECT_DECLARATION}' is declared nowhere in ${CROSS_CHECK_MODULE}, so the ` +
        'cross-check has no subject to be complete over. Restore the declaration, or ' +
        'point this rule at whatever replaced it.'
    );
  }
  const initializer = declaration.getInitializer();
  if (initializer === undefined || !Node.isObjectLiteralExpression(initializer)) {
    fail(
      `'${SUBJECT_DECLARATION}' is not an object literal any more. The subject is read ` +
        'syntactically, so a computed one cannot be checked for completeness at all.'
    );
  }
  return initializer;
}

/**
 * Each subject entry as the text that names its declaration, with the line it
 * sits on. A shorthand property names the declaration by itself; a written one
 * names it by its INITIALIZER, so the property key stays free to be whatever
 * reads best in a failure message.
 */
function subjectEntries(file: SourceFile): Map<string, number> {
  const entries = new Map<string, number>();
  for (const property of subjectLiteral(file).getProperties()) {
    if (Node.isShorthandPropertyAssignment(property)) {
      entries.set(property.getName(), property.getStartLineNumber());
      continue;
    }
    if (Node.isPropertyAssignment(property)) {
      entries.set(property.getInitializerOrThrow().getText(), property.getStartLineNumber());
      continue;
    }
    fail(
      `'${SUBJECT_DECLARATION}' holds an entry this rule cannot read (${property.getKindName()}) ` +
        'at line ' +
        String(property.getStartLineNumber()) +
        '. Every entry is a property naming one declared limit — a spread or a computed ' +
        'key would hide however many entries it carries from both directions of this check.'
    );
  }
  return entries;
}

/** Every limit the api declares outside its test files. */
function apiDeclarations(project: Project): ReturnType<typeof limitDeclarations> {
  return limitDeclarations(project).filter(
    (declaration) => declaration.file.includes(API_TREE) && !isTestFile(declaration.file)
  );
}

const rule: ArchRule = {
  name: RULE,
  check(project: Project): ArchViolation[] {
    const subjectFile = sourceFileAt(project, CROSS_CHECK_MODULE);
    if (subjectFile === undefined) {
      fail(
        `${CROSS_CHECK_MODULE} is not in the scanned tree, so nothing holds the counter ` +
          'cross-check. It moved, was renamed, or was deleted — point this rule at where ' +
          'the cross-check lives now.'
      );
    }

    const subject = subjectEntries(subjectFile);
    const violations: ArchViolation[] = [];
    const declaredNames = new Set<string>();

    for (const declaration of apiDeclarations(project)) {
      if (declaration.name === undefined) {
        violations.push({
          file: declaration.file,
          line: declaration.line,
          message:
            'a rate-limit entry declared where no name reaches it — neither a variable nor ' +
            `a property of one — so ${SUBJECT_DECLARATION} cannot hold it and the properties ` +
            'that must hold across counters hold for it nowhere.',
        });
        continue;
      }
      declaredNames.add(declaration.name);
      if (subject.has(declaration.name)) continue;
      violations.push({
        file: declaration.file,
        line: declaration.line,
        message: `the rate-limit entry ${declaration.name} is in no cross-check — add it to ${SUBJECT_DECLARATION} in ${CROSS_CHECK_MODULE}, which is what holds the properties every counter must have.`,
      });
    }

    for (const [name, line] of subject) {
      if (declaredNames.has(name)) continue;
      violations.push({
        file: relativePath(subjectFile),
        line,
        message: `${SUBJECT_DECLARATION} names ${name}, which no rate-limit entry in the api declares — the entry was renamed, moved or retired, and the subject is checking something that is not there.`,
      });
    }

    return violations;
  },
};

export default rule;
