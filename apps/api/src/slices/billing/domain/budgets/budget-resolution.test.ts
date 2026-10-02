import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { HOUR_MS, TEST_DAY_START, isoAt } from '@hushbox/shared/test-time';
import { errAsync, okAsync } from '../../../../lib/result/index.js';
import { unavailableError } from '../../../../lib/errors/index.js';
import { DAILY_ALLOWANCE_NANO_USD } from '../constants.js';
import { resolveBudgetScopes } from './budget-resolution.js';
import type { Database } from '@hushbox/db';
import type { BillingStores } from '../../ports/index.js';

const DB = {} as Database;
const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);
/** The UTC day `NOW` falls on, which every allowance scope is keyed to. */
const NOW_DAY = isoAt(TEST_DAY_START).slice(0, 10);

function fakeStores(overrides: Partial<BillingStores>): BillingStores {
  return { ...overrides } as unknown as BillingStores;
}

describe('resolveBudgetScopes', () => {
  it('returns no scopes when neither budget is requested', async () => {
    const result = await resolveBudgetScopes(fakeStores({}), DB, { now: NOW });
    expect(result._unsafeUnwrap()).toEqual([]);
  });

  it('resolves the allowance scope from the daily spend row', async () => {
    const stores = fakeStores({ readAllowanceSpent: () => okAsync(20_000_000n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.remainingNanoUsd).toBe(DAILY_ALLOWANCE_NANO_USD - 20_000_000n);
  });

  it('carries the UTC day period in the allowance scopeId', async () => {
    const stores = fakeStores({ readAllowanceSpent: () => okAsync(0n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    expect(result._unsafeUnwrap()[0]?.scopeId).toBe(`allowance:user-1:${NOW_DAY}`);
  });

  it('reads the allowance spend row for the current UTC day', async () => {
    const spy = vi.fn(() => okAsync(0n));
    const stores = fakeStores({ readAllowanceSpent: spy });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    expect(result.isOk()).toBe(true);
    expect(spy).toHaveBeenCalledWith(DB, 'user-1', NOW_DAY);
  });

  it('resolves the member scope from the durable per-member row', async () => {
    const stores = fakeStores({
      readMemberBudget: () =>
        okAsync({ budgetNanoUsd: 5_000_000_000n, spentNanoUsd: 1_000_000_000n }),
    });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      memberBudget: { memberId: 'm-1' },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.remainingNanoUsd).toBe(4_000_000_000n);
    expect(scopes[0]?.scopeId).toBe('member:m-1');
  });

  it('denies (remaining 0) when no durable member row exists', async () => {
    const stores = fakeStores({ readMemberBudget: () => okAsync(null) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      memberBudget: { memberId: 'm-1' },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes[0]?.remainingNanoUsd).toBe(0n);
    expect(scopes[0]?.scopeId).toBe('member:m-1');
  });

  it('reads the durable member row (no period key)', async () => {
    const spy = vi.fn(() => okAsync({ budgetNanoUsd: 1000n, spentNanoUsd: 0n }));
    const stores = fakeStores({ readMemberBudget: spy });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      memberBudget: { memberId: 'm-1' },
    });
    expect(result.isOk()).toBe(true);
    expect(spy).toHaveBeenCalledWith(DB, 'm-1');
  });

  it('clamps a member scope to zero when spend exceeds the cap', async () => {
    const stores = fakeStores({
      readMemberBudget: () => okAsync({ budgetNanoUsd: 1000n, spentNanoUsd: 5000n }),
    });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      memberBudget: { memberId: 'm-1' },
    });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(0n);
  });

  it('resolves the conversation scope from the caller cap minus durable spend', async () => {
    const stores = fakeStores({ readConversationSpent: () => okAsync(1_500_000_000n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      conversationBudget: { conversationId: 'c-1', capNanoUsd: 5_000_000_000n },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes).toHaveLength(1);
    expect(scopes[0]?.remainingNanoUsd).toBe(3_500_000_000n);
    expect(scopes[0]?.scopeId).toBe('conversation:c-1');
  });

  it('denies (remaining 0) when the conversation cap is zero', async () => {
    const stores = fakeStores({ readConversationSpent: () => okAsync(0n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      conversationBudget: { conversationId: 'c-1', capNanoUsd: 0n },
    });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(0n);
  });

  it('clamps a conversation scope to zero when spend exceeds the cap', async () => {
    const stores = fakeStores({ readConversationSpent: () => okAsync(9_000_000_000n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      conversationBudget: { conversationId: 'c-1', capNanoUsd: 1_000_000_000n },
    });
    expect(result._unsafeUnwrap()[0]?.remainingNanoUsd).toBe(0n);
  });

  it('resolves all three scopes in order: allowance, member, conversation', async () => {
    const stores = fakeStores({
      readAllowanceSpent: () => okAsync(0n),
      readMemberBudget: () => okAsync({ budgetNanoUsd: 2000n, spentNanoUsd: 0n }),
      readConversationSpent: () => okAsync(0n),
    });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
      memberBudget: { memberId: 'm-1' },
      conversationBudget: { conversationId: 'c-1', capNanoUsd: 4000n },
    });
    const scopes = result._unsafeUnwrap();
    expect(scopes.map((s) => s.scopeId)).toEqual([
      `allowance:user-1:${NOW_DAY}`,
      'member:m-1',
      'conversation:c-1',
    ]);
  });

  it('carries the allowance level as a typed kind', async () => {
    const stores = fakeStores({ readAllowanceSpent: () => okAsync(0n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    expect(result._unsafeUnwrap()[0]?.kind).toBe('allowance');
  });

  it('carries the member level as a typed kind', async () => {
    const stores = fakeStores({
      readMemberBudget: () => okAsync({ budgetNanoUsd: 2000n, spentNanoUsd: 0n }),
    });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      memberBudget: { memberId: 'm-1' },
    });
    expect(result._unsafeUnwrap()[0]?.kind).toBe('member');
  });

  it('carries the conversation level as a typed kind', async () => {
    const stores = fakeStores({ readConversationSpent: () => okAsync(0n) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      conversationBudget: { conversationId: 'c-1', capNanoUsd: 4000n },
    });
    expect(result._unsafeUnwrap()[0]?.kind).toBe('conversation');
  });

  it('propagates a store read failure as the domain error', async () => {
    const stores = fakeStores({ readAllowanceSpent: () => errAsync(unavailableError('down')) });
    const result = await resolveBudgetScopes(stores, DB, {
      now: NOW,
      allowance: { userId: 'user-1' },
    });
    expect(result.isErr()).toBe(true);
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });
});

/**
 * The scope ids this file builds are Redis hash names, not a level encoding.
 * `BudgetScope.kind` is the one way to read which ceiling a scope is, so a
 * caller that recovers the level by decoding the id has re-created the string
 * contract the typed field replaced — and it drifts silently the day an id
 * format changes.
 *
 * The check reads source TEXT because what has to be absent is a call, not a
 * runtime binding there is anything to enumerate. Its reach is `apps/api/src`,
 * which is where every `BudgetScope` consumer lives; a consumer outside that
 * tree would not be seen.
 */
describe('scope levels are read from the typed kind, never decoded from the id', () => {
  const SNIFFS: readonly RegExp[] = [
    /\.\s*startsWith\(\s*['"`](?:allowance|member|conversation):/,
    /scopeId\b.*\.\s*(?:startsWith|split|slice|substring|indexOf|match)\s*\(/,
  ];

  function sourceFiles(dir: string): readonly string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return sourceFiles(full);
      return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });
  }

  it('leaves no scope-id prefix decode anywhere under the product Worker', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
    const offenders = sourceFiles(root)
      .filter((file) => file !== fileURLToPath(import.meta.url))
      .filter((file) => SNIFFS.some((sniff) => sniff.test(readFileSync(file, 'utf8'))));
    expect(offenders).toEqual([]);
  });
});
