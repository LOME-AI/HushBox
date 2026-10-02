import { Node, SyntaxKind } from 'ts-morph';
import { relativePath } from '../lib/paths.js';
import type { CommentRange, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * CODE-RULES §Documentation: "A wrong comment is worse than no comment."
 *
 * A docblock is read as describing the declaration under it. Stack two block
 * comments above one declaration and BOTH are attached to it: the lower one
 * documents it, and the upper one — written for the declaration that used to
 * follow, or for the one below it that now carries nothing — is read as
 * documenting it too. The upper block is stranded, and it is stranded onto a
 * subject it is false of. Comments carry no emit, so nothing else in the
 * repository sees this: it compiles, it lints, and every test stays green.
 *
 * WHAT "STACKED" MEANS. Two leading block comments with no blank line between
 * them. The blank line is the ONLY separator this rule recognises: a comment of
 * another kind standing between the two — a line comment, or a directive block
 * the pairing drops — does not un-stack the pair, which is why
 * {@link isStackedOn} reads the source text between the blocks rather than the
 * distance between their line numbers.
 *
 * WHY ADJACENCY IS THE LINE. The house convention writes a module- or
 * section-level block, a BLANK LINE, then the first declaration's own docblock.
 * The blank line is that convention's signal to a reader, not the parser's: the
 * parser hands both blocks to the declaration either way, and the checker
 * resolves the declaration's documentation to the lower block either way. So a
 * rule written to the literal "two leading block comments" property refuses the
 * convention wherever it is used, and would have to ship a list of the sites it
 * is wrong about — which is how a gate becomes decorative. Adjacency separates
 * the two without naming a single site.
 *
 * WHAT A DIRECTIVE BLOCK IS, AND WHAT THIS RULE DOES WITH ONE. A third shape
 * sits in the same trivia: a block a tool reads. Two spellings exist here — a
 * bare directive (`prettier-ignore`, `eslint-disable`/`eslint-enable`, a
 * coverage `ignore`), and a JSDoc block carrying one of the tags knip's `tags`
 * array registers, whose meaning is "no importer reaches this export and here
 * is why". Either is dropped from the pairing in EITHER position, so a pair
 * containing one is not refused. That is a decision, not a derivation, and it
 * is what keeps this a rule: it names no path and no symbol, where the only
 * other way to leave the tree green is a list of the sites the rule is wrong
 * about. Its drift runs in two directions and only one is loud. A tag added to
 * knip's list and not to {@link TOOL_TAG} makes this rule FIRE on a pair
 * carrying it, repaired by adding the spelling. A tag dropped from knip's list
 * and left in {@link TOOL_TAG} is silent instead: this rule goes on dropping a
 * block no tool reads any more, and a pair built from one goes unreported.
 *
 * SCOPE — the api worker only. Every stranding of this class on record was found
 * under {@link API_SOURCE_TREE}, and that tree was swept and cleaned before this
 * rule landed. The rest of the scanned scope has never been assessed for the
 * class and does report pairs, some of which will be acceptable, so widening the
 * tree means assessing those first; turning them into exemptions instead would
 * cost the rule the property this whole design is built to keep.
 *
 * WHAT THIS DOES NOT CATCH. Stacking is a proxy for STRANDING, and it reaches
 * less of that class than its name suggests:
 *
 * - A LONE docblock above the wrong declaration — one block, correctly
 *   attached by the parser, wrong about its subject. No parse can see it; only
 *   reading finds it.
 * - A stranding written in the SEPARATED form: a block in module-header
 *   position that is really a docblock for a declaration further down, sitting
 *   above a declaration that already carries its own. The blank line makes it
 *   indistinguishable from the convention, so adjacency passes it. That is the
 *   price of the discriminator rather than an oversight — separating the two
 *   readings is a judgement about what the prose is ABOUT, which no parse makes.
 * - A stranding one of whose blocks is a directive block, since
 *   {@link leadingBlocksLessDirectiveBlocks} drops it on a matched directive or
 *   tag line alone — the prose that block carries about the declaration is
 *   dropped with it. Narrower than it sounds — the classifier admits only the
 *   two spellings above — but it is a real hole rather than a theoretical one.
 * - A pair stacked on a node {@link isJSDocableOrStatement} rejects: that
 *   union is narrower than the set a leading block comment can attach to, so a
 *   pair sitting on a node in neither half is never inspected.
 */

/** The tree this rule governs. */
const API_SOURCE_TREE = 'apps/api/src/';

/**
 * Directives written as a bare block comment, matched against the block's first
 * content line. The spellings are the ones this repository's toolchain reads;
 * the coverage family carries all three of its interchangeable names, since a
 * vocabulary that encodes one spelling of a directive is blind to the others.
 */
const TOOL_DIRECTIVE =
  /^(?:eslint-(?:disable|enable)(?:-next-line|-line)?|prettier-ignore|(?:v8|c8|istanbul)\s+ignore)\b/;

/**
 * JSDoc tags a repository tool reads off a declaration, each saying why an
 * export has no importer — knip's `tags` array is where they are registered and
 * documented.
 */
const TOOL_TAG = /^@(?:toolContract|namespaceMember|compilerRequired|keptByRuling)\b/;

const REMEDY =
  'the lower block documents the declaration and the upper one is stranded onto it — move the upper block onto the declaration it describes, or merge the two. A blank line between them says the upper block addresses the module rather than the declaration.';

/** A block comment's lines, stripped of its delimiters and JSDoc decoration. */
function contentLines(text: string): string[] {
  return text
    .replace(/^\/\*\*?/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\*? ?/, '').trim())
    .filter((line) => line !== '');
}

