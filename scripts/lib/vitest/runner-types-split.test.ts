import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { stringify } from 'yaml';
import { runnerTypesSplitFailure } from './runner-types-split.js';

const COVERAGE = '@vitest/coverage-v8';
const UI = '@vitest/ui';
const PEERED = '4.1.10(vitest@4.1.10)';

interface ImporterFixture {
  readonly types?: string;
  readonly runner?: string;
  readonly declares?: readonly string[];
}

/** A resolved `vitest` version naming one runtime-types instance, twice, as pnpm writes it. */
function runner(types: string): string {
  return `4.1.10(@types/node@${types})(vite@8.2.2(@types/node@${types})(esbuild@0.28.1))`;
}

function lockfileText(
  importers: Record<string, ImporterFixture>,
  snapshots: Record<string, Record<string, string>>
): string {
  return stringify({
    importers: Object.fromEntries(
      Object.entries(importers).map(([name, fixture]) => [
        name,
        {
          devDependencies: {
            ...(fixture.types === undefined
              ? {}
              : { '@types/node': { specifier: `^${fixture.types}`, version: fixture.types } }),
            ...(fixture.runner === undefined
              ? {}
              : { vitest: { specifier: '^4.1.10', version: runner(fixture.runner) } }),
            ...Object.fromEntries(
              (fixture.declares ?? []).map((declared) => [
                declared,
                { specifier: '^4.1.10', version: PEERED },
              ])
            ),
          },
        },
      ])
    ),
    snapshots: Object.fromEntries(
      Object.entries(snapshots).map(([key, dependencies]) => [
        key,
        Object.keys(dependencies).length === 0 ? {} : { dependencies },
      ])
    ),
  });
}

