import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { balanceTransactions } from '../schema/balance-transactions';

type BalanceTransaction = typeof balanceTransactions.$inferSelect;

export const balanceTransactionFactory = Factory.define<BalanceTransaction>(({ params }) => {
  const type = params.type ?? 'deposit';
  const amount = Number.parseFloat(
    params.amount ?? faker.number.float({ min: 10, max: 100, fractionDigits: 8 }).toFixed(8)
  );
  const balanceAfter = Number.parseFloat(
    params.balanceAfter ??
      faker.number.float({ min: amount, max: 1000, fractionDigits: 8 }).toFixed(8)
  );

  // Usage transaction fields - only populated for usage type
  const isUsage = type === 'usage';
  const inputCharacters = isUsage ? faker.number.int({ min: 100, max: 2000 }) : null;
  const outputCharacters = isUsage ? faker.number.int({ min: 200, max: 4000 }) : null;

  return {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    amount: amount.toFixed(8),
    balanceAfter: balanceAfter.toFixed(8),
    type,
    paymentId: type === 'deposit' ? crypto.randomUUID() : null,
    model: isUsage
      ? faker.helpers.arrayElement(['openai/gpt-4o-mini', 'anthropic/claude-3-opus'])
      : null,
    inputCharacters,
    outputCharacters,
    deductionSource: isUsage
      ? faker.helpers.arrayElement(['balance', 'freeAllowance'] as const)
      : null,
    createdAt: faker.date.recent(),
  };
});