/** True for a block a tool reads: a bare directive, or a registered tool tag. */
function isDirectiveBlock(range: CommentRange): boolean {
  return contentLines(range.getText()).some(
    (line, index) => TOOL_TAG.test(line) || (index === 0 && TOOL_DIRECTIVE.test(line))
  );
}

/**
 * The nodes this rule inspects: ts-morph's `JSDocable` set, which is what holds
 * a block comment as documentation, plus any bare statement — a file's leading
 * run attaches to its first import, which carries no JSDoc slot and would
 * otherwise take a stacked pair out of view entirely. That union is narrower
 * than the set a leading block comment can attach to, so a pair sitting on a
 * node in neither half is not inspected. Widening it to every node reports some
 * pairs once per ancestor holding the same trivia, so the widening needs a
 * dedupe key.
 */
function isJSDocableOrStatement(node: Node): boolean {
  return Node.isJSDocable(node) || Node.isStatement(node);
}

/**
 * The leading block comments less the ones {@link isDirectiveBlock} accepts, in
 * source order. That predicate turns on a matched directive or tag line alone,
 * so a dropped block carries prose about the declaration as readily as a kept
 * one.
 */
function leadingBlocksLessDirectiveBlocks(node: Node): CommentRange[] {
  return node
    .getLeadingCommentRanges()
    .filter((range) => range.getKind() === SyntaxKind.MultiLineCommentTrivia)
    .filter((range) => !isDirectiveBlock(range));
}

/** The declared name a violation quotes, or the declaration's kind. */
function subjectOf(node: Node): string {
  if (Node.isVariableStatement(node)) {
    return node
      .getDeclarations()
      .map((declaration) => declaration.getName())
      .join(', ');
  }
  if (Node.hasName(node)) return node.getName();
  return node.getKindName();
}

/** The line a comment range starts on. */
function startLine(sourceFile: SourceFile, range: CommentRange): number {
  return sourceFile.getLineAndColumnAtPos(range.getPos()).line;
}

/**
 * True when no blank line separates the two blocks. Read off the source text
 * between them rather than off their line numbers: a comment of another kind
 * standing between the two — a line comment, or a directive block the pairing
 * dropped — pushes the blocks apart by line count without being the separator
 * this rule recognises.
 */
function isStackedOn(sourceFile: SourceFile, upper: CommentRange, lower: CommentRange): boolean {
  return !/\n[^\S\n]*\n/.test(sourceFile.getFullText().slice(upper.getEnd(), lower.getPos()));
}

function violationsFor(sourceFile: SourceFile, filePath: string): ArchViolation[] {
  const violations: ArchViolation[] = [];
  sourceFile.forEachDescendant((node) => {
    if (!isJSDocableOrStatement(node)) return;
    let upper: CommentRange | undefined;
    for (const lower of leadingBlocksLessDirectiveBlocks(node)) {
      if (upper !== undefined && isStackedOn(sourceFile, upper, lower)) {
        violations.push({
          file: filePath,
          line: startLine(sourceFile, lower),
          message: `Stacked block comments on "${subjectOf(node)}" — ${REMEDY}`,
        });
      }
      upper = lower;
    }
  });
  return violations;
}

const rule: ArchRule = {
  name: 'no-stacked-docblocks',
  check(project) {
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = relativePath(sourceFile);
      if (!filePath.includes(API_SOURCE_TREE)) continue;
      violations.push(...violationsFor(sourceFile, filePath));
    }
    return violations;
  },
};

export default rule;
