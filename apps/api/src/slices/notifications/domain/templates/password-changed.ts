import { z } from 'zod';
import { greeting, SECURITY_TEAM_ACTION } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const passwordChangedEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Your password was changed',
  preheader: () =>
    "All other sessions were signed out. If this wasn't you, contact us immediately.",
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      {
        kind: 'paragraph',
        content: ['Your password was just changed. All other sessions have been signed out.'],
      },
      { kind: 'paragraph', content: ['If this was you, no action is needed.'] },
      {
        kind: 'paragraph',
        content: [
          "If you didn't change your password, your account may be compromised. Contact us immediately.",
        ],
      },
    ],
    action: SECURITY_TEAM_ACTION,
  }),
});
