import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { FREE_ALLOWANCE_CENTS, WELCOME_CREDIT_BALANCE } from '../constants';
import type { users } from '../schema/users';

type User = typeof users.$inferSelect;

export const userFactory = Factory.define<User>(() => ({
  id: crypto.randomUUID(),
  email: faker.internet.email(),
  name: faker.person.fullName(),
  emailVerified: false,
  image: null,
  balance: WELCOME_CREDIT_BALANCE,
  freeAllowanceCents: FREE_ALLOWANCE_CENTS,
  freeAllowanceResetAt: null,
  createdAt: faker.date.recent(),
  updatedAt: faker.date.recent(),
}));
