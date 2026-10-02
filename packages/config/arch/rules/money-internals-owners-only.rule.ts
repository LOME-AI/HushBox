import { SyntaxKind, ts } from 'ts-morph';
import { moduleReferences } from '../lib/module-references.js';
import {
  assertNamedPathsExist,
  failWith,
  isRepoPath,
  relativePath,
  sourceFileAt,
} from '../lib/paths.js';
import type { Project, SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

/**
 * The money layer's internals are hidden from CONSUMERS of prices, not from
 * every package. `docs/BILLING.md` §Where the Code Lives keeps the pricing
 * machinery — rates, manifests, reducers, the characters-per-token ratios, the
 * reasoning-budget ladder, per-candidate ceiling solvers and clamping — off
 * both barrels, so a surface that renders or decides on a price cannot reach
 * it. Code that PRODUCES prices is on the other side of that boundary: the
 * server's estimator is money-layer code that lives in `apps/api` because it
 * runs on the Worker, and the shared module cannot express what it needs — a
 * compiled workflow definition's fan-out/step/iteration multipliers arrive as
 * opaque integers (§Where the DAG lives), and settlement prices OBSERVED usage,
 * a question the producer surface does not answer at all.
 *
 * The export map alone cannot draw that line: it sees packages, and both the
 * estimator and the picker sit outside `packages/shared`. This rule draws it by
 * path instead. Every allowed file is named, so the owner set grows only by a
 * visible edit to this list.
 *
 * Scope is the api app, the admin app and every package: the wall is a property
 * of the money module, so a consumer does not escape it by living elsewhere,
 * and the remedy (go through a barrel, or ask for the missing producer) is the
 * same from any of them. `apps/web` and the other client surfaces are
 * deliberately out: web code owes a STRICTER obligation than this rule
 * expresses (`docs/BILLING.md` §What is enforced — a pricing symbol is
 * reachable only by the one file that publishes that verdict), and it is
 * enforced by `web-prices-through-producers`, which tiers RESOLVED symbols
 * rather than specifier depth. Widening this rule over web would restate a
 * weaker version of that wall in a second place. The money
 * module's own files reach their neighbours by relative path, which is never a
 * package specifier and so never matches.
 *
 * Only a specifier DEEPER than the barrel is walled: `@hushbox/shared` and
 * `@hushbox/shared/affordability` are the two sanctioned doors and are always
 * legal.
 */

/**
 * Exported beside {@link walledSpecifiers}: `interim-subpaths-have-consumers`
 * maps a reach back to the exports-map entry that publishes it, and a second
 * spelling of this prefix would let the two rules disagree about which
 * specifiers are doors at all.
 */
export const WALLED_PREFIX = '@hushbox/shared/affordability/';
const WALLED_ROOTS: readonly string[] = ['apps/api/', 'apps/admin/', 'packages/'];

/**
 * Files that PRODUCE prices, plans and holds. Each reaches module internals
 * because the published surface answers a different question, and each is
 * money-layer code by role rather than by location. Colocated and satellite
 * tests are named too: a test that drives an owner's arithmetic to a pinned
 * amount is exercising the owner's own vocabulary, and deriving test paths
 * from source paths would silently admit any file that adopted the naming.
 *
 * Exported so the colocated test seeds its fixtures from this list rather than
 * from a copy of it.
 */
export const PRICE_OWNERS: readonly string[] = [
  // The server adapter over the shared price core, on the domain `Result`
  // channel: a call's reserved parts under the declared run ceiling, media's
  // deterministic price and observed usage priced for settlement, among others.
  'apps/api/src/slices/models/domain/pricing/estimate.ts',
  // Walks a compiled workflow definition into the admission hold.
  'apps/api/src/slices/models/domain/pricing/estimate-run.ts',
  'apps/api/src/slices/models/domain/pricing/estimate-run.test.ts',
  // The Smart Model candidate pool: per-candidate ceilings and the folded
  // classifier reserve.
  'apps/api/src/slices/models/domain/smart-model/candidates.ts',
  'apps/api/src/slices/models/domain/smart-model/candidates.test.ts',
  // The trial gate's own price: the reserve-side price of one trial message, each
  // token at the ceiling of the model's billable rate.
  'apps/api/src/slices/models/domain/smart-model/trial-eligibility.ts',
  // Catalog ingestion: refuses a price the schedule cannot parse before it is
  // written.
  'apps/api/src/slices/models/domain/catalog/normalize.ts',
  // The served catalog: each row's served rates, and the Smart Model row's
  // range, read off the anchor.
  'apps/api/src/slices/models/domain/catalog/list-models.ts',
  // The engine admits on the run's reservation, which it receives call by call.
  'apps/api/src/slices/workflows/domain/engine/interpreter.ts',
  // Solves the turn's shared token count and stamps each sibling's cap — the
  // server-side clamp order, deliberately distinct from the module's.
  'apps/api/src/slices/chat/domain/turn/definition.ts',
  'apps/api/src/slices/chat/domain/turn/definition.test.ts',
  // Satellite tests of the two above: the ceiling property, the classifier
  // reserve basis, the two arms' prices measured against that reserve, and the
  // answer cap the compile's fit lands on, read against the shared token floor
  // the media arms collapse to.
  'apps/api/src/slices/chat/domain/turn/ceiling.property.test.ts',
  'apps/api/src/slices/chat/domain/turn/classifier.test.ts',
  'apps/api/src/slices/chat/domain/effort-arm-pricing.property.test.ts',
  'apps/api/src/slices/chat/domain/turn/definition-modality.integration.test.ts',
  // Resolves the turn's effort per model into the wire config and budget.
  'apps/api/src/slices/chat/domain/turn/reasoning.ts',
  'apps/api/src/slices/chat/domain/turn/reasoning.test.ts',
  // The Smart Model slot's pricing test states its oracles in the walled
  // internals' own terms (reasoning budgets, the classifier reserve). The
  // compile it drives reaches none of them: its one affordability question is
  // asked through the money layer's published door.
  'apps/api/src/slices/chat/domain/smart-model/turn.test.ts',
];

/** Suffix match, not substring: `.../estimate.ts` must not admit `.../my-estimate.ts`. */
function isAllowed(repoRelativePath: string): boolean {
  return PRICE_OWNERS.some((allowed) => isRepoPath(repoRelativePath, allowed));
}

function isWalled(specifier: string): boolean {
  return specifier.startsWith(WALLED_PREFIX);
}

/**
 * Every reach at a walled specifier, gathered by two arms with different
 * subjects.
 *
 * The first arm is the shared reference walk
 * (`packages/config/arch/lib/module-references.ts`), which owns the forms that
 * LINK one module into another and is where a newly learned form arrives once
 * for every rule. It is taken whole rather than filtered: this wall's subject
 * is reaching the module at all, so no linking form is out of it.
 *
 * The second arm is a form the shared walk deliberately reports nothing about,
 * because it links nothing: ANY call whose first argument is written out as a
 * string. A mock registrar (`vi.mock('<walled>')`) names a walled unit and
 * substitutes it without the module system binding anything, and substituting
 * an internal is as much a reach as importing one. The callee is deliberately
 * not read — an allowed-callee list goes blind on the next registrar spelling,
 * where reading the argument cannot — and the price is stated rather than
 * fixed: an ordinary call that happens to pass a walled specifier as its first
 * argument is counted too. That over-count costs a false report on a line that
 * names a money internal in a string, which is cheap next to a missed
 * substitution.
 *
 * Both arms read the specifier the source writes down, so a specifier assembled
 * at runtime — a template carrying a substitution — is passed over by both: no
 * prefix test can read one, and reporting every unreadable specifier would
 * stand this wall over the legitimate computed loaders elsewhere in the tree.
 * That gap is accepted here and closed nowhere: a computed reach at a money
 * internal is invisible to this rule.
 *
 * Re-exports matter as much as imports — an aliased
 * `export { X as Y } from '<walled>'` republishes an internal under a name no
 * grep for the original finds, which is how five such sites survived two
 * inventories of this wall.
 *
 * Exported because `interim-subpaths-have-consumers` asks the mirror question —
 * which walled doors anything reaches — and must count the same routes: a route
 * only this rule knew about would read there as a door nobody uses, and the
 * remedy it prints is to delete that door.
 */
export function walledSpecifiers(sourceFile: SourceFile): { specifier: string; line: number }[] {
  // Keyed by position AND specifier, because neither half suffices alone: the two
  // arms both report the `import(…)`/`require(…)` node, so one node naming one
  // module must collapse to one reach, while a call applied to a call's result
  // shares its start position while naming a different module.
  const found = new Map<string, { specifier: string; line: number; start: number }>();

  for (const reference of moduleReferences(sourceFile.compilerNode)) {
    const specifier = reference.specifier;
    if (specifier === undefined || !isWalled(specifier)) continue;
    const start = reference.node.getStart(sourceFile.compilerNode);
    found.set(`${String(start)}:${specifier}`, { specifier, line: reference.line, start });
  }

  for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const [firstArgument] = call.getArguments();
    if (firstArgument === undefined) continue;
    const literal = firstArgument.compilerNode;
    if (!ts.isStringLiteralLike(literal) || !isWalled(literal.text)) continue;
    const start = call.getStart();
    found.set(`${String(start)}:${literal.text}`, {
      specifier: literal.text,
      line: call.getStartLineNumber(),
      start,
    });
  }

  return [...found.values()]
    .toSorted((left, right) => left.start - right.start)
    .map(({ specifier, line }) => ({ specifier, line }));
}

