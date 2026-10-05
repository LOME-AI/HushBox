import { z } from 'zod';
import { BILLING_CONTACT_EMAIL } from '@hushbox/shared';
import { greeting } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
});

// The chargeback auto-lock is indefinite: it lifts only when the dispute is
// resolved, so this copy carries no lockout duration and points the user at
// the billing team rather than telling them to wait.
export const chargebackLockEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Your account was locked',
  preheader: () => 'A recent charge was disputed. The lock stays until the dispute is resolved.',
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      {
        kind: 'paragraph',
        content: [
          'Your HushBox account has been locked because of a payment dispute on a recent charge.',
        ],
      },
      {
        kind: 'paragraph',
        content: [
          'The lock stays in place until the dispute is resolved. Contact us to resolve it.',
        ],
      },
    ],
    action: { kind: 'mail', label: 'Email the billing team', address: BILLING_CONTACT_EMAIL },
  }),
});
