/**
 * Over every email-shaped identifier the encoder admits, the counter key it
 * answers carries no `@`: the identifier reaches the key only as its keyed
 * digest, so no address is legible in the store's key names.
 *
 * Generator: `fc.emailAddress()`, bounded to the identifier length the encoder
 * admits so every generated case reaches a key rather than the validation arm.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MAX_IDENTIFIER_LENGTH, rateLimitKey } from './consume.js';
import type { ReservationLimit } from './definition.js';

const EMAIL_KEYED: ReservationLimit = {
  kind: 'reservation',
  maxAttempts: 5,
  windowSeconds: 900,
  buildKey: (id: string) => `ratelimit:test:email:${id}`,
};

const admittedEmail = fc.emailAddress().filter((email) => email.length <= MAX_IDENTIFIER_LENGTH);

describe('the counter key for an email-shaped identifier', () => {
  it('never contains an @', () => {
    fc.assert(
      fc.property(admittedEmail, (email) => {
        const key = rateLimitKey(EMAIL_KEYED, email)._unsafeUnwrap();
        expect(key).not.toContain('@');
      })
    );
  });
});
