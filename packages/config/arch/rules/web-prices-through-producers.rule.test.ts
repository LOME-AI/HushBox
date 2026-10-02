import { Project, ts } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import rule, { PUBLISHERS } from './web-prices-through-producers.rule.js';

/**
 * The money module the fixtures import through, small but shaped like the real
 * one: a producer module, a primitive module, a machinery module, the
 * affordability door and the package root barrel above them.
 *
 * The barrels are STAR re-exports on purpose. That is the shape the real
 * barrel has, and it is the reason this rule resolves symbols instead of
 * matching names: a name allowlist over a star re-export reads nothing about
 * where the symbol actually lives.
 */
const MONEY_MODULE: Readonly<Record<string, string>> = {
  '/packages/shared/src/affordability/turn/turn-options.ts':
    'export function getTurnOptions(): number {\n  return 1;\n}\n' +
    'export function getMediaTurnOptions(): number {\n  return 2;\n}\n' +
    'export function getAffordableOptions(): number {\n  return 3;\n}\n' +
    'export function smartSlotAvailability(): boolean {\n  return true;\n}\n',
  '/packages/shared/src/affordability/money/nano-usd.ts':
    'export type NanoUSD = string;\n' +
    'export function nanoUsdToDollarString(wire: string): string {\n  return wire;\n}\n',
  '/packages/shared/src/affordability/money/min-turn-cost.ts':
    'export function minTurnCostNanoUsd(): bigint {\n  return 0n;\n}\n',
  '/packages/shared/src/affordability/money/tiers.ts':
    'export function getUserTier(): string {\n  return "free";\n}\n' +
    'export function tierCanAccessPremium(): boolean {\n  return false;\n}\n',
  // The machinery module: a characters-per-token conversion, which no allowed
  // tier of this rule lists.
  '/packages/shared/src/affordability/constants.ts':
    'export function inputTokensOf(): number {\n  return 4;\n}\n' +
    'export function isExpensiveModelNano(): boolean {\n  return false;\n}\n' +
    'export const TOTAL_FEE_RATE = 0.15;\n',
  // The price core's display producer and the type it returns.
  '/packages/shared/src/affordability/price/display.ts':
    'export interface ModelPriceDisplay {\n  readonly expensive: boolean;\n}\n' +
    'export function modelPriceDisplay(): ModelPriceDisplay {\n  return { expensive: false };\n}\n',
  '/packages/shared/src/affordability/index.ts':
    "export * from './price/display.js';\n" +
    "export * from './turn/turn-options.js';\n" +
    "export * from './money/nano-usd.js';\n" +
    "export * from './money/min-turn-cost.js';\n" +
    "export * from './money/tiers.js';\n" +
    "export * from './constants.js';\n",
  '/packages/shared/src/index.ts': "export * from './affordability/index.js';\n",
};

/**
 * Where the two doors lead. Overriding this is how a fixture models a
 * resolution that succeeds without reaching the money module.
 */
const SOURCE_DOORS: Readonly<Record<string, string[]>> = {
  '@hushbox/shared': ['/packages/shared/src/index.ts'],
  '@hushbox/shared/affordability': ['/packages/shared/src/affordability/index.ts'],
};

/** A module the package publishes under a deeper subpath than either door. */
const DEEP_MODULE = '/packages/shared/src/affordability/constants.ts';

/**
 * The publisher files, as the web tree the rule reads them out of. Every
 * fixture holds them because the rule asserts they are there, and they are
 * derived from the producer tier rather than listed again so the fixture cannot
 * drift from it. A fixture models a stale publisher by leaving one out, and an
 * unscanned web tree by passing none.
 */
const WEB_TREE: Readonly<Record<string, string>> = Object.fromEntries(
  PUBLISHERS.map((publisher) => [`/${publisher}`, 'export {};\n'])
);

/**
 * A project the rule can resolve symbols in. `paths` stands in for the
 * workspace link the real run resolves `@hushbox/shared` through; the rule
 * itself reads only resolved symbols, so the two projects hand it the same
 * thing by different routes.
 */
function projectWith(
  files: Record<string, string>,
  money = MONEY_MODULE,
  doors = SOURCE_DOORS,
  web = WEB_TREE
): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      // The rule reads declaration sites, never types, so the standard library
      // is pure cost here — loading it per fixture made this file a pole.
      noLib: true,
      baseUrl: '/',
      paths: { ...doors },
    },
  });
  for (const [filePath, source] of Object.entries({ ...money, ...web, ...files })) {
    project.createSourceFile(filePath, source);
  }
  return project;
}

