import path from 'node:path';
import { Project } from 'ts-morph';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../lib/source-scope.js';
import rule, {
  PRICE_HOME,
  PRICING_FIXTURE,
  QUANTITIES_MODULE,
  RETIRED_NAMES,
  SCHEDULE_MODULE,
  WIRE_MODULE,
} from './prices-resolve-in-one-place.rule.js';
import type { ArchViolation } from '../types.js';

const PRICE_CORE = 'packages/shared/src/affordability/price/';

/** The schedule module as it declares the price types, the brand and the one resolver. */
const SCHEDULE_SOURCE = `
declare const brand: unique symbol;
export type NanoUSD = bigint;
export interface TokenRates {
  readonly input: NanoUSD;
  readonly output: NanoUSD;
}
export interface PriceTier {
  readonly abovePromptTokens: number;
  readonly rates: TokenRates;
}
export interface TokenPriceSchedule {
  readonly base: TokenRates;
  readonly tiers: readonly PriceTier[];
}
type PricingShapes =
  | { readonly kind: 'tokens'; readonly anchor: TokenPriceSchedule; readonly anchorContextTokens: number }
  | { readonly kind: 'perImage'; readonly anchor: NanoUSD; readonly dearest: NanoUSD };
export type ModelPricing = PricingShapes & { readonly [brand]: 'ModelPricing' };
export type TokenPricing = Extract<ModelPricing, { kind: 'tokens' }>;
export type MediaPricing = Exclude<ModelPricing, TokenPricing>;
declare const z: { object(shape: object): { brand<T extends string>(): { parse(value: unknown): ModelPricing } } };
export const ModelPricingSchema = z.object({}).brand<'ModelPricing'>();
export function resolveTier(schedule: TokenPriceSchedule, promptTokens: number): TokenRates {
  let rates = schedule.base;
  for (const tier of schedule.tiers) {
    if (promptTokens > tier.abovePromptTokens) rates = tier.rates;
  }
  return rates;
}
export function ceilingOf(schedule: TokenPriceSchedule): TokenPriceSchedule {
  return { base: { input: schedule.base.input, output: schedule.base.output }, tiers: [] };
}
`;

/** A spread-built price and a guard, as the schedule module may write them. */
const SCHEDULE_MINTS = `
export function isTokenPricing(pricing: ModelPricing): pricing is TokenPricing {
  return pricing.kind === 'tokens';
}
export function withContext(pricing: TokenPricing, tokens: number): TokenPricing {
  return { ...pricing, anchorContextTokens: tokens };
}
`;

/** The quantities module as it declares the two ratios and the conversion that reads them. */
const QUANTITIES_SOURCE = `
export const INPUT_CHARS_PER_TOKEN = 3;
export const STORED_CHARS_PER_OUTPUT_TOKEN = 5;
export function inputTokensOf(chars: number): number {
  return Math.ceil(chars / INPUT_CHARS_PER_TOKEN);
}
export function storedChars(tokens: number): number {
  return tokens * STORED_CHARS_PER_OUTPUT_TOKEN;
}
`;

/**
 * The served pricing schema as a stand-in builder infers it: each key's type is
 * the shape's own property, which is what the real schema's inferred type
 * resolves to as well.
 */
const WIRE_SOURCE = `
declare function object<T>(shape: T): { readonly _output: T };
declare function text(): string | undefined;
export const wireLongContextRateSchema = object({
  abovePromptTokens: 0,
  inputPerToken: '',
  outputPerToken: '',
});
declare const computedKey: 'computed';
export const wireModelPricingSchema = object({
  [computedKey]: text(),
  inputPerToken: text(),
  outputPerToken: text(),
  perImage: text(),
  perSecondByResolution: {} as Record<string, string> | undefined,
  longContextRates: [] as (typeof wireLongContextRateSchema._output)[] | undefined,
});
export type WireModelPricing = typeof wireModelPricingSchema._output;
export type WireLongContextRate = typeof wireLongContextRateSchema._output;
export const otherSchema = object({ inputPerToken: '' });
export type Other = typeof otherSchema._output;
export const modelSchema = object({
  id: '',
  pricing: wireModelPricingSchema._output,
  minPricing: wireModelPricingSchema._output as WireModelPricing | undefined,
  maxPricing: wireModelPricingSchema._output as WireModelPricing | undefined,
});
export type Model = typeof modelSchema._output;
`;

const CURVE = `${PRICE_CORE}curve.ts`;
const PRICE_SCHEDULE = 'apps/api/src/slices/models/domain/catalog/price-schedule.ts';
const BILLING_MONEY = 'apps/api/src/slices/billing/domain/money.ts';
const NORMALIZE = 'apps/api/src/slices/models/domain/catalog/normalize.ts';
const CONSUMER = 'apps/api/src/slices/chat/domain/turn/consumer.ts';
const WEB_CONSUMER = 'apps/web/src/lib/chat/price-label.ts';

/** An import of `names` from the repo-relative `module`, spelled relative to `file`. */
function importFrom(file: string, module: string, names: string, typeOnly = false): string {
  const relative = path.posix.relative(path.posix.dirname(file), module);
  const specifier = relative.startsWith('.') ? relative : `./${relative}`;
  return `import ${typeOnly ? 'type ' : ''}{ ${names} } from '${specifier}';\n`;
}

/** The price types a file reads or builds, imported the way a source file writes it. */
function priceTypes(file: string): string {
  return importFrom(
    file,
    SCHEDULE_MODULE,
    'MediaPricing, ModelPricing, PriceTier, TokenPriceSchedule, TokenPricing, TokenRates',
    true
  );
}

