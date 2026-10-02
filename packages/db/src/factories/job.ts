import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import type { jobs } from '../schema/jobs';

type NewJob = typeof jobs.$inferInsert;

/**
 * Builds insertable `jobs` rows: a pending row with the dispatcher's
 * required counters. The type name is a test-only versioned name with no
 * registered handler, so a dispatcher that does claim one of these rows
 * dead-letters it as an unregistered type — which is why a test that commits
 * them deletes them in the same file.
 */
export const jobFactory = Factory.define<NewJob>(() => ({
  type: 'test.noop.v1',
  payload: {},
  status: 'pending',
  maxClaims: 5,
  maxFailures: 5,
  leaseSeconds: 60,
}));

/** An exhausted dead row — the redrive/discard op target. */
export const deadJobFactory = Factory.define<NewJob>(() => {
  const base = jobFactory.build();
  return {
    ...base,
    status: 'dead',
    claims: base.maxClaims,
    failures: base.maxFailures,
    finishedAt: faker.date.recent(),
    errors: [{ at: faker.date.recent().toISOString(), claim: base.maxClaims, error: 'boom' }],
  };
});

/** A dead row an admin discarded (restorable marker set). */
export const discardedJobFactory = Factory.define<NewJob>(() => ({
  ...deadJobFactory.build(),
  discardedAt: faker.date.recent(),
}));