const WEB_FILE = '/apps/web/src/components/chat/pricing-panel.tsx';
const PUBLISHER = '/apps/web/src/hooks/billing/use-turn-options.ts';
const SERVER_STAND_IN = '/apps/web/src/demo/mock-backend/store.ts';
const DISPLAY_PUBLISHER = '/apps/web/src/lib/chat/model-info-facts.ts';

describe('the machinery tier', () => {
  it('flags a machinery symbol imported by an apps/web file', () => {
    const project = projectWith({
      [WEB_FILE]: "import { inputTokensOf } from '@hushbox/shared';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ file: WEB_FILE, line: 1 });
    expect(violations[0]?.message).toContain('inputTokensOf');
  });

  it('flags a machinery symbol renamed on the way in, which a name allowlist would miss', () => {
    const project = projectWith({
      [WEB_FILE]: "import { inputTokensOf as tierOf } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a machinery symbol reached through the affordability door', () => {
    const project = projectWith({
      [WEB_FILE]: "import { inputTokensOf } from '@hushbox/shared/affordability';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('reports one violation per reach, at its own line', () => {
    const project = projectWith({
      [WEB_FILE]:
        "import { inputTokensOf } from '@hushbox/shared';\n" +
        "import { smartSlotAvailability } from '@hushbox/shared/affordability';\n",
    });

    const violations = rule.check(project);

    expect(violations.map((violation) => violation.line)).toEqual([1, 2]);
  });
});

describe('the primitive tier', () => {
  it('passes a money primitive imported by any apps/web file', () => {
    const project = projectWith({
      [WEB_FILE]: "import { nanoUsdToDollarString } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });
});

describe('the closed allowlist', () => {
  const CLOSED_FILE = '/apps/web/src/components/chat/model-selector/model-info-panel.tsx';

  it('flags the machinery reach the dated allowlist used to hold', () => {
    const project = projectWith({
      [CLOSED_FILE]: "import { isExpensiveModelNano } from '@hushbox/shared';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('machinery');
  });

  it('flags any other machinery reach in that file too, the list exempting nothing', () => {
    const project = projectWith({
      [CLOSED_FILE]: "import { inputTokensOf } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });
});

describe('the guards against silence', () => {
  it('throws when apps/web imports the shared package and the harness cannot resolve it', () => {
    // Everything the other guards read is in place — the web tree, the money
    // module, the producers — and only the package mapping is gone, which is
    // the harness failure this guard is about rather than a project too empty
    // to check.
    const project = projectWith(
      { [WEB_FILE]: "import { inputTokensOf } from '@hushbox/shared';\n" },
      MONEY_MODULE,
      {}
    );

    expect(() => rule.check(project)).toThrow(/cannot resolve/i);
  });

  it('throws when the door resolves to a built file rather than into the money module', () => {
    const BUILT = '/packages/shared/dist/index.d.ts';
    const project = projectWith(
      { [WEB_FILE]: "import { inputTokensOf } from '@hushbox/shared';\n" },
      {
        ...MONEY_MODULE,
        [BUILT]:
          'export declare const TOTAL_FEE_RATE: number;\n' +
          'export declare function inputTokensOf(): number;\n',
      },
      { '@hushbox/shared': [BUILT], '@hushbox/shared/affordability': [BUILT] }
    );

    // The names all resolve, so nothing here is unresolvable and every symbol
    // is declared somewhere. What is gone is the money module: the machinery
    // reach on line 1 goes unreported and the wall reads clean. The anchor
    // name is what separates this guard's throw from the resolvability
    // guard's: only one of the two can name a symbol the door failed to
    // publish, and both call the rule blind.
    expect(() => rule.check(project)).toThrow(/TOTAL_FEE_RATE/);
  });

  it('throws when the door publishes no anchor, leaving nothing to prove it opens on money', () => {
    const money = {
      ...MONEY_MODULE,
      '/packages/shared/src/affordability/constants.ts':
        'export function inputTokensOf(): number {\n  return 4;\n}\n',
    };
    const project = projectWith(
      { [WEB_FILE]: "import { inputTokensOf } from '@hushbox/shared';\n" },
      money
    );

    expect(() => rule.check(project)).toThrow(/TOTAL_FEE_RATE/);
  });

  it('passes a shared subpath that is not a money door and publishes no money symbol', () => {
    const ROUTES = '/packages/shared/src/routes.ts';
    const project = projectWith(
      {
        [WEB_FILE]:
          "import { CHAT_ROUTE } from '@hushbox/shared/routes';\nexport const r = CHAT_ROUTE;\n",
      },
      { ...MONEY_MODULE, [ROUTES]: "export const CHAT_ROUTE = '/chat';\n" },
      { ...SOURCE_DOORS, '@hushbox/shared/routes': [ROUTES] }
    );

    expect(rule.check(project)).toEqual([]);
  });

  it('throws when a designated publisher no longer exists in the web tree', () => {
    const stale = 'apps/web/src/hooks/billing/use-media-cost-estimate.ts';
    const project = projectWith(
      { [WEB_FILE]: "import { nanoUsdToDollarString } from '@hushbox/shared';\n" },
      MONEY_MODULE,
      SOURCE_DOORS,
      Object.fromEntries(Object.entries(WEB_TREE).filter(([filePath]) => filePath !== `/${stale}`))
    );

    expect(() => rule.check(project)).toThrow(stale);
  });

  it('throws when the watched root matches no scanned file, though the tree it names is there', () => {
    // The root resolves perfectly: files live under it and the harness reads
    // them. What is empty is the SCOPE — every file under the root is excluded
    // as a test — so the wall reports a clean repository having looked at
    // nothing. An existence check on the directory passes this project.
    const project = projectWith(
      { '/apps/web/src/components/chat/pricing-panel.test.tsx': 'export {};\n' },
      MONEY_MODULE,
      SOURCE_DOORS,
      {}
    );

    // A fixture with no scanned file has no publisher file either, so the
    // sibling guard fires on this same project and its message names the root
    // too. Matching the root would pass on either throw and prove nothing about
    // this one; the phrase and the negative below are what separate them.
    expect(() => rule.check(project)).toThrow(/empty scope/);
    expect(() => rule.check(project)).not.toThrow(/designated publisher/);
  });

  it('throws when a web file opens a money door the doors set does not watch', () => {
    const project = projectWith(
      {
        [WEB_FILE]: "import { inputTokensOf } from '@hushbox/shared/affordability/constants';\n",
      },
      MONEY_MODULE,
      { ...SOURCE_DOORS, '@hushbox/shared/affordability/constants': [DEEP_MODULE] }
    );

    expect(() => rule.check(project)).toThrow(/MONEY_DOORS/);
  });

  it('throws when a declared producer no longer exists in the module it names', () => {
    const money = {
      ...MONEY_MODULE,
      '/packages/shared/src/affordability/turn/turn-options.ts':
        'export function getTurnOptions(): number {\n  return 1;\n}\n',
    };
    const project = projectWith(
      { [WEB_FILE]: "import { nanoUsdToDollarString } from '@hushbox/shared';\n" },
      money
    );

    expect(() => rule.check(project)).toThrow(/getMediaTurnOptions/);
  });
});

describe('the closure clauses', () => {
  it('flags a namespace import of the shared package, which names no symbol to tier', () => {
    const project = projectWith({
      [WEB_FILE]: "import * as shared from '@hushbox/shared';\nexport const s = shared;\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('whole-module handle');
  });

  it('flags a default import of the shared package', () => {
    const project = projectWith({
      [WEB_FILE]: "import shared from '@hushbox/shared';\nexport const s = shared;\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a dynamic import of the shared package, the same handle by another spelling', () => {
    const project = projectWith({
      [WEB_FILE]: "export const load = () => import('@hushbox/shared');\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags a re-export from the shared package, whose consumers resolve to nothing', () => {
    const project = projectWith({
      [WEB_FILE]: "export { nanoUsdToDollarString } from '@hushbox/shared';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('launders');
  });

  it('flags a star re-export from the shared package', () => {
    const project = projectWith({
      [WEB_FILE]: "export * from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toHaveLength(1);
  });

  it('flags the re-export and the machinery reach separately on one line', () => {
    const project = projectWith({
      [WEB_FILE]: "export { inputTokensOf } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toHaveLength(2);
  });

  it('passes a type-only re-export, which launders no verdict', () => {
    const project = projectWith({
      [WEB_FILE]: "export type { NanoUSD } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a namespace import of a package this wall does not watch', () => {
    const project = projectWith({
      [WEB_FILE]: "import * as react from 'react';\nexport const r = react;\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes an export list that names no module, which re-exports nothing', () => {
    const project = projectWith({
      [WEB_FILE]: 'const local = 1;\nexport { local };\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a re-export whose every specifier is type-only', () => {
    const project = projectWith({
      [WEB_FILE]: "export { type NanoUSD } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a call whose argument is not a literal specifier', () => {
    const project = projectWith({
      [WEB_FILE]: 'declare const name: string;\nexport const load = () => import(name);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a re-export of even a PRIMITIVE, now that no file is exempted', () => {
    const project = projectWith({
      '/apps/web/src/lib/format.ts': "export { nanoUsdToDollarString } from '@hushbox/shared';\n",
    });

    // The re-export is the offence whatever tier the symbol is: a consumer
    // reaching the result through `@/…` resolves to this file, so every tier
    // judgement in the rule stops one hop short.
    expect(rule.check(project)).toHaveLength(1);
  });
});

describe('the exemptions', () => {
  it('passes a type-only import declaration of a machinery symbol', () => {
    const project = projectWith({
      [WEB_FILE]: "import type { NanoUSD } from '@hushbox/shared';\nexport type T = NanoUSD;\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes a type-only specifier inside a value import declaration', () => {
    const project = projectWith({
      [WEB_FILE]:
        "import { type NanoUSD, nanoUsdToDollarString } from '@hushbox/shared';\n" +
        'export const show = (v: NanoUSD): string => nanoUsdToDollarString(v);\n',
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes an apps/web test file that drives machinery directly', () => {
    const project = projectWith({
      '/apps/web/src/components/chat/pricing-panel.test.tsx':
        "import { inputTokensOf } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('passes an import that resolves outside the money module', () => {
    const project = projectWith({
      '/apps/web/src/lib/theme.ts': 'export const theme = "dark";\n',
      [WEB_FILE]: "import { theme } from '../../lib/theme.js';\nexport const t = theme;\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('ignores apps/api, which this wall does not stand over', () => {
    const project = projectWith({
      '/apps/api/src/slices/chat/domain/runtime.ts':
        "import { inputTokensOf } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });
});

describe('the producer tier', () => {
  it('passes a producer imported by its designated publisher', () => {
    const project = projectWith({
      [PUBLISHER]: "import { getTurnOptions } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a producer imported by a web file that is not its publisher', () => {
    const project = projectWith({
      [WEB_FILE]: "import { getTurnOptions } from '@hushbox/shared';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('use-turn-options.ts');
  });

  it('flags a producer that has no designated publisher, rather than defaulting one', () => {
    const project = projectWith({
      [PUBLISHER]: "import { minTurnCostNanoUsd } from '@hushbox/shared';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('no apps/web publisher');
  });

  it('passes a producer imported by the server stand-in its entry names', () => {
    const project = projectWith({
      [SERVER_STAND_IN]: "import { getUserTier } from '@hushbox/shared';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags a producer with a stand-in imported by a file that is neither it nor the publisher', () => {
    const project = projectWith({
      [WEB_FILE]: "import { getUserTier } from '@hushbox/shared';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('use-user-tier-info.ts');
  });

  it('passes the price display producer imported by its designated publisher', () => {
    const project = projectWith({
      [DISPLAY_PUBLISHER]: "import { modelPriceDisplay } from '@hushbox/shared/affordability';\n",
    });

    expect(rule.check(project)).toEqual([]);
  });

  it('flags the price display producer imported by a web file that is not its publisher', () => {
    const project = projectWith({
      [WEB_FILE]: "import { modelPriceDisplay } from '@hushbox/shared/affordability';\n",
    });

    const violations = rule.check(project);

    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain('model-info-facts.ts');
  });

  it('passes the price core’s display type imported type-only by any web file', () => {
    const project = projectWith({
      [WEB_FILE]:
        "import type { ModelPriceDisplay } from '@hushbox/shared/affordability';\n" +
        'export type Shown = ModelPriceDisplay;\n',
    });

    expect(rule.check(project)).toEqual([]);
  });
});