describe('runnerTypesSplitFailure', () => {
  it('accepts snapshots and declaring importers that name one instance', () => {
    expect(
      runnerTypesSplitFailure(
        lockfileText(
          { scripts: { types: '24.13.3', declares: [COVERAGE] } },
          { [`${COVERAGE}@${PEERED}`]: { vitest: runner('24.13.3') } }
        )
      )
    ).toBe(undefined);
  });

  it('reports a snapshot whose runner names an instance no declaring importer links', () => {
    const failure = runnerTypesSplitFailure(
      lockfileText(
        { scripts: { types: '24.13.3', declares: [COVERAGE] } },
        { [`${COVERAGE}@${PEERED}`]: { vitest: runner('25.9.3') } }
      )
    );

    expect(failure).toMatch(/24\.13\.3/u);
    expect(failure).toMatch(/25\.9\.3/u);
    expect(failure).toMatch(/@vitest\/coverage-v8@4\.1\.10\(vitest@4\.1\.10\)/u);
    expect(failure).toMatch(/scripts/u);
  });

  it('explains the discriminator the key lacks and the symptom the split surfaces as', () => {
    const failure = runnerTypesSplitFailure(
      lockfileText(
        { scripts: { types: '24.13.3', declares: [COVERAGE] } },
        { [`${COVERAGE}@${PEERED}`]: { vitest: runner('25.9.3') } }
      )
    );

    expect(failure).toMatch(/without naming @types\/node/u);
    expect(failure).toMatch(/TS2416/u);
  });

  it('states the repair as declaring the package wherever a project omits it', () => {
    const failure = runnerTypesSplitFailure(
      lockfileText(
        { scripts: { types: '24.13.3', declares: [COVERAGE] } },
        { [`${COVERAGE}@${PEERED}`]: { vitest: runner('25.9.3') } }
      )
    );

    expect(failure).toMatch(/declaring @types\/node in each workspace project that omits it/u);
    expect(failure).toMatch(/peer auto-install off/u);
  });

  it('offers no rollback to an earlier lockfile revision as the repair', () => {
    const failure = runnerTypesSplitFailure(
      lockfileText(
        { scripts: { types: '24.13.3', declares: [COVERAGE] } },
        { [`${COVERAGE}@${PEERED}`]: { vitest: runner('25.9.3') } }
      )
    );

    expect(failure).not.toMatch(/revision/u);
    expect(failure).not.toMatch(/never by adding/u);
  });

  it('reports a project resolving the runner against an instance another project does not state', () => {
    const failure = runnerTypesSplitFailure(
      lockfileText(
        {
          scripts: { types: '24.13.3', runner: '24.13.3', declares: [COVERAGE] },
          'packages/crypto': { runner: '25.9.3' },
        },
        { [`${COVERAGE}@${PEERED}`]: { vitest: runner('24.13.3') } }
      )
    );

    expect(failure).toMatch(/@types\/node@24\.13\.3 — [^\n]*scripts/u);
    expect(failure).toMatch(/@types\/node@25\.9\.3 — [^\n]*packages\/crypto/u);
  });

  it('reports the split rather than the hazard when a resolved runner states an instance', () => {
    expect(
      runnerTypesSplitFailure(
        lockfileText(
          { 'packages/db': { declares: [COVERAGE] }, 'packages/crypto': { runner: '24.13.3' } },
          { [`${COVERAGE}@${PEERED}`]: { vitest: runner('25.9.3') } }
        )
      )
    ).toMatch(/is split 2 ways/u);
  });

  it('reports declaring importers that state no runtime-types instance of their own', () => {
    expect(
      runnerTypesSplitFailure(
        lockfileText(
          { 'packages/db': { declares: [COVERAGE] } },
          { [`${COVERAGE}@${PEERED}`]: { vitest: runner('25.9.3') } }
        )
      )
    ).toMatch(
      /no importer declaring one of those packages states a @types\/node, and none resolves/u
    );
  });

  it('passes a runtime-types version both sides moved to together', () => {
    expect(
      runnerTypesSplitFailure(
        lockfileText(
          {
            '.': { types: '30.0.1', declares: [COVERAGE, UI] },
            scripts: { types: '30.0.1', declares: [COVERAGE] },
          },
          {
            [`${COVERAGE}@${PEERED}`]: { vitest: runner('30.0.1') },
            [`${UI}@${PEERED}`]: { vitest: runner('30.0.1') },
          }
        )
      )
    ).toBe(undefined);
  });

  it('leaves a key that names the runtime-types instance itself unjudged', () => {
    const discriminated =
      '@cloudflare/vitest-pool-workers@0.16.15(@types/node@25.9.3)(vitest@4.1.10)';

    expect(
      runnerTypesSplitFailure(
        lockfileText(
          { scripts: { types: '24.13.3', declares: [COVERAGE] } },
          {
            [`${COVERAGE}@${PEERED}`]: { vitest: runner('24.13.3') },
            [discriminated]: { vitest: runner('25.9.3') },
          }
        )
      )
    ).toBe(undefined);
  });

  it('names every importer on each side when the declaring importers disagree', () => {
    const failure = runnerTypesSplitFailure(
      lockfileText(
        {
          '.': { types: '24.13.3', declares: [COVERAGE] },
          scripts: { types: '25.9.3', declares: [COVERAGE] },
        },
        { [`${COVERAGE}@${PEERED}`]: { vitest: runner('24.13.3') } }
      )
    );

    expect(failure).toMatch(
      /@types\/node@24\.13\.3 — snapshot @vitest\/coverage-v8@[^,]+, importer \./u
    );
    expect(failure).toMatch(/@types\/node@25\.9\.3 — importer scripts/u);
  });

  it('leaves a runner-peered key that nests no runner unjudged', () => {
    expect(
      runnerTypesSplitFailure(
        lockfileText(
          { scripts: { types: '24.13.3', declares: [COVERAGE] } },
          {
            [`${COVERAGE}@${PEERED}`]: { vitest: runner('24.13.3') },
            [`${UI}@${PEERED}`]: {},
            '@vitest/spy@4.1.10(vitest@4.1.10)': { '@vitest/utils': '4.1.10' },
          }
        )
      )
    ).toBe(undefined);
  });
});

describe('the repository as it stands', () => {
  it('resolves one runtime-types instance across the vitest seam', () => {
    expect(
      runnerTypesSplitFailure(
        readFileSync(path.join(import.meta.dirname, '..', '..', '..', 'pnpm-lock.yaml'), 'utf8')
      )
    ).toBe(undefined);
  });
});
