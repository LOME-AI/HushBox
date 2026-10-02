import { SyntaxKind } from 'ts-morph';
import { assertNamedPathsExist, isRepoPath, isTestFile, relativePath } from '../lib/paths.js';
import type { SourceFile } from 'ts-morph';
import type { ArchRule, ArchViolation } from '../types.js';

const RULE = 'console-telemetry-only-where-nothing-composed';

/** The sink factory this rule confines, matched by the name a reference writes. */
const SINK = 'createConsoleTelemetry';

/**
 * The console sink is minted only where nothing composed can exist yet.
 * Everywhere else, telemetry is taken from what the caller already composed —
 * the request pipeline's `logger` variable, or the deps a Durable Object was
 * built with.
 *
 * Why the layer needs a rule at all: Workers observability is off by decision,
 * so a console line is retained nowhere. A capability that mints its own sink
 * still satisfies every type and every test that reads a `Telemetry`, and the
 * loss shows up only as an alert that never fires — three push side-bands
 * shared one Sentry page for total delivery failure while two of them reported
 * into a private console sink, and nothing in the type system, the tests, or
 * review caught it. Threading the parameter fixes those call sites and leaves
 * the shape intact: the next capability factory written without request context
 * reaches for the same sink for the same reason.
 *
 * Why here rather than in the eslint layer: `no-restricted-imports` judges a
 * SPECIFIER, and the sink is re-exported from the dev seed door as well as its
 * own barrel, so a caller can reach it by a specifier no import restriction
 * names. This rule keys on the name a reference writes, whatever module it came
 * through.
 *
 * The declared callers below were derived by executing this over the scanned
 * trees, and re-running it is how a reader checks the list is still the whole
 * set:
 *
 *     grep -rl createConsoleTelemetry --include='*.ts' --include='*.tsx' \
 *       ads apps/*\/src e2e ops packages/*\/src scripts
 *
 * less the test files, which this rule exempts. Each entry states why nothing
 * composed reaches it. `assertNamedPathsExist` refuses a list entry that has
 * stopped naming a file, because an entry that names nothing exempts nothing
 * and reads as a clean pass.
 *
 * Test files are exempt: a unit reads what the sink emits by handing it a
 * recording sink, which is the adapter's own contract rather than a capability
 * losing its caller's telemetry.
 */
export const CONSOLE_TELEMETRY_CALLERS: readonly string[] = [
  // Declares the adapter.
  'apps/api/src/lib/telemetry/console-adapter.ts',
  // The telemetry barrel, which publishes it.
  'apps/api/src/lib/telemetry/index.ts',
  // Composes it INTO the request sink; it is the thing being composed here.
  'apps/api/src/lib/telemetry/request-telemetry.ts',
  // The Worker's `onError` fallback: a defect can reach it before the pipeline
  // stage that sets the composed logger has run, so there may be nothing to take.
  'apps/api/src/app.ts',
  // The door the CLI scripts below take the sink through; it re-exports, never mints.
  'apps/api/src/dev/seed-toolkit.ts',
  // The dev/CI payment mock's own fallback for a caller that passes no telemetry.
  'apps/api/src/slices/billing/adapters/payment-mock.ts',
  // Standalone CLI entry points: no request, no room, nothing composed exists.
  'scripts/seed.ts',
  'scripts/refresh-catalog.ts',
  // The catalog guard those two entry points run, and nothing else imports. It
  // reads the product's catalog through a door that takes a Telemetry, and the
  // only telemetry either caller holds to hand it is this same console sink.
  'scripts/lib/playwright/models.ts',
];

const MISSING_CALLER_REMEDY =
  'A declared caller moved or was deleted: re-derive the set with the grep in this rule and update the list.';

/**
 * A scanned file IS one of the declared callers. Matched through
 * {@link isRepoPath} rather than by equality, because a real run's paths are
 * rooted at the checkout and only an in-memory project's are rooted at `/`.
 */
function isDeclaredCaller(file: string): boolean {
  return CONSOLE_TELEMETRY_CALLERS.some((caller) => isRepoPath(file, caller));
}

/**
 * Every place a file writes the sink's name — the import specifier, the alias
 * it binds, the call, and the member taken off a namespace import. Matching the
 * written name rather than a resolved symbol is what keeps the re-exporting
 * door from laundering a caller past the rule.
 */
function sinkReferences(sourceFile: SourceFile): number[] {
  return sourceFile
    .getDescendantsOfKind(SyntaxKind.Identifier)
    .filter((identifier) => identifier.getText() === SINK)
    .map((identifier) => identifier.getStartLineNumber());
}

const rule: ArchRule = {
  name: RULE,
  check(project) {
    assertNamedPathsExist(RULE, project, CONSOLE_TELEMETRY_CALLERS, MISSING_CALLER_REMEDY);
    const violations: ArchViolation[] = [];
    for (const sourceFile of project.getSourceFiles()) {
      const file = relativePath(sourceFile);
      if (isDeclaredCaller(file) || isTestFile(file)) continue;
      for (const line of sinkReferences(sourceFile)) {
        violations.push({
          file,
          line,
          message:
            `${SINK} mints a console-only sink, which is retained nowhere. Take the telemetry ` +
            'the caller composed instead, or declare this file in the rule with the reason ' +
            'nothing composed can reach it.',
        });
      }
    }
    return violations;
  },
};

export default rule;
