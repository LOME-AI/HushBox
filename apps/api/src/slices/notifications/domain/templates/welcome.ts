import { z } from 'zod';
import { FEE_CATEGORIES, formatFeePercent, PRODUCT_TAGLINE, TOTAL_FEE_RATE } from '@hushbox/shared';
import { MANAGE_BALANCE_ONLINE_LABEL } from '@hushbox/shared/billing-portal';
import { greeting } from '../email/common.js';
import { defineEmail } from '../email/document.js';
import type { EmailBody } from '../email/document.js';

const schema = z.object({
  userName: z.string().optional(),
  /** The app's billing page, where credits are added. */
  billingUrl: z.url(),
  /** Where Open HushBox lands in the app. */
  appUrl: z.url(),
});

export const welcomeEmail = defineEmail({
  kind: 'standard',
  schema,
  subject: () => 'Welcome to HushBox',
  preheader: () => 'Pay as you go, and your credits never expire.',
  body: (params): EmailBody => ({
    blocks: [
      greeting(params.userName),
      { kind: 'paragraph', content: [PRODUCT_TAGLINE] },
      { kind: 'heading', text: 'How billing works' },
      {
        kind: 'paragraph',
        content: [
          'HushBox is pay-as-you-go. No subscriptions, no recurring charges. Add credits when you need them; they never expire.',
        ],
      },
      {
        kind: 'paragraph',
        content: [`We charge a ${formatFeePercent(TOTAL_FEE_RATE)} fee on AI model usage:`],
      },
      {
        kind: 'table',
        layout: 'figures',
        rows: FEE_CATEGORIES.map((category) => [
          category.shortLabel,
          [formatFeePercent(category.rate)],
        ]),
      },
      {
        kind: 'paragraph',
        content: [
          'Add credits on the ',
          { kind: 'link', text: 'Billing page', href: params.billingUrl },
          ` with any card. In the mobile app, tap “${MANAGE_BALANCE_ONLINE_LABEL}” to add them on our website and skip in-app processing fees.`,
        ],
      },
    ],
    action: { kind: 'link', label: 'Open HushBox', href: params.appUrl },
  }),
});
