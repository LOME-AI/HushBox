/**
 * A stand-in for the real money vocabulary, carrying the shapes the rule
 * reasons about: brands built from `unique symbol` properties, minters that
 * take a served payload, comparators that take a reading, and reads that take
 * the request context a payload is fetched with.
 *
 * It is declared here rather than imported from `scripts/lib/money/money.ts`
 * because the rule's predicates are STRUCTURAL — a brand is a unique-symbol
 * property declared in first-party source, whatever it is called — so a fixture
 * brand exercises exactly what a real one does, and the fixture stays
 * resolvable from a package that does not depend on the E2E tree.
 */
declare const servedBrand: unique symbol;
declare const derivedBrand: unique symbol;
declare const observedBrand: unique symbol;

export type DerivedNanoUsd = bigint & { readonly [derivedBrand]: 'derived' };
export type ObservedNanoUsd = bigint & { readonly [observedBrand]: 'observed' };

type Served<T> = { readonly [K in keyof T]: T[K] & { readonly [servedBrand]: 'served' } };

export type ServedChargeBasis = Served<{
  generationChargeNanoUsd: string;
  echoPrefix: string;
  echoSuffix: string;
}>;
export type ServedModelPricing = Served<{ perImage: string }>;
export type ServedAttributionRow = Served<{ messageId: string; payerId: string }>;

export interface MoneyState {
  readonly purchasedNanoUsd: ObservedNanoUsd;
  readonly freeNanoUsd: ObservedNanoUsd;
  readonly allowanceRemainingNanoUsd: ObservedNanoUsd;
}

export interface MoneyExpectation {
  readonly purchased?: DerivedNanoUsd;
}

export interface MockTextTurn {
  readonly prompt: string;
  readonly answers: number;
}

export interface ChargeAttribution {
  readonly payerId: string;
}

/** The shape of the context a read is made from, as Playwright declares it. */
export interface APIRequestContext {
  get(url: string): Promise<{ json(): Promise<unknown> }>;
}

export declare function readMockChargeBasis(request: APIRequestContext): Promise<ServedChargeBasis>;
export declare function readServedModelPricing(
  request: APIRequestContext,
  modelId: string
): Promise<ServedModelPricing>;
export declare function readMoneyState(request: APIRequestContext): Promise<MoneyState>;
export declare function readSettledCharge(
  request: APIRequestContext,
  conversationId: string
): Promise<ObservedNanoUsd>;
export declare function readHold(
  request: APIRequestContext,
  conversationId: string
): Promise<ObservedNanoUsd>;
export declare function readChargeAttribution(
  request: APIRequestContext,
  conversationId: string
): Promise<ServedAttributionRow[]>;

export declare function mockGenerationCharge(
  basis: ServedChargeBasis,
  generations: number
): DerivedNanoUsd;
export declare function mockTextTurnCharge(
  basis: ServedChargeBasis,
  turn: MockTextTurn
): DerivedNanoUsd;
export declare function catalogPerImageCharge(
  pricing: ServedModelPricing,
  images: number
): DerivedNanoUsd;
export declare function storedTextCharge(chars: number): DerivedNanoUsd;
export declare function sumOfCharges(...parts: readonly DerivedNanoUsd[]): DerivedNanoUsd;
export declare function spendOf(charge: DerivedNanoUsd): DerivedNanoUsd;

export declare function compareMoneyState(actual: MoneyState, expected: MoneyExpectation): string;
export declare function compareHoldCoverage(hold: ObservedNanoUsd, charge: ObservedNanoUsd): string;
export declare function compareChargeAttribution(
  rows: readonly ServedAttributionRow[],
  expected: ChargeAttribution
): string;

export declare function expectExactCharge(
  request: APIRequestContext,
  conversationId: string,
  expected: DerivedNanoUsd
): Promise<void>;
export declare function expectHoldCovers(
  request: APIRequestContext,
  conversationId: string,
  hold: ObservedNanoUsd
): Promise<void>;
export declare function expectNoMoneyMoved(
  request: APIRequestContext,
  conversationId: string,
  before: MoneyState
): Promise<void>;
export declare function expectChargeAttribution(
  request: APIRequestContext,
  conversationId: string,
  expected: ChargeAttribution
): Promise<void>;