/** A file at `file` that imports the price types and then runs `body`. */
function withTypes(file: string, body: string): Readonly<Record<string, string>> {
  return { [file]: `${priceTypes(file)}${body}` };
}

/** A file at `file` that imports the served row types and then runs `body`. */
function withWire(file: string, body: string): Readonly<Record<string, string>> {
  return {
    [file]: `${importFrom(file, WIRE_MODULE, 'Model, Other, WireLongContextRate, WireModelPricing', true)}${body}`,
  };
}

/** Every shape the home and its consumers legitimately carry. */
const CURVE_SOURCE = `${importFrom(CURVE, SCHEDULE_MODULE, 'resolveTier')}${priceTypes(CURVE)}
export function rateAt(pricing: TokenPricing, prompt: number): TokenRates {
  const { input, output } = resolveTier(pricing.anchor, prompt);
  return { input, output };
}
`;

const PRICE_SCHEDULE_SOURCE = `${priceTypes(PRICE_SCHEDULE)}
export function baked(rates: TokenRates): TokenRates {
  return { input: rates.input + 1n, output: rates['output'] + 1n };
}
`;

const BILLING_MONEY_SOURCE = `${priceTypes(BILLING_MONEY)}
export function sum({ input, output }: TokenRates): bigint {
  return input + output;
}
`;

const PRICING_FIXTURE_SOURCE = `${importFrom(PRICING_FIXTURE, SCHEDULE_MODULE, 'ModelPricingSchema')}${priceTypes(PRICING_FIXTURE)}
export function tokenPricingFixture(): ModelPricing {
  return ModelPricingSchema.parse({});
}
`;

/** A spread-built price and a guard, as the pricing fixture module writes them. */
const FIXTURE_MINTS = `
export function withContext(context: number): TokenPricing {
  const parsed = ModelPricingSchema.parse({}) as TokenPricing;
  return { ...parsed, anchorContextTokens: context };
}
export function isTokens(pricing: ModelPricing): pricing is TokenPricing {
  return pricing.kind === 'tokens';
}
`;

const CONSUMER_SOURCE = `${importFrom(CONSUMER, QUANTITIES_MODULE, 'inputTokensOf')}${importFrom(CONSUMER, CURVE, 'rateAt')}${priceTypes(CONSUMER)}
interface LocalPair {
  readonly input: bigint;
  readonly output: bigint;
}
export function charge(pricing: ModelPricing, chars: number): bigint {
  if (pricing.kind !== 'tokens') return 0n;
  const { kind } = pricing;
  const rates = rateAt(pricing, inputTokensOf(chars));
  return kind === 'tokens' ? BigInt(String(rates)) : 0n;
}
const pair: LocalPair = { input: 1n, output: 2n };
export const total = pair.input + pair.output;
const { input: first, ...others } = pair;
export const rest = [first, others, { a: 1 }['a']];
`;

const WEB_CONSUMER_SOURCE = `import type { Model } from '@hushbox/shared';
declare function displayOf(pricing: unknown): string;
interface Unrelated {
  readonly inputPerToken: string;
  readonly input: string;
}
export function label(model: Model, other: Unrelated): string {
  return displayOf(model.pricing) + other.inputPerToken + other.input;
}
`;

const BASELINE: Readonly<Record<string, string>> = {
  [SCHEDULE_MODULE]: SCHEDULE_SOURCE,
  [QUANTITIES_MODULE]: QUANTITIES_SOURCE,
  [WIRE_MODULE]: WIRE_SOURCE,
  [CURVE]: CURVE_SOURCE,
  [PRICE_SCHEDULE]: PRICE_SCHEDULE_SOURCE,
  [BILLING_MONEY]: BILLING_MONEY_SOURCE,
  [NORMALIZE]: `${priceTypes(NORMALIZE)}export const baked = (r: TokenRates): bigint => r.input;\n`,
  [PRICING_FIXTURE]: PRICING_FIXTURE_SOURCE,
  [CONSUMER]: CONSUMER_SOURCE,
  [WEB_CONSUMER]: WEB_CONSUMER_SOURCE,
  'scripts/price-free.ts': 'export const scripted = 1;\n',
  'e2e/price-free.ts': 'export const driven = 1;\n',
};

/**
 * Every fixture writes a real path under the repo root, where the rule's scope
 * is anchored. The web alias is configured, so the rule reads web files off
 * this project rather than building the web package's own program.
 */
function projectWith(files: Readonly<Record<string, string>>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      paths: {
        '@/*': [path.join(REPO_ROOT, 'apps/web/src/*')],
        '@hushbox/shared': [path.join(REPO_ROOT, WIRE_MODULE)],
      },
    },
  });
  for (const [relative, source] of Object.entries(files)) {
    project.createSourceFile(path.join(REPO_ROOT, relative), source);
  }
  return project;
}

function check(extra: Readonly<Record<string, string>> = {}): ArchViolation[] {
  return rule.check(projectWith({ ...BASELINE, ...extra }));
}

/** The violations reported in the repo-relative `file`. */
function violationsIn(violations: readonly ArchViolation[], file: string): ArchViolation[] {
  return violations.filter((violation) => violation.file.endsWith(file));
}

const ELSEWHERE = 'apps/api/src/slices/chat/domain/turn/elsewhere.ts';
const ELSEWHERE_TEST = 'apps/api/src/slices/chat/domain/turn/elsewhere.test.ts';
const WEB_FILE = 'apps/web/src/lib/chat/price-read.ts';
const MARKETING_FILE = 'apps/marketing/src/lib/price-read.ts';

