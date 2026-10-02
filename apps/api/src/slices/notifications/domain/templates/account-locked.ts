import { z } from 'zod';
import { greeting } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
  lockoutMinutes: z.number(),
});

export const accountLockedEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Your account has been temporarily locked',
  preheader: (params) =>
    `Too many failed sign-in attempts. You can try again in ${String(params.lockoutMinutes)} minutes.`,
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      {
        kind: 'paragraph',
        content: [
          `Your HushBox account has been temporarily locked due to multiple failed sign-in attempts. You can try again in ${String(params.lockoutMinutes)} minutes.`,
        ],
      },
      {
        kind: 'paragraph',
        content: [
          "If this wasn't you, someone may be trying to access your account. We recommend changing your password when the lockout expires.",
        ],
      },
    ],
  }),
});
