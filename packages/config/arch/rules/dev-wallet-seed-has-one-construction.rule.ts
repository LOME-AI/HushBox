import path from 'node:path';
import { SyntaxKind } from 'ts-morph';
import { assertNamedPathsExist, isRepoPath, relativePath } from '../lib/paths.js';
import { E2E_SOURCE_TREE, REPO_ROOT } from '../lib/source-scope.js';
import type { Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The dev wallet-balance route is constructed exactly once under the E2E tree,
 * in the seed module; every other caller imports that module's exports.
 *
 * Why a rule rather than a comment: a caller that builds the request for itself
 * is a second copy that has to keep agreeing with the first about the path, the
 * body's field names and the retry, and nothing else in this repository reports
 * one. `jscpd` measures textual copies and this copy is structural; `knip` sees
 * the seed module's exports still used by the callers that did not defect;
 * typecheck and lint are indifferent to which URL a request context is handed.
 * The seed module's own docblock was the only standing guard, and a comment is
 * not a gate.
 *
 * Scope is the E2E tree alone. `apps/api`'s route tests build the same request
 * and are deliberately out: they are the route's independent contract authority
 * — the server proving what it serves — not a copy that has to agree with a
 * test helper. Reporting them would make the rule's own reason false.
 *
 * What it does NOT catch, and no syntactic rule could: a path ASSEMBLED rather
 * than written — concatenated (`'/dev/' + 'wallet-balance'`), interpolated
 * (`` `/dev/wallet-${suffix}` ``), or read from a variable or config value —
 * because the rule matches the route in the literal text of a scanned file, and
 * an assembled path leaves no literal to match.
 */

/** The one sanctioned construction site, repo-relative. */
export const SEED_MODULE = 'e2e/helpers/dev-wallet-balance.ts';

/**
 * The route path, matched WHOLE: a trailing word or hyphen character means a
 * different dev route (`/dev/wallet-balances`, `/dev/wallet-balance-history`),
 * and a rule reporting those would be matching a prefix rather than a route.
 */
const ROUTE_PATH = /\/dev\/wallet-balance(?![\w-])/;

const MESSAGE =
  'This builds the dev wallet-balance request itself. That request is constructed exactly ' +
  `once under the E2E tree, in ${SEED_MODULE} — a second construction has to keep agreeing ` +
  'with the first about the path, the body fields and the retry, and it is structural ' +
  'rather than textual, so no other gate in this repository reports it. Import ' +
  'postWalletBalanceSeed, or postWalletBalanceSeedUnchecked for a caller that must stay ' +
  'fire-and-forget.';

/** The literal kinds a request path can be written in, template parts included. */
const LITERAL_KINDS = [
  SyntaxKind.StringLiteral,
  SyntaxKind.NoSubstitutionTemplateLiteral,
  SyntaxKind.TemplateHead,
  SyntaxKind.TemplateMiddle,
  SyntaxKind.TemplateTail,
] as const;

/**
 * The E2E tree, anchored at the repository root rather than matched loosely: a
 * contains-`e2e/` reading of the same question would also take any directory
 * named `e2e` inside another scanned workspace, handing the rule a second tree
 * to stand over while looking identical to this one.
 */
const E2E_ROOT = path.join(REPO_ROOT, E2E_SOURCE_TREE);

function isInScope(sourceFile: SourceFile): boolean {
  return (
    sourceFile.getFilePath().startsWith(E2E_ROOT) &&
    !isRepoPath(relativePath(sourceFile), SEED_MODULE)
  );
}

function routeConstructions(sourceFile: SourceFile): ArchViolation[] {
  return LITERAL_KINDS.flatMap((kind) =>
    sourceFile
      .getDescendantsOfKind(kind)
      .filter((node) => ROUTE_PATH.test(node.getText()))
      .map((node) => ({
        file: sourceFile.getFilePath(),
        line: node.getStartLineNumber(),
        message: MESSAGE,
      }))
  );
}

const MISSING_SEED_MODULE_REMEDY =
  'It is the one sanctioned construction of that route under the E2E tree, so this rule ' +
  'has nothing left to exempt: every remaining caller would be reported as the defect. ' +
  'If the module moved or was renamed, point this rule at its new path in the same change.';

const STALE_ROUTE_MESSAGE =
  `dev-wallet-seed-has-one-construction: ${SEED_MODULE} no longer builds a request matching ` +
  `${String(ROUTE_PATH)}. This is a LIVENESS failure of the rule, not a duplication finding ` +
  "about a caller: the path above is this rule's own copy of the route, and the module it " +
  'guards has stopped building it, so every search below would come back empty however many ' +
  'callers had built the route that replaced it. The repair is to give this rule the path the ' +
  'seed module builds now, in the change that renamed the route. A seed module that MOVED ' +
  'instead of a route that was renamed fails one line earlier, saying it names no file.';

/**
 * The rule's subject, alive: the seed module still builds this route.
 *
 * {@link ROUTE_PATH} is this rule's own copy of a path the seed module also
 * holds, and a rename updates one of them. When it updates the module's, the
 * search below matches nothing anywhere and the rule reports success over an
 * invariant that has stopped being enforced — silence that looks exactly like
 * compliance. Liveness is asserted from the two values the rule already holds,
 * and it is asserted against a CONSTRUCTION rather than the module's text, so a
 * rename that leaves the old path behind in a comment stays loud.
 */
function assertSeedModuleBuildsRoute(project: Project): void {
  const built = project
    .getSourceFiles()
    .filter((sourceFile) => isRepoPath(relativePath(sourceFile), SEED_MODULE))
    .some((sourceFile) => routeConstructions(sourceFile).length > 0);
  if (built) return;
  throw new Error(STALE_ROUTE_MESSAGE);
}

const rule: ArchRule = {
  name: 'dev-wallet-seed-has-one-construction',
  check(project) {
    assertNamedPathsExist(
      'dev-wallet-seed-has-one-construction',
      project,
      [SEED_MODULE],
      MISSING_SEED_MODULE_REMEDY
    );
    assertSeedModuleBuildsRoute(project);
    return project
      .getSourceFiles()
      .filter((sourceFile) => isInScope(sourceFile))
      .flatMap((sourceFile) => routeConstructions(sourceFile));
  },
};

export default rule;