describe('prices-resolve-in-one-place', () => {
  it('passes the shapes the home and its consumers carry', () => {
    expect(check()).toEqual([]);
  });

  describe('the reads clause', () => {
    it('flags a property read of a TokenRates field outside the home', () => {
      const violations = check(
        withTypes(ELSEWHERE, 'export const f = (r: TokenRates): bigint => r.input;\n')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.file).toContain(ELSEWHERE);
      expect(violations[0]?.message).toContain("reads 'input'");
    });

    it('flags an element read of a TokenRates field', () => {
      const violations = check(
        withTypes(ELSEWHERE, "export const f = (r: TokenRates): bigint => r['output'];\n")
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("reads 'output'");
    });

    it('flags an element read keyed by a template literal', () => {
      const violations = check(
        withTypes(ELSEWHERE, 'export const f = (r: TokenRates): bigint => r[`input`];\n')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("reads 'input'");
    });

    it('flags a TokenRates field destructured from a union holding it', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare const r: TokenRates | { readonly other: number };\nexport const { input } = r as TokenRates;\nexport const { output } = r;\n'
        )
      );
      expect(violations.map((violation) => violation.message)).toEqual([
        expect.stringContaining("reads 'input'"),
        expect.stringContaining("reads 'output'"),
      ]);
    });

    it('reports a line once however often it reads the same field', () => {
      const violations = check(
        withTypes(ELSEWHERE, 'export const f = (r: TokenRates): bigint => r.input + r.input;\n')
      );
      expect(violations).toHaveLength(1);
    });

    it('flags a destructured TokenRates field', () => {
      const violations = check(
        withTypes(ELSEWHERE, 'declare const r: TokenRates;\nexport const { input } = r;\n')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("reads 'input'");
    });

    it('flags a TokenRates field destructured in a parameter', () => {
      const violations = check(
        withTypes(ELSEWHERE, 'export const f = ({ output: o }: TokenRates): bigint => o;\n')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("reads 'output'");
    });

    it('flags a read of a PriceTier field', () => {
      const violations = check(
        withTypes(ELSEWHERE, 'export const f = (t: PriceTier): number => t.abovePromptTokens;\n')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("reads 'abovePromptTokens'");
    });

    it('flags a read of a TokenPriceSchedule field', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'export const f = (s: TokenPriceSchedule): readonly PriceTier[] => s.tiers;\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("reads 'tiers'");
    });

    it('flags a read of a ModelPricing member field', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'export const f = (p: TokenPricing): TokenPriceSchedule => p.anchor;\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("reads 'anchor'");
    });

    it('flags a read of a media price member field', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          "export const f = (p: MediaPricing): bigint => (p.kind === 'perImage' ? p.dearest : 0n);\n"
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("reads 'dearest'");
    });

    it("passes a read of the price's kind, which names a variant and no rate", () => {
      expect(
        check(
          withTypes(
            ELSEWHERE,
            "export const f = (p: ModelPricing): boolean => p.kind === 'tokens';\n"
          )
        )
      ).toEqual([]);
    });

    it('passes a same-named field of a type the price module does not declare', () => {
      expect(
        check({
          [ELSEWHERE]:
            'interface Pair { readonly input: bigint }\nexport const f = (p: Pair): bigint => p.input;\n',
        })
      ).toEqual([]);
    });

    it('passes a field of a same-named rate type declared outside the schedule module', () => {
      expect(
        check({
          [ELSEWHERE]:
            'interface TokenRates { readonly input: bigint }\nexport const f = (r: TokenRates): bigint => r.input;\n',
        })
      ).toEqual([]);
    });

    it('passes a rate read in a test file', () => {
      expect(
        check(withTypes(ELSEWHERE_TEST, 'export const f = (r: TokenRates): bigint => r.input;\n'))
      ).toEqual([]);
    });

    it('passes a rate read anywhere under the price core', () => {
      expect(
        check(
          withTypes(
            `${PRICE_CORE}other.ts`,
            'export const f = (r: TokenRates): bigint => r.input;\n'
          )
        )
      ).toEqual([]);
    });

    it("passes a rate read in the catalog's price-schedule module", () => {
      expect(
        check(withTypes(PRICE_SCHEDULE, 'export const f = (r: TokenRates): bigint => r.input;\n'))
      ).toEqual([]);
    });

    it("passes a rate read in the catalog's normalize module", () => {
      expect(
        check(withTypes(NORMALIZE, 'export const f = (r: TokenRates): bigint => r.output;\n'))
      ).toEqual([]);
    });

    it("passes a rate read in billing's money module", () => {
      expect(
        check(withTypes(BILLING_MONEY, 'export const f = (r: TokenRates): bigint => r.input;\n'))
      ).toEqual([]);
    });
  });

  describe('the construction clause', () => {
    it('flags an object literal typed as TokenRates outside the home', () => {
      const violations = check(
        withTypes(ELSEWHERE, 'export const r: TokenRates = { input: 1n, output: 2n };\n')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('TokenRates');
    });

    it('flags an object literal typed as a PriceTier', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare const r: TokenRates;\nexport const t: PriceTier = { abovePromptTokens: 1, rates: r };\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('PriceTier');
    });

    it('flags an object literal typed as a TokenPriceSchedule', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare const r: TokenRates;\nexport const s: TokenPriceSchedule = { base: r, tiers: [] };\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('TokenPriceSchedule');
    });

    it('flags a rate object passed where a union holding TokenRates is expected', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare function take(r: TokenRates | string): void;\ntake({ input: 1n, output: 2n });\n'
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('passes a rate object built in a test file', () => {
      expect(
        check(
          withTypes(ELSEWHERE_TEST, 'export const r: TokenRates = { input: 1n, output: 2n };\n')
        )
      ).toEqual([]);
    });

    it('passes a rate object spread in a test file', () => {
      expect(
        check(
          withTypes(
            ELSEWHERE_TEST,
            'declare const r: TokenRates;\nexport const copy: TokenRates = { ...r };\n'
          )
        )
      ).toEqual([]);
    });

    it('flags a rate object spread outside the home', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare const r: TokenRates;\nexport const copy = { ...{ a: 1 }, ...r };\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('builds a TokenRates');
    });

    it('passes a rate object built under the price core', () => {
      expect(
        check(
          withTypes(
            `${PRICE_CORE}other.ts`,
            'export const r: TokenRates = { input: 1n, output: 2n };\n'
          )
        )
      ).toEqual([]);
    });
  });

  describe('the ModelPricing mint clause', () => {
    const SPREAD =
      'export const f = (p: TokenPricing): TokenPricing => ({ ...p, anchorContextTokens: 1 });\n';

    it('flags a spread-built ModelPricing in a production file', () => {
      const violations = check(withTypes(ELSEWHERE, SPREAD));
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('ModelPricing');
    });

    it('flags a spread-built ModelPricing in a test file', () => {
      const violations = check(withTypes(ELSEWHERE_TEST, SPREAD));
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('ModelPricing');
    });

    it('flags a spread-built ModelPricing under the price core outside the schedule module', () => {
      const violations = check(withTypes(`${PRICE_CORE}wire.ts`, SPREAD));
      expect(violations).toHaveLength(1);
    });

    it('flags a spread of a price that nothing types', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare const p: TokenPricing;\nconst copy = { ...p, anchorContextTokens: 1 };\nexport const n = copy;\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('ModelPricing');
    });

    it('flags a production literal on the line a @ts-expect-error directive governs', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          '// @ts-expect-error a field-by-field literal carries no brand\n' +
            "export const q: ModelPricing = { kind: 'perImage', anchor: 1n, dearest: 1n };\n"
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('builds a ModelPricing');
    });

    it('passes a literal on the line a @ts-expect-error directive governs in a test file', () => {
      expect(
        check(
          withTypes(
            ELSEWHERE_TEST,
            '// @ts-expect-error a field-by-field literal carries no brand\n' +
              "export const q: ModelPricing = { kind: 'perImage', anchor: 1n, dearest: 1n };\n"
          )
        )
      ).toEqual([]);
    });

    it('passes a literal under a block @ts-expect-error directive in a test file', () => {
      expect(
        check(
          withTypes(
            ELSEWHERE_TEST,
            '  /* @ts-expect-error a field-by-field literal carries no brand */\n' +
              "export const q: ModelPricing = { kind: 'perImage', anchor: 1n, dearest: 1n };\n"
          )
        )
      ).toEqual([]);
    });

    it('flags a literal a @ts-expect-error directive does not govern', () => {
      const violations = check(
        withTypes(
          ELSEWHERE_TEST,
          '// @ts-expect-error governs the next line only\nexport const unrelated = 1;\n' +
            "export const q = { kind: 'perImage', anchor: 1n, dearest: 1n } as ModelPricing;\n"
        )
      );
      expect(violationsIn(violations, ELSEWHERE_TEST)).toHaveLength(1);
    });

    it('flags a literal under a @ts-ignore directive', () => {
      const violations = check(
        withTypes(
          ELSEWHERE_TEST,
          '// @ts-ignore a suppression, not a proof\n' +
            "export const q: ModelPricing = { kind: 'perImage', anchor: 1n, dearest: 1n };\n"
        )
      );
      expect(violationsIn(violations, ELSEWHERE_TEST)).toHaveLength(1);
    });

    it('flags a literal under a line that mentions @ts-expect-error outside a directive', () => {
      const violations = check(
        withTypes(
          ELSEWHERE_TEST,
          "export const note = '// @ts-expect-error';\n" +
            "export const q = { kind: 'perImage', anchor: 1n, dearest: 1n } as ModelPricing;\n"
        )
      );
      expect(violationsIn(violations, ELSEWHERE_TEST)).toHaveLength(1);
    });

    it('flags a ModelPricing literal written field by field', () => {
      const violations = check(
        withTypes(
          ELSEWHERE_TEST,
          "export const q = { kind: 'perImage', anchor: 1n, dearest: 1n } as ModelPricing;\n"
        )
      );
      expect(violationsIn(violations, ELSEWHERE_TEST)).toHaveLength(1);
    });

    it('passes a spread-built ModelPricing and a guard in the pricing fixture module', () => {
      expect(check({ [PRICING_FIXTURE]: `${PRICING_FIXTURE_SOURCE}${FIXTURE_MINTS}` })).toEqual([]);
    });

    it('passes a spread-built ModelPricing and a guard in the schedule module', () => {
      expect(check({ [SCHEDULE_MODULE]: `${SCHEDULE_SOURCE}${SCHEDULE_MINTS}` })).toEqual([]);
    });

    it('flags the same spread and guard in a production file beside the schedule module', () => {
      const violations = check(
        withTypes(
          `${PRICE_CORE}other.ts`,
          FIXTURE_MINTS.replace(
            'ModelPricingSchema.parse({}) as TokenPricing',
            '{} as TokenPricing'
          )
        )
      );
      expect(violations).toHaveLength(2);
    });

    it("flags a zod schema branded 'ModelPricing' outside the schedule module", () => {
      const violations = check({
        [ELSEWHERE]:
          'declare const z: { object(s: object): { brand<T extends string>(): unknown } };\n' +
          "export const Again = z.object({}).brand<'ModelPricing'>();\n",
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("brand<'ModelPricing'>");
    });

    it("passes another method given a 'ModelPricing' type argument", () => {
      expect(
        check({
          [ELSEWHERE]:
            'declare const z: { object(s: object): { label<T extends string>(): unknown } };\n' +
            "export const brandLabelled = z.object({}).label<'ModelPricing'>();\n",
        })
      ).toEqual([]);
    });

    it('passes a zod schema branded with another name', () => {
      expect(
        check({
          [ELSEWHERE]:
            'declare const z: { object(s: object): { brand<T extends string>(): unknown } };\n' +
            "export const Other = z.object({}).brand<'NanoUSD'>();\n" +
            'export const Bare = z.object({}).brand();\n',
        })
      ).toEqual([]);
    });

    it('flags Object.assign producing a ModelPricing', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare const p: TokenPricing;\nexport const copy = Object.assign({}, p);\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('Object.assign');
    });

    it('passes an assign on another receiver producing a ModelPricing', () => {
      expect(
        check(
          withTypes(
            ELSEWHERE,
            'declare const lib: { assign<T>(value: T): T };\ndeclare const p: TokenPricing;\nexport const copy = lib.assign(p);\nexport const merged = Object.assign({}, { a: 1 });\n'
          )
        )
      ).toEqual([]);
    });

    it('passes another Object method producing a ModelPricing', () => {
      expect(
        check(
          withTypes(
            ELSEWHERE,
            'declare const Object: { pick<T>(value: T): T; assign<T>(value: T): T };\ndeclare const p: TokenPricing;\nexport const copy = Object.pick(p);\nexport const same = Object.assign({ a: 1 });\n'
          )
        )
      ).toEqual([]);
    });

    it('passes Object.assign producing something else', () => {
      expect(check({ [ELSEWHERE]: 'export const copy = Object.assign({}, { a: 1 });\n' })).toEqual(
        []
      );
    });

    it('flags z.custom of a ModelPricing type', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare const z: { custom<T>(check?: (v: unknown) => boolean): T };\n' +
            'export const Custom = z.custom<TokenPricing>();\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('custom');
    });

    it('passes another call given a ModelPricing type argument', () => {
      expect(
        check(
          withTypes(
            ELSEWHERE,
            'declare const z: { other<T>(): T };\nexport const customLike = z.other<TokenPricing>();\n'
          )
        )
      ).toEqual([]);
    });

    it('flags a bare custom call of a ModelPricing type', () => {
      const violations = check(
        withTypes(
          ELSEWHERE,
          'declare function custom<T>(): T;\nexport const Custom = custom<ModelPricing>();\n'
        )
      );
      expect(violations).toHaveLength(1);
    });

    it('passes z.custom of another type', () => {
      expect(
        check({
          [ELSEWHERE]:
            'declare const z: { custom<T>(check?: (v: unknown) => boolean): T };\n' +
            'export const Custom = z.custom<string>();\n' +
            'export const Inferred = z.custom();\n',
        })
      ).toEqual([]);
    });

    it('flags a user-defined type guard narrowing to a ModelPricing type', () => {
      const violations = check(
        withTypes(
          ELSEWHERE_TEST,
          'export function isPrice(value: unknown): value is ModelPricing {\n  return value !== undefined;\n}\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('type guard');
    });

    it('passes a type guard narrowing to another type', () => {
      expect(
        check({
          [ELSEWHERE]:
            'export function isText(value: unknown): value is string {\n  return typeof value === "string";\n}\n',
        })
      ).toEqual([]);
    });
  });

  describe('the one-resolver clause', () => {
    it('flags a reference to resolveTier outside the price core', () => {
      const violations = check({
        [ELSEWHERE]: `${importFrom(ELSEWHERE, SCHEDULE_MODULE, 'resolveTier')}export const r = resolveTier;\n`,
      });
      expect(violations.length).toBeGreaterThan(0);
      expect(violations.every((violation) => violation.message.includes('resolveTier'))).toBe(true);
    });

    it('flags a reference to resolveTier in a test outside the price core', () => {
      const violations = check({
        [ELSEWHERE_TEST]: `${importFrom(ELSEWHERE_TEST, SCHEDULE_MODULE, 'resolveTier')}export const r = resolveTier;\n`,
      });
      expect(violationsIn(violations, ELSEWHERE_TEST).length).toBeGreaterThan(0);
    });

    it('flags a second function named resolveTier', () => {
      const violations = check({
        [ELSEWHERE]: 'export function resolveTier(): number {\n  return 0;\n}\n',
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('resolveTier');
    });

    it('passes a reference to resolveTier under the price core', () => {
      const other = `${PRICE_CORE}other.ts`;
      expect(
        check({
          [other]: `${importFrom(other, SCHEDULE_MODULE, 'resolveTier')}export const r = resolveTier;\n`,
        })
      ).toEqual([]);
    });
  });

  describe('the ratio clause', () => {
    it('flags a reference to INPUT_CHARS_PER_TOKEN outside the quantities module', () => {
      const violations = check({
        [ELSEWHERE]: `${importFrom(ELSEWHERE, QUANTITIES_MODULE, 'INPUT_CHARS_PER_TOKEN')}export const n = 10 / INPUT_CHARS_PER_TOKEN;\n`,
      });
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]?.message).toContain('INPUT_CHARS_PER_TOKEN');
    });

    it('flags a reference to STORED_CHARS_PER_OUTPUT_TOKEN outside the quantities module', () => {
      const other = `${PRICE_CORE}other.ts`;
      const violations = check({
        [other]: `${importFrom(other, QUANTITIES_MODULE, 'STORED_CHARS_PER_OUTPUT_TOKEN')}export const n = 10 * STORED_CHARS_PER_OUTPUT_TOKEN;\n`,
      });
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]?.message).toContain('STORED_CHARS_PER_OUTPUT_TOKEN');
    });

    it('passes a reference to a ratio in a test file', () => {
      expect(
        check({
          [ELSEWHERE_TEST]: `${importFrom(ELSEWHERE_TEST, QUANTITIES_MODULE, 'INPUT_CHARS_PER_TOKEN')}export const n = INPUT_CHARS_PER_TOKEN;\n`,
        })
      ).toEqual([]);
    });

    it.each([
      ['a constant', 'export const CHARS_PER_TOKEN = 4;\n', 'CHARS_PER_TOKEN'],
      ['a singular camel-case constant', 'export const charPerToken = 4;\n', 'charPerToken'],
      [
        'an output ratio',
        'export const OUTPUT_CHARS_PER_OUTPUT_TOKEN = 2;\n',
        'OUTPUT_CHARS_PER_OUTPUT_TOKEN',
      ],
      [
        'a function',
        'export function charsPerToken(): number {\n  return 4;\n}\n',
        'charsPerToken',
      ],
      ['an object key', 'export const ratios = { chars_per_token: 4 };\n', 'chars_per_token'],
      [
        'an interface field',
        'export interface Ratios {\n  readonly charsPerOutputToken: number;\n}\n',
        'charsPerOutputToken',
      ],
      [
        'a parameter',
        'export const f = (charsPerToken: number): number => charsPerToken;\n',
        'charsPerToken',
      ],
      ['a class', 'export class CharsPerToken {}\n', 'CharsPerToken'],
      [
        'an interface',
        'export interface CharsPerToken {\n  readonly n: number;\n}\n',
        'CharsPerToken',
      ],
      ['a type alias', 'export type CharsPerToken = number;\n', 'CharsPerToken'],
      ['an enum', 'export enum CharsPerToken {\n  Dense = 2,\n}\n', 'CharsPerToken'],
      ['an enum member', 'export enum Ratios {\n  CharsPerToken = 4,\n}\n', 'CharsPerToken'],
      [
        'a shorthand key',
        "import { charsPerToken } from './ratios';\nexport const r = { charsPerToken };\n",
        'charsPerToken',
      ],
      ['a class field', 'export class R {\n  charsPerToken = 4;\n}\n', 'charsPerToken'],
      [
        'a private class field',
        'export class R {\n  #charsPerToken = 4;\n  n(): number {\n    return this.#charsPerToken;\n  }\n}\n',
        'charsPerToken',
      ],
      [
        'a method',
        'export class R {\n  charsPerToken(): number {\n    return 4;\n  }\n}\n',
        'charsPerToken',
      ],
      [
        'a method signature',
        'export interface R {\n  charsPerToken(): number;\n}\n',
        'charsPerToken',
      ],
      [
        'a getter',
        'export class R {\n  get charsPerToken(): number {\n    return 4;\n  }\n}\n',
        'charsPerToken',
      ],
      [
        'a setter',
        'export class R {\n  set charsPerToken(value: number) {\n    void value;\n  }\n}\n',
        'charsPerToken',
      ],
      [
        'a destructured binding',
        'declare const r: { n: number };\nexport const { n: charsPerToken } = r;\n',
        'charsPerToken',
      ],
    ])('flags %s declaring a characters-per-token ratio', (_shape, source, name) => {
      const violations = check({ [ELSEWHERE]: source });
      expect(violations.length).toBeGreaterThan(0);
      expect(violations[0]?.message).toContain(name);
    });

    it('flags a third ratio declared inside the quantities module', () => {
      const violations = check({
        [QUANTITIES_MODULE]: `${QUANTITIES_SOURCE}export const CHARS_PER_TOKEN_DENSE = 2;\n`,
      });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain('CHARS_PER_TOKEN_DENSE');
    });

    it('flags a constant named like a ratio declared outside the quantities module', () => {
      const violations = check({ [ELSEWHERE]: 'export const INPUT_CHARS_PER_TOKEN = 4;\n' });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("declares 'INPUT_CHARS_PER_TOKEN'");
    });

    it('flags a function named like a ratio inside the quantities module', () => {
      const violations = check({
        [QUANTITIES_MODULE]: `${QUANTITIES_SOURCE}export function STORED_CHARS_PER_OUTPUT_TOKEN_OF(): number {\n  return 5;\n}\n`,
      });
      expect(violations).toHaveLength(1);
    });

    it('passes a ratio declared in a test file', () => {
      expect(check({ [ELSEWHERE_TEST]: 'export const CHARS_PER_TOKEN = 3;\n' })).toEqual([]);
    });

    it('passes a ratio name that resolves to no declaration', () => {
      expect(check({ [ELSEWHERE]: 'export const n = INPUT_CHARS_PER_TOKEN;\n' })).toEqual([]);
    });

    it('passes a ratio name imported from somewhere that declares nothing', () => {
      expect(
        check({
          [ELSEWHERE]:
            "import { INPUT_CHARS_PER_TOKEN } from './nowhere';\nexport const n = INPUT_CHARS_PER_TOKEN;\n",
        })
      ).toEqual([]);
    });

    it('passes a name that only resembles a ratio', () => {
      expect(check({ [ELSEWHERE]: 'export const tokensPerChar = 1;\n' })).toEqual([]);
    });

    it.each([...RETIRED_NAMES])('flags the retired name %s in a test comment', (name) => {
      const violations = check({ [ELSEWHERE_TEST]: `// once called ${name}\nexport {};\n` });
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain(name);
    });

    it.each(['apps/api/src/old.ts', 'packages/shared/src/old.ts', 'scripts/old.ts', 'e2e/old.ts'])(
      'flags a retired name in %s',
      (file) => {
        const violations = check({ [file]: "export const s = 'estimateTokenCount';\n" });
        expect(violationsIn(violations, file)).toHaveLength(1);
      }
    );

    it.each(['scripts', 'e2e', 'apps', 'packages'])(
      'throws when no scanned file lives under %s/, where retired names are swept',
      (tree) => {
        const files = Object.fromEntries(
          Object.entries(BASELINE).filter(([file]) => !file.startsWith(`${tree}/`))
        );
        expect(() => rule.check(projectWith(files))).toThrow(
          `no scanned file lives under '${tree}/'`
        );
      }
    );

    it('passes a retired name outside the four trees', () => {
      expect(check({ 'ops/old.ts': "export const s = 'estimateTokenCount';\n" })).toEqual([]);
    });
  });

  describe('the served-wire clause', () => {
    it('flags a property read of a served rate in apps/web', () => {
      const violations = check(
        withWire(
          WEB_FILE,
          'export const f = (p: WireModelPricing): string | undefined => p.inputPerToken;\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("'inputPerToken'");
    });

    it('flags an element read of a served rate', () => {
      const violations = check(
        withWire(
          WEB_FILE,
          "export const f = (p: WireModelPricing): string | undefined => p['perImage'];\n"
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("'perImage'");
    });

    it('flags a destructured served rate', () => {
      const violations = check(
        withWire(
          WEB_FILE,
          'declare const p: WireModelPricing;\nexport const { outputPerToken } = p;\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("'outputPerToken'");
    });

    it('flags a read of a served long-context rate', () => {
      const violations = check(
        withWire(
          WEB_FILE,
          'export const f = (m: Model): number => m.pricing.longContextRates?.length ?? 0;\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("'longContextRates'");
    });

    it('flags a read off a served long-context rate', () => {
      const violations = check(
        withWire(
          WEB_FILE,
          'export const f = (r: WireLongContextRate): number => r.abovePromptTokens;\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("'abovePromptTokens'");
    });

    it('passes a same-named key of another schema in the served module', () => {
      expect(
        check(withWire(WEB_FILE, 'export const f = (o: Other): string => o.inputPerToken;\n'))
      ).toEqual([]);
    });

    it('flags a read of the served pool minimum', () => {
      const violations = check(
        withWire(WEB_FILE, 'export const f = (m: Model): unknown => m.minPricing;\n')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("'minPricing'");
    });

    it('flags a read of the served pool maximum', () => {
      const violations = check(
        withWire(WEB_FILE, 'export const f = (m: Model): unknown => m.maxPricing;\n')
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.message).toContain("'maxPricing'");
    });

    it('flags a served rate read in apps/marketing', () => {
      const violations = check(
        withWire(
          MARKETING_FILE,
          'export const f = (p: WireModelPricing): unknown => p.perSecondByResolution;\n'
        )
      );
      expect(violations).toHaveLength(1);
      expect(violations[0]?.file).toContain(MARKETING_FILE);
    });

    it('flags a served rate read through the web alias', () => {
      const violations = check({
        'apps/web/src/lib/chat/row.ts': `${importFrom('apps/web/src/lib/chat/row.ts', WIRE_MODULE, 'Model', true)}export declare const row: Model;\n`,
        [WEB_FILE]:
          "import { row } from '@/lib/chat/row';\nexport const rate = row.pricing.inputPerToken;\n",
      });
      expect(violationsIn(violations, WEB_FILE)).toHaveLength(1);
    });

    it('passes a served rate read in apps/api', () => {
      expect(
        check(
          withWire(
            ELSEWHERE,
            'export const f = (p: WireModelPricing): unknown => p.inputPerToken;\n'
          )
        )
      ).toEqual([]);
    });

    it('passes a served rate read in a web test file', () => {
      expect(
        check(
          withWire(
            'apps/web/src/lib/chat/price-read.test.ts',
            'export const f = (p: WireModelPricing): unknown => p.inputPerToken;\n'
          )
        )
      ).toEqual([]);
    });
  });

  describe('outside the four source trees', () => {
    it.each(['ops/price-read.ts', 'ads/price-read.ts'])('flags a rate read in %s', (file) => {
      const violations = check(
        withTypes(file, 'export const f = (r: TokenRates): bigint => r.input;\n')
      );
      expect(violationsIn(violations, file)).toHaveLength(1);
    });

    it('flags a rate object built in ads/', () => {
      const violations = check(
        withTypes('ads/rates.ts', 'export const r: TokenRates = { input: 1n, output: 2n };\n')
      );
      expect(violationsIn(violations, 'ads/rates.ts')).toHaveLength(1);
    });

    it('flags a spread-built ModelPricing in ops/', () => {
      const violations = check(
        withTypes(
          'ops/mint.ts',
          'export const f = (p: TokenPricing): TokenPricing => ({ ...p, anchorContextTokens: 1 });\n'
        )
      );
      expect(violationsIn(violations, 'ops/mint.ts')).toHaveLength(1);
    });

    it('flags a second resolveTier in ads/', () => {
      const violations = check({
        'ads/tier.ts': 'export function resolveTier(): number {\n  return 0;\n}\n',
      });
      expect(violationsIn(violations, 'ads/tier.ts')).toHaveLength(1);
    });

    it('flags a ratio declared in ops/', () => {
      const violations = check({ 'ops/ratio.ts': 'export const CHARS_PER_TOKEN = 4;\n' });
      expect(violationsIn(violations, 'ops/ratio.ts')).toHaveLength(1);
    });
  });

  describe('when the price home moves', () => {
    it.each([SCHEDULE_MODULE, QUANTITIES_MODULE, WIRE_MODULE, PRICING_FIXTURE])(
      'throws when %s names no file',
      (missing) => {
        const files = Object.fromEntries(
          Object.entries(BASELINE).filter(([file]) => file !== missing)
        );
        expect(() => rule.check(projectWith(files))).toThrow(missing);
      }
    );

    it.each(PRICE_HOME.filter((home) => home.endsWith('.ts')))(
      'throws when the home file %s names no file',
      (missing) => {
        const files = Object.fromEntries(
          Object.entries(BASELINE).filter(([file]) => file !== missing)
        );
        expect(() => rule.check(projectWith(files))).toThrow(missing);
      }
    );

    it.each([
      'TokenRates',
      'PriceTier',
      'TokenPriceSchedule',
      'ModelPricing',
      'PricingShapes',
      'resolveTier',
    ])('throws when the schedule module no longer declares %s', (name) => {
      const renamed = SCHEDULE_SOURCE.replaceAll(name, `${name}Renamed`);
      expect(() => check({ [SCHEDULE_MODULE]: renamed })).toThrow(name);
    });

    it.each(['INPUT_CHARS_PER_TOKEN', 'STORED_CHARS_PER_OUTPUT_TOKEN'])(
      'throws when the quantities module no longer declares %s',
      (name) => {
        const renamed = QUANTITIES_SOURCE.replaceAll(name, `${name}_RENAMED`);
        expect(() => check({ [QUANTITIES_MODULE]: renamed })).toThrow(name);
      }
    );

    it.each(['wireModelPricingSchema', 'wireLongContextRateSchema'])(
      'throws when the served schema module no longer declares %s',
      (name) => {
        const renamed = WIRE_SOURCE.replaceAll(name, `${name}Renamed`);
        expect(() => check({ [WIRE_MODULE]: renamed })).toThrow(name);
      }
    );

    it.each(['minPricing', 'maxPricing'])(
      'throws when the served schema module no longer declares the pool bound %s',
      (name) => {
        const renamed = WIRE_SOURCE.replaceAll(name, `${name}Renamed`);
        expect(() => check({ [WIRE_MODULE]: renamed })).toThrow(name);
      }
    );

    it('throws when a PricingShapes variant no longer carries the kind discriminant', () => {
      const renamed = SCHEDULE_SOURCE.replace(
        "readonly kind: 'perImage'",
        "readonly variant: 'perImage'"
      );
      expect(() => check({ [SCHEDULE_MODULE]: renamed })).toThrow("'kind'");
    });

    it('stands on a PricingShapes of a single variant carrying kind', () => {
      const single = SCHEDULE_SOURCE.replace(
        "\n  | { readonly kind: 'perImage'; readonly anchor: NanoUSD; readonly dearest: NanoUSD }",
        ''
      ).replace('type PricingShapes =\n  | {', 'type PricingShapes = {');
      expect(single).not.toContain("kind: 'perImage'");
      expect(() => check({ [SCHEDULE_MODULE]: single })).not.toThrow();
    });

    it('throws when a PricingShapes of a single variant does not carry kind', () => {
      const single = SCHEDULE_SOURCE.replace(
        "\n  | { readonly kind: 'perImage'; readonly anchor: NanoUSD; readonly dearest: NanoUSD }",
        ''
      )
        .replace('type PricingShapes =\n  | {', 'type PricingShapes = {')
        .replace("readonly kind: 'tokens'", "readonly variant: 'tokens'");
      expect(() => check({ [SCHEDULE_MODULE]: single })).toThrow("'kind'");
    });

    it('throws when a PricingShapes variant is not a literal that declares kind', () => {
      const referenced = SCHEDULE_SOURCE.replace(
        "| { readonly kind: 'perImage'; readonly anchor: NanoUSD; readonly dearest: NanoUSD }",
        '| TokenRates'
      );
      expect(() => check({ [SCHEDULE_MODULE]: referenced })).toThrow("'kind'");
    });

    it('throws when a shared-package re-export resolves nowhere', () => {
      expect(() =>
        check({ [ELSEWHERE]: "export { gone } from '@hushbox/shared/elsewhere';\n" })
      ).toThrow('@hushbox/shared/elsewhere');
    });

    it('throws when a shared-package import resolves nowhere', () => {
      expect(() =>
        check({
          [ELSEWHERE]: "import { gone } from '@hushbox/shared/nowhere';\nexport const g = gone;\n",
        })
      ).toThrow('@hushbox/shared/nowhere');
    });
  });
});
