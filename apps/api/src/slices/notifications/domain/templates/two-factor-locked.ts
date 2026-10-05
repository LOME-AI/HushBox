import { z } from 'zod';
import { greeting, SECURITY_TEAM_ACTION } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
  /**
   * The guessing window's length; absent when the ceiling froze sign-in, where
   * no wait in minutes applies and the recovery-phrase reset is the remedy.
   */
  lockoutMinutes: z.number().optional(),
});

/** How long two-factor sign-in stays paused, as the preheader and the body state it. */
function pauseClause(lockoutMinutes: number | undefined, detail: string): string {
  return lockoutMinutes === undefined
    ? `Two-factor sign-in is paused until you reset your password${detail}.`
    : `Two-factor sign-in is paused for ${String(lockoutMinutes)} minutes.`;
}

/**
 * Sent once per run of wrong codes at a sign-in that already passed the
 * password, when the two-factor guessing gate refuses or the ceiling freezes
 * two-factor sign-in, whichever comes first: the strongest compromise signal
 * the server sees, since the one sending these codes holds the password.
 */
export const twoFactorLockedEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Your password was used, and the two-factor code was wrong',
  preheader: (params) =>
    `Too many wrong two-factor codes. ${pauseClause(params.lockoutMinutes, '')}`,
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      {
        kind: 'paragraph',
        content: [
          `Someone signed in to your HushBox account with your password, then entered too many wrong two-factor codes. ${pauseClause(params.lockoutMinutes, ' with your recovery phrase')}`,
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
