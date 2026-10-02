import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule, {
  FIXTURES_MODULE,
  GATE_MODULE,
  VERDICT_EXPORT,
} from './money-gate-wired-into-auto-fixture.rule.js';

/**
 * Both modules the rule names are resolved from the repository root — the
 * fixtures module reaches the gate module by a relative specifier — so every
 * fixture writes a real path under that root.
 */
function projectWith(files: Record<string, string>): Project {
  const project = new Project({ useInMemoryFileSystem: true });
  for (const [relative, source] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), source);
  }
  return project;
}

/** The gate module, exporting the verdict the fixtures module has to call. */
const GATE_SOURCE =
  'export function moneyGateFailure(ledger: MoneyLedger, spec: GatedSpec): string | null {\n' +
  '  return null;\n' +
  '}\n';

/** The gate's import line as the fixtures module writes it, relative and `.js`-specified. */
const GATE_IMPORT =
  "import { moneyGateFailure, resetMoneyLedger, takeMoneyLedger } from '../scripts/lib/money/money-gate.js';\n";

/** A Playwright fixture body, tuple and options included, as `base.extend` takes it. */
function fixtureModule(...fixtures: string[]): string {
  return (
    "import { test as base } from '@playwright/test';\n" +
    'export const test = base.extend({\n' +
    fixtures.join('') +
    '});\n'
  );
}

/** The shipped shape: an auto fixture that drains the ledger through the verdict. */
const WIRED_FIXTURE =
  '  exactMoneyGateAutoHook: [\n' +
  '    async (_fixtures, use, testInfo) => {\n' +
  '      resetMoneyLedger();\n' +
  '      await use(null);\n' +
  '      const failure = moneyGateFailure(takeMoneyLedger(), { title: testInfo.title });\n' +
  '      if (failure !== null) throw new Error(failure);\n' +
  '    },\n' +
  '    { auto: true },\n' +
  '  ],\n';

/** An auto fixture with nothing to do with money — the rule must ignore it. */
const UNRELATED_AUTO_FIXTURE =
  '  resetRateLimitsAutoHook: [\n' +
  '    async ({ rateLimitResetRequest }, use) => {\n' +
  '      await clearUsageRateLimits(rateLimitResetRequest);\n' +
  '      await use(null);\n' +
  '    },\n' +
  '    { auto: true },\n' +
  '  ],\n';

function projectWithGate(fixturesSource: string): Project {
  return projectWith({ [GATE_MODULE]: GATE_SOURCE, [FIXTURES_MODULE]: fixturesSource });
}