/**
 * The allowed paths are the whole of this wall's aim: an entry that stops
 * naming a file un-walls nothing and re-walls nothing, it simply exempts a file
 * that is gone, and every reach the rule reports afterwards looks identical to
 * a clean run.
 *
 * Existing is not enough, because a path can be real and still be the wrong
 * one. An entry naming a real file that reaches nothing throws no missing-path
 * error, exempts a file that needed no exemption, and leaves the owner it was
 * meant for walled — over-permitting one file and under-serving another. Only
 * the over-permission is invisible: the wrongly-named file reaches nothing, so
 * it contributes no violation. The under-served owner's own reaches DO surface,
 * as ordinary violations against that owner — measured over this repository by
 * repointing one owner at a real non-owner, which returns exactly that owner's
 * own reaches and nothing else — but none of them names the list entry, so the
 * red cannot be read back to the spelling. Two shapes produce it and neither
 * leaves a red that names the spelling: an entry added PREEMPTIVELY, for a
 * reach that has not been written yet, and an entry that OUTLIVES the reach it
 * was added for.
 *
 * So every entry must also REACH the wall it is exempted from. The intended
 * cost is the mirror of the intended benefit: an owner whose last walled reach
 * is removed reds until its entry goes with it.
 */
function assertAllowedPathsExist(project: Project): void {
  const fail = failWith('money-internals-owners-only');
  assertNamedPathsExist(
    'money-internals-owners-only',
    project,
    PRICE_OWNERS,
    'Point the entry at the file it now names, or drop it: an entry naming ' +
      'nothing exempts nothing and the wall stands over a path that is gone.'
  );
  for (const named of PRICE_OWNERS) {
    const sourceFile = sourceFileAt(project, named);
    if (sourceFile !== undefined && walledSpecifiers(sourceFile).length > 0) continue;
    fail(
      `'${named}' reaches no walled specifier, so its entry exempts nothing. ` +
        'Point it at the file that does the reaching, or drop it: an owner that ' +
        'no longer needs the wall opened is an exemption nobody is checking.'
    );
  }
}

const rule: ArchRule = {
  name: 'money-internals-owners-only',
  check(project) {
    assertAllowedPathsExist(project);
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const filePath = sourceFile.getFilePath();
      if (!WALLED_ROOTS.some((root) => filePath.includes(root))) continue;
      if (isAllowed(relativePath(sourceFile))) continue;
      for (const { specifier, line } of walledSpecifiers(sourceFile)) {
        violations.push({
          file: filePath,
          line,
          message:
            `'${specifier}' is a money-layer internal. The affordability module's ` +
            'internals are reachable only from the price OWNERS named in ' +
            'money-internals-owners-only.rule.ts; every other file in scope goes ' +
            "through '@hushbox/shared' or '@hushbox/shared/affordability' " +
            '(docs/BILLING.md §Where the Code Lives). If the barrel cannot express ' +
            'what you need, the producer is missing a function — report it rather ' +
            'than widening the wall.',
        });
      }
    }
    return violations;
  },
};

export default rule;
