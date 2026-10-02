import { z } from 'zod';
import { NEWSLETTER_CONFIRM_TTL_MS } from '@hushbox/shared';
import { HOUR_MS } from '@hushbox/shared/durations';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  confirmUrl: z.url(),
});

const EXPIRES_IN_HOURS = String(NEWSLETTER_CONFIRM_TTL_MS / HOUR_MS);

// Transactional double-opt-in email: deliberately no postal address and no
// unsubscribe link — CAN-SPAM exempts transactional mail, and an unsubscribe
// link on an unconfirmed address would be a subscription-state footgun.
export const newsletterConfirmationEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Confirm your subscription',
  preheader: () =>
    `Nothing happens until you confirm. The link expires in ${EXPIRES_IN_HOURS} hours.`,
  body: (params): EmailBody => ({
    blocks: [
      {
        kind: 'paragraph',
        content: [
          'You (or some scoundrel with your email address) asked to join the HushBox mailing list. Either way, nothing happens until you confirm.',
        ],
      },
    ],
    action: { kind: 'link', label: 'Confirm subscription', href: params.confirmUrl },
    afterAction: [
      { kind: 'finePrint', content: [`This link expires in ${EXPIRES_IN_HOURS} hours.`] },
      { kind: 'finePrint', content: ["Not you? Ignore this email and we'll never write again."] },
    ],
  }),
});