describe('money-gate-wired-into-auto-fixture', () => {
  it('passes when an auto fixture calls the verdict', () => {
    const project = projectWithGate(GATE_IMPORT + fixtureModule(WIRED_FIXTURE));

    expect(rule.check(project)).toEqual([]);
  });

  it('passes when an unrelated auto fixture sits beside the wired one', () => {
    const project = projectWithGate(
      GATE_IMPORT + fixtureModule(UNRELATED_AUTO_FIXTURE, WIRED_FIXTURE)
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('passes when the gate import is written with a `.ts` specifier', () => {
    const project = projectWithGate(
      "import { moneyGateFailure, resetMoneyLedger, takeMoneyLedger } from '../scripts/lib/money/money-gate.ts';\n" +
        fixtureModule(WIRED_FIXTURE)
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('flags an unwired fixture whose gate import is written with a `.ts` specifier', () => {
    const project = projectWithGate(
      "import { moneyGateFailure, resetMoneyLedger, takeMoneyLedger } from '../scripts/lib/money/money-gate.ts';\n" +
        fixtureModule(UNRELATED_AUTO_FIXTURE)
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('passes when the verdict is imported under an alias the auto fixture calls', () => {
    const project = projectWithGate(
      "import { moneyGateFailure as gateVerdict } from '../scripts/lib/money/money-gate.js';\n" +
        fixtureModule(
          '  moneyHook: [\n' +
            '    async (_fixtures, use) => {\n' +
            '      await use(null);\n' +
            '      const failure = gateVerdict(ledger, spec);\n' +
            '    },\n' +
            '    { auto: true },\n' +
            '  ],\n'
        )
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('passes when the verdict is not the first name on the import line', () => {
    const project = projectWithGate(
      "import { resetMoneyLedger, takeMoneyLedger, moneyGateFailure } from '../scripts/lib/money/money-gate.js';\n" +
        fixtureModule(WIRED_FIXTURE)
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('passes when the gate exports the verdict as a const', () => {
    const project = projectWith({
      [GATE_MODULE]: 'export const moneyGateFailure = (ledger, spec) => null;\n',
      [FIXTURES_MODULE]: GATE_IMPORT + fixtureModule(WIRED_FIXTURE),
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('reports the fixtures module when the auto fixture no longer calls the verdict', () => {
    const project = projectWithGate(
      GATE_IMPORT +
        fixtureModule(
          '  exactMoneyGateAutoHook: [\n' +
            '    async (_fixtures, use) => {\n' +
            '      resetMoneyLedger();\n' +
            '      await use(null);\n' +
            '    },\n' +
            '    { auto: true },\n' +
            '  ],\n'
        )
    );

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.file).toContain(FIXTURES_MODULE);
    expect(violations[0]?.message).toContain(VERDICT_EXPORT);
  });

  it('reports it when the verdict is called from a fixture that is not auto', () => {
    const project = projectWithGate(
      GATE_IMPORT +
        fixtureModule(
          UNRELATED_AUTO_FIXTURE,
          '  moneyHook: [\n' +
            '    async (_fixtures, use) => {\n' +
            '      await use(null);\n' +
            '      const failure = moneyGateFailure(takeMoneyLedger(), spec);\n' +
            '    },\n' +
            "    { scope: 'worker' },\n" +
            '  ],\n'
        )
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reports it when the auto option is declared false', () => {
    const project = projectWithGate(
      GATE_IMPORT +
        fixtureModule(
          '  moneyHook: [\n' +
            '    async (_fixtures, use) => {\n' +
            '      await use(null);\n' +
            '      const failure = moneyGateFailure(takeMoneyLedger(), spec);\n' +
            '    },\n' +
            '    { auto: false },\n' +
            '  ],\n'
        )
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reports it when the fixtures module only names the gate in a comment', () => {
    const project = projectWithGate(
      '// The exact-money gate runs from scripts/lib/money/money-gate.ts — moneyGateFailure.\n' +
        fixtureModule(UNRELATED_AUTO_FIXTURE)
    );

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reports it when the verdict is imported and never called', () => {
    const project = projectWithGate(GATE_IMPORT + fixtureModule(UNRELATED_AUTO_FIXTURE));

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reports it when a same-named function is imported from somewhere else', () => {
    const project = projectWith({
      [GATE_MODULE]: GATE_SOURCE,
      'e2e/helpers/local-gate.ts': GATE_SOURCE,
      [FIXTURES_MODULE]:
        "import { moneyGateFailure } from './helpers/local-gate.js';\n" +
        fixtureModule(WIRED_FIXTURE),
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('throws rather than reporting when the fixtures module names no file', () => {
    const project = projectWith({ [GATE_MODULE]: GATE_SOURCE });

    expect(() => rule.check(project)).toThrow(/names no file in the scanned tree/);
  });

  it('throws rather than reporting when the gate module names no file', () => {
    const project = projectWith({
      [FIXTURES_MODULE]: GATE_IMPORT + fixtureModule(WIRED_FIXTURE),
    });

    expect(() => rule.check(project)).toThrow(/names no file in the scanned tree/);
  });

  it('calls a renamed verdict export a liveness failure, not a wiring finding', () => {
    const project = projectWith({
      [GATE_MODULE]:
        'export function moneyGateVerdict(ledger, spec): string | null {\n' +
        '  return null;\n' +
        '}\n',
      [FIXTURES_MODULE]:
        "import { moneyGateVerdict } from '../scripts/lib/money/money-gate.js';\n" +
        fixtureModule(
          '  moneyHook: [\n' +
            '    async (_fixtures, use) => {\n' +
            '      await use(null);\n' +
            '      const failure = moneyGateVerdict(ledger, spec);\n' +
            '    },\n' +
            '    { auto: true },\n' +
            '  ],\n'
        ),
    });

    expect(() => rule.check(project)).toThrow(/LIVENESS failure/);
    expect(() => rule.check(project)).not.toThrow(/names no file in the scanned tree/);
  });

  it('throws when the gate module declares the verdict without exporting it', () => {
    const project = projectWith({
      [GATE_MODULE]:
        'function moneyGateFailure(ledger, spec): string | null {\n  return null;\n}\n',
      [FIXTURES_MODULE]: GATE_IMPORT + fixtureModule(WIRED_FIXTURE),
    });

    expect(() => rule.check(project)).toThrow(/LIVENESS failure/);
  });

  it('names the missing file rather than the liveness failure when a module moved', () => {
    const project = projectWith({
      [FIXTURES_MODULE]: GATE_IMPORT + fixtureModule(WIRED_FIXTURE),
    });

    expect(() => rule.check(project)).not.toThrow(/LIVENESS failure/);
  });
});
