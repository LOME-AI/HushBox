import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { PRICE_OWNERS } from './money-internals-owners-only.rule.js';

/**
 * The named files, as the tree the rule reads them out of. Every fixture holds
 * them because the rule now asserts they are there, and deriving them from the
 * list itself is what keeps the fixture from becoming a second copy of it that
 * drifts. A fixture models a stale entry by leaving one out.
 *
 * Each carries a walled reach because the rule asserts that too: an entry is
 * meant to exempt a file that would otherwise be a violation, so a named file
 * reaching nothing is an entry exempting nothing. Deriving the fixtures from
 * the list satisfies that assertion by construction, so a fixture models a
 * reach-less entry the only way left — by overriding one named file with a body
 * that reaches nothing.
 *
 * The same derivation is why an entry naming a real but WRONG file is invisible
 * in this file: the fixture is materialised at whatever path the entry names,
 * reach and all. Measured over this suite by repointing every entry in the list
 * in turn at a real non-owner this file does not itself write out: an entry this
 * file does not ALSO write out as a literal stayed green. The rest red for an
 * unrelated reason — a case spelling a path out needs that path to still be a
 * named entry — and never because the suite saw the mis-spelling.
 * `pnpm arch:check` over the repository is that detector, and it throws on the
 * reach; these cases pin only that the assertion fires.
 */
function namedFiles(paths: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    paths.map((path) => [
      path,
      "import { reservationCeiling } from '@hushbox/shared/affordability/estimate/reducers';\n",
    ])
  );
}

function projectWith(
  files: Record<string, string>,
  named: readonly string[] = PRICE_OWNERS
): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [filePath, source] of Object.entries({ ...namedFiles(named), ...files })) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

/**
 * The named entries this file also writes out as literal paths, and the only
 * ones: renaming any other entry leaves this suite green, while renaming one of
 * these fails cases whose messages name neither the entry nor the rename — in a
 * suite a maintainer renaming an api file has no reason to open. The case
 * guarding them fails alongside those and names the collision.
 *
 * Hand-written rather than read out of `PRICE_OWNERS`: taken from the list they
 * would move with any rename and assert nothing. What they do NOT cover is a
 * fourth literal added later without joining them — the set is a list, not a
 * measurement, so reach for these constants rather than writing a path out again.
 */
const OWNER = 'apps/api/src/slices/models/domain/pricing/estimate-run.ts';
const OWNER_COLOCATED_TEST = 'apps/api/src/slices/models/domain/pricing/estimate-run.test.ts';
const OWNER_WITHOUT_REACH = 'apps/api/src/slices/chat/domain/turn/reasoning.ts';
const ENTRIES_WRITTEN_OUT_HERE = [OWNER, OWNER_COLOCATED_TEST, OWNER_WITHOUT_REACH];

const NON_OWNER = 'apps/api/src/slices/chat/domain/runtime.ts';

describe('the entries this file writes out as literals', () => {
  it('names only paths PRICE_OWNERS still holds, so a rename that missed this file says so', () => {
    for (const entry of ENTRIES_WRITTEN_OUT_HERE) {
      expect(PRICE_OWNERS).toContain(entry);
    }
  });
});

describe('the named paths', () => {
  it('throws when a named price owner no longer exists in the tree', () => {
    const project = projectWith(
      { [NON_OWNER]: "import { getTurnOptions } from '@hushbox/shared';\n" },
      PRICE_OWNERS.filter((path) => path !== OWNER)
    );

    expect(() => rule.check(project)).toThrow(OWNER);
  });

  it('throws when a named price owner exists but reaches no walled specifier', () => {
    const project = projectWith({ [OWNER_WITHOUT_REACH]: 'export {};\n' });

    expect(() => rule.check(project)).toThrow(OWNER_WITHOUT_REACH);
  });
});

