import { z } from 'zod';
import { greeting, SECURITY_TEAM_ACTION } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const twoFactorEnabledEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Two-factor authentication enabled',
  preheader: () => "You'll need your authenticator app to sign in from now on.",
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      {
        kind: 'paragraph',
        content: [
          "Two-factor authentication has been enabled on your account. You'll need your authenticator app to sign in from now on.",
        ],
      },
      { kind: 'paragraph', content: ["If you didn't enable this, contact us immediately."] },
    ],
    action: SECURITY_TEAM_ACTION,
  }),
});
