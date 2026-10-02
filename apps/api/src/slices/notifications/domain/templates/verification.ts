import { z } from 'zod';
import { greeting } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
  verificationUrl: z.url(),
  /** The verification token's lifetime, so the copy states the link's real expiry. */
  expiresInHours: z.number().positive(),
});

export const verificationEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Verify your email address',
  preheader: (params) =>
    `Finish setting up your HushBox account. The link expires in ${String(params.expiresInHours)} hours.`,
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      { kind: 'paragraph', content: ['Please verify your email address to get started.'] },
    ],
    action: { kind: 'link', label: 'Verify Email', href: params.verificationUrl },
    afterAction: [
      {
        kind: 'finePrint',
        content: [`This link expires in ${String(params.expiresInHours)} hours.`],
      },
      {
        kind: 'finePrint',
        content: [
          "If you didn't create an account with HushBox, you can safely ignore this email.",
        ],
      },
    ],
  }),
});