describe('money-internals-owners-only', () => {
  it('flags a walled subpath import from a non-owner api file', () => {
    const project = projectWith({
      [NON_OWNER]:
        "import { evaluateManifest } from '@hushbox/shared/affordability/estimate/reducers';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: `/${NON_OWNER}`, line: 1 });
    expect(violations[0]?.message).toContain('estimate/reducers');
  });

  it('flags a walled subpath RE-EXPORT, which no import-only scan sees', () => {
    const project = projectWith({
      [NON_OWNER]:
        "export { MINIMUM_OUTPUT_TOKENS as ANSWER_FLOOR } from '@hushbox/shared/affordability/constants';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  /**
   * Named rather than counted: two violations off the import line, with the
   * registrar missed entirely, is the same count as one of each.
   *
   * What this case guards is the registrar reach alone. Suppressing the shared
   * reference walk's dynamic-import form leaves every case in this file green,
   * so the line-1 reach is attributable to no arm here; suppressing its
   * `import-equals` or `import-type` form reds this file instead, and every
   * form of that walk is pinned in the walk's own suite.
   */
  it('flags a walled subpath reached through a dynamic import or vi.mock', () => {
    const project = projectWith({
      [NON_OWNER]:
        "const m = await import('@hushbox/shared/affordability/estimate/price-request');\n" +
        "vi.mock('@hushbox/shared/affordability/estimate/reducers');\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.line)).toEqual([1, 2]);
    expect(violations[0]?.message).toContain('estimate/price-request');
    expect(violations[1]?.message).toContain('estimate/reducers');
  });

  it('passes the affordability barrel itself from a non-owner file', () => {
    const project = projectWith({
      [NON_OWNER]: "import { priceableModelFrom } from '@hushbox/shared/affordability';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes the package root barrel from a non-owner file', () => {
    const project = projectWith({
      [NON_OWNER]: "import { getTurnOptions } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a walled subpath from a designated price owner', () => {
    const project = projectWith({
      [OWNER]:
        "import { reservationCeiling } from '@hushbox/shared/affordability/estimate/reducers';\n" +
        "export { outputTokensOf } from '@hushbox/shared/affordability/estimate/run-ceiling';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it("passes an owner's colocated test, which drives the same arithmetic", () => {
    const project = projectWith({
      [OWNER_COLOCATED_TEST]:
        "import { classifierReserveChars } from '@hushbox/shared/affordability/estimate/smart-model-affordability';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it("ignores apps/web, which is out of this rule's scope, and the module's own relative reaches", () => {
    const project = projectWith({
      'apps/web/src/hooks/billing/use-prompt-budget.ts':
        "import { getEffectiveBalanceNano } from '@hushbox/shared/affordability/estimate/pre-adapters';\n",
      'packages/shared/src/affordability/turn-options.ts':
        "import { reservationCeiling } from './estimate/reducers.js';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a walled subpath bound by an import assignment', () => {
    const project = projectWith({
      [NON_OWNER]:
        "import reducers = require('@hushbox/shared/affordability/estimate/reducers');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a walled subpath named in type position', () => {
    const project = projectWith({
      [NON_OWNER]:
        "export type M = import('@hushbox/shared/affordability/estimate/types').Manifest;\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a walled subpath named by a typeof import', () => {
    const project = projectWith({
      [NON_OWNER]:
        "export type R = typeof import('@hushbox/shared/affordability/estimate/reducers');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a walled subpath reached by a backtick-quoted dynamic import', () => {
    const project = projectWith({
      [NON_OWNER]: 'const m = await import(`@hushbox/shared/affordability/estimate/reducers`);\n',
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('counts an ordinary call that passes a walled specifier, the price of not reading the callee', () => {
    const project = projectWith({
      [NON_OWNER]: "log('@hushbox/shared/affordability/estimate/reducers');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags both walled specifiers when a call is applied to the result of a call', () => {
    const project = projectWith({
      [NON_OWNER]:
        "register('@hushbox/shared/affordability/estimate/reducers')('@hushbox/shared/affordability/estimate/price-request');\n",
    });

    const messages = rule.check(project).map((violation) => violation.message);

    expect(messages).toHaveLength(2);
    expect(messages.filter((message) => message.includes('estimate/reducers'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('estimate/price-request'))).toHaveLength(
      1
    );
  });

  it('flags both walled specifiers when a require call is immediately invoked', () => {
    const project = projectWith({
      [NON_OWNER]:
        "const made = require('@hushbox/shared/affordability/estimate/reducers')('@hushbox/shared/affordability/estimate/price-request');\n",
    });

    const messages = rule.check(project).map((violation) => violation.message);

    expect(messages).toHaveLength(2);
    expect(messages.filter((message) => message.includes('estimate/reducers'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('estimate/price-request'))).toHaveLength(
      1
    );
  });

  it('flags both walled specifiers when a registrar call is chained off another', () => {
    const project = projectWith({
      [NON_OWNER]:
        "vi.mock('@hushbox/shared/affordability/estimate/reducers').mock('@hushbox/shared/affordability/estimate/price-request');\n",
    });

    const messages = rule.check(project).map((violation) => violation.message);

    expect(messages).toHaveLength(2);
    expect(messages.filter((message) => message.includes('estimate/reducers'))).toHaveLength(1);
    expect(messages.filter((message) => message.includes('estimate/price-request'))).toHaveLength(
      1
    );
  });

  it('flags both reaches when ONE walled specifier is imported and then substituted', () => {
    const project = projectWith({
      [NON_OWNER]:
        "import { evaluateManifest } from '@hushbox/shared/affordability/estimate/reducers';\n" +
        "vi.mock('@hushbox/shared/affordability/estimate/reducers');\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.line)).toEqual([1, 2]);
  });

  it('passes a dynamic specifier that is not written out, which no prefix test can read', () => {
    const project = projectWith({
      [NON_OWNER]:
        'const load = (unit: string) => import(`@hushbox/shared/affordability/${unit}`);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes calls that carry no walled specifier', () => {
    const project = projectWith({
      'apps/api/src/slices/billing/domain/settle.ts':
        'export const total = compute();\n' +
        'export const logged = emit(total);\n' +
        "export const loaded = await import('@hushbox/shared');\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a walled subpath import from a package', () => {
    const project = projectWith({
      'packages/db/src/queries/usage.ts':
        "import { reservationCeiling } from '@hushbox/shared/affordability/estimate/reducers';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: '/packages/db/src/queries/usage.ts', line: 1 });
  });

  it('flags a walled subpath import from the admin app', () => {
    const project = projectWith({
      'apps/admin/src/operations/refund-form.ts':
        "import { steppedCallLineItems } from '@hushbox/shared/affordability/estimate/price-request';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reports one violation per reach, at its own line', () => {
    const project = projectWith({
      [NON_OWNER]:
        "import { MINIMUM_OUTPUT_TOKENS } from '@hushbox/shared/affordability/constants';\n" +
        "import { steppedCallLineItems } from '@hushbox/shared/affordability/estimate/price-request';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(2);
    expect(violations.map((violation) => violation.line)).toEqual([1, 2]);
  });
});
