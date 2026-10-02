import { z } from 'zod';
import { greeting, SECURITY_TEAM_ACTION } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
});

export const passwordResetEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Your password was reset',
  preheader: () => 'Your recovery phrase was used. All other sessions were signed out.',
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      {
        kind: 'paragraph',
        content: [
          'Your password was just reset with your recovery phrase. All other sessions have been signed out.',
        ],
      },
      {
        kind: 'paragraph',
        content: ['If this was you, no action is needed. Sign in with your new password.'],
      },
      {
        kind: 'paragraph',
        content: [
          "If you didn't reset your password, your account may be compromised. Contact us immediately.",
        ],
      },
    ],
    action: SECURITY_TEAM_ACTION,
  }),
});
