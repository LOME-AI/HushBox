import { z } from 'zod';
import { greeting, SECURITY_TEAM_ACTION } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
  /** The app's settings page, where two-factor authentication is turned back on. */
  settingsUrl: z.url(),
});

export const twoFactorDisabledEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Two-factor authentication disabled',
  preheader: () => 'Your account is now protected by your password only.',
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      {
        kind: 'paragraph',
        content: [
          'Two-factor authentication has been removed from your account. Your account is now protected by password only.',
        ],
      },
      {
        kind: 'paragraph',
        content: [
          'We recommend re-enabling 2FA in ',
          { kind: 'link', text: 'Settings', href: params.settingsUrl },
          '.',
        ],
      },
      { kind: 'paragraph', content: ["If you didn't disable this, contact us immediately."] },
    ],
    action: SECURITY_TEAM_ACTION,
  }),
});
