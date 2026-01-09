import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { balanceTransactions } from '../schema/balance-transactions';

type BalanceTransaction = typeof balanceTransactions.$inferSelect;

export const balanceTransactionFactory = Factory.define<BalanceTransaction>(({ params }) => {
  const type = params.type ?? 'deposit';
  const amount = parseFloat(
    params.amount ?? faker.number.float({ min: 10, max: 100, fractionDigits: 8 }).toFixed(8)
  );
  const balanceAfter = parseFloat(
    params.balanceAfter ??
      faker.number.float({ min: amount, max: 1000, fractionDigits: 8 }).toFixed(8)
  );

  return {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    amount: amount.toFixed(8),
    balanceAfter: balanceAfter.toFixed(8),
    type,
    paymentId: type === 'deposit' ? crypto.randomUUID() : null,
    description:
      type === 'deposit'
        ? `Credit purchase - $${amount.toFixed(2)}`
        : type === 'usage'
          ? `AI model usage`
          : `Balance adjustment`,
    createdAt: faker.date.recent(),
  };
});
