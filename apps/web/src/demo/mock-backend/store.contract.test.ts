import { describe, it, expect } from 'vitest';
import { hc } from 'hono/client';
import type { InferResponseType } from 'hono/client';
import type { AppType } from '@hushbox/api';
import type { DemoBackendStore } from './store';

/**
 * Contract pinning the demo backend's hand-rolled wire shapes to the REAL API
 * response types inferred from the Hono route definitions (`AppType`). The
 * demo store hand-rolls these shapes so the unmodified app read path runs
 * against it; if a production route's response shape drifts (a renamed/added
 * field), the `satisfies` checks below stop compiling — so the drift fails at
 * `typecheck` rather than as a silent runtime mismatch only reproducible in the
 * browser. (The standard typecheck gate enforces this; vitest is not configured
 * for `typecheck`, so `expectTypeOf` alone would not catch drift.)
 *
 * `hc<AppType>()` is constructed only as a `typeof` anchor for
 * `InferResponseType`; no request is made, so the dummy base URL is never
 * dereferenced.
 *
 * A pin must be scoped to the 200 branch AND `Extract`ed on a required key of
 * the success shape. A handler whose returned VALUE is a bare `Response`
 * rather than a `TypedResponse` resolves to `{}` at every status of that
 * route — correctly, since such a response has no JSON body to describe — and
 * `{}` admits any object, so an unfiltered pin over such a route is vacuously
 * satisfied. Refusals are not that case: `respondDomainError` returns
 * `RefusalResponse`, whose status is the 4xx/5xx range, so no refusal body
 * reaches the 200 branch. The `Extract` is what makes a pin fail loudly anyway:
 * if the real success shape drops or renames the sentinel key, it collapses to
 * `never` and the `satisfies` stops compiling.
 */
const _typeClient = hc<AppType>('http://demo.invalid');

type RealBalance = Extract<
  InferResponseType<typeof _typeClient.billing.balance.$get, 200>,
  { purchased: unknown }
>;

// The conversations slice's `respond200` tail carries its `TypedResponse`
// through unannotated, so the members/links 200 shapes flow into `AppType` and
// are pinnable.
type Members200 = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['members']['$get'],
  200
>;
type Links200 = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['links']['$get'],
  200
>;
type Spendable200 = InferResponseType<typeof _typeClient.billing.spendable.$get, 200>;
type Budgets200 = InferResponseType<
  (typeof _typeClient.conversations)[':conversationId']['budgets']['$get'],
  200
>;
type RealSpendable = Extract<Spendable200, { spendableNanoUsd: unknown }>;
type RealMembers = Extract<Members200, { members: unknown }>;
type RealLinks = Extract<Links200, { links: unknown }>;
type RealBudgets = Extract<Budgets200, { ownerBalanceNanoUsd: unknown }>;

type DemoBalance = ReturnType<DemoBackendStore['getBalance']>;
type DemoMembers = ReturnType<DemoBackendStore['getMembers']>;
type DemoLinks = ReturnType<DemoBackendStore['getLinks']>;
type DemoSpendable = ReturnType<DemoBackendStore['getSpendable']>;
type DemoBudgets = ReturnType<DemoBackendStore['getConversationBudgets']>;

// Phantom demo values typed exactly as the store returns. Each `satisfies`
// clause fails to compile if the demo shape stops being assignable to the real
// wire response, turning shape drift into a typecheck error.
const balance = null as unknown as DemoBalance;
const members = null as unknown as DemoMembers;
const links = null as unknown as DemoLinks;
const spendable = null as unknown as DemoSpendable;
const budgets = null as unknown as DemoBudgets;

describe('demo backend response contracts', () => {
  it('balance matches the real $get response shape', () => {
    expect(balance satisfies RealBalance).toBe(balance);
  });

  it('members matches the real $get response shape', () => {
    expect(members satisfies RealMembers).toBe(members);
  });

  it('links matches the real $get response shape', () => {
    expect(links satisfies RealLinks).toBe(links);
  });

  it('spendable matches the real $get response shape', () => {
    expect(spendable satisfies RealSpendable).toBe(spendable);
  });

  it('conversation budgets match the real $get response shape', () => {
    expect(budgets satisfies RealBudgets).toBe(budgets);
  });
});
