import { z } from 'zod';
import { greeting, SECURITY_TEAM_ACTION } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
  lockoutMinutes: z.number(),
});

/**
 * Sent when a sign-in that already passed the password trips the two-factor
 * guessing gate: the strongest compromise signal the server sees, since the
 * one sending these codes holds the password.
 */
export const twoFactorLockedEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Your password was used, and the two-factor code was wrong',
  preheader: (params) =>
    `Too many wrong two-factor codes. Two-factor sign-in is paused for ${String(params.lockoutMinutes)} minutes.`,
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      {
        kind: 'paragraph',
        content: [
          `Someone signed in to your HushBox account with your password, then entered too many wrong two-factor codes. Two-factor sign-in is paused for ${String(params.lockoutMinutes)} minutes.`,
        ],
      },
      {
        kind: 'paragraph',
        content: [
          "If this wasn't you, someone knows your password and only your two-factor code stopped them. Change your password as soon as you can.",
        ],
      },
    ],
    action: SECURITY_TEAM_ACTION,
  }),
});
