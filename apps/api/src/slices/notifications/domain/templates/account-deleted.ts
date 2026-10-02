import { z } from 'zod';
import { SECURITY_CONTACT_EMAIL } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

// Generic by design — the user record is gone by the time this sends.
const schema = z.object({});

export const accountDeletedEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Your HushBox account has been deleted',
  preheader: () => 'Every conversation you own is gone from our servers.',
  body: (): EmailBody => ({
    blocks: [
      {
        kind: 'paragraph',
        content: [
          'Every conversation you own, group chats included, has been permanently deleted from our servers, with its messages and media.',
        ],
      },
      {
        kind: 'paragraph',
        content: [
          'Financial records (payments, wallet ledger entries, usage history) are retained for audit and tax purposes, with your account identifier removed.',
        ],
      },
      {
        kind: 'paragraph',
        content: [
          "If this wasn't you, your account may have been compromised. Contact us immediately at ",
          {
            kind: 'link',
            text: SECURITY_CONTACT_EMAIL,
            href: `mailto:${SECURITY_CONTACT_EMAIL}`,
          },
          '.',
        ],
      },
    ],
  }),
});
