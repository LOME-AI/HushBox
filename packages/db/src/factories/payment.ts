import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { payments } from '../schema/payments';

type Payment = typeof payments.$inferSelect;

const CARD_TYPES = ['Visa', 'Mastercard', 'Amex', 'Discover'];

export const paymentFactory = Factory.define<Payment>(({ params }) => {
  const status = params.status ?? 'confirmed';
  const now = faker.date.recent();
  const isConfirmed = status === 'confirmed';

  return {
    id: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    amount: faker.number.float({ min: 10, max: 500, fractionDigits: 8 }).toFixed(8),
    status,
    helcimTransactionId: isConfirmed ? faker.string.uuid() : null,
    cardType: isConfirmed ? faker.helpers.arrayElement(CARD_TYPES) : null,
    cardLastFour: isConfirmed ? faker.string.numeric(4) : null,
    errorMessage: status === 'failed' ? faker.lorem.sentence() : null,
    createdAt: now,
    updatedAt: now,
    webhookReceivedAt: isConfirmed ? faker.date.recent({ refDate: now }) : null,
  };
});
