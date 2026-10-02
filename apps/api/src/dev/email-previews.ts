import { ROUTES } from '@hushbox/shared';
import {
  accountDeletedEmail,
  accountLockedEmail,
  adminDailyDigestEmail,
  adminOpNotificationEmail,
  chargebackLockEmail,
  newsletterConfirmationEmail,
  newsletterIssueEmail,
  passwordChangedEmail,
  passwordResetEmail,
  renderEmail,
  twoFactorDisabledEmail,
  twoFactorEnabledEmail,
  verificationEmail,
  welcomeEmail,
} from '../slices/notifications/index.js';

/**
 * Sample values for the email previews. The ids carry a midnight timestamp and
 * the instants are built from parts, so nothing here reads as a recorded event.
 */
const PREVIEW_DAY = { year: 2026, monthIndex: 6, day: 17 } as const;

const PREVIEW_USER_ID = '019f6d5f-7400-7000-8000-000000000001';

const PREVIEW_AUDIT_ID = '019f6d5f-7400-7000-8000-000000000002';

const PREVIEW_JOB_ID = '019f6d5f-7400-7000-8000-000000000003';

function previewInstant(hour: number, minute: number): string {
  return new Date(
    Date.UTC(PREVIEW_DAY.year, PREVIEW_DAY.monthIndex, PREVIEW_DAY.day, hour, minute)
  ).toISOString();
}

/** The send date a rendered preview stamps its copyright year from. */
const PREVIEW_SENT_AT = new Date(previewInstant(9, 30));

/** The admin origin the operator email samples link the audit log on: production's. */
const PREVIEW_ADMIN_URL = 'https://admin.hushbox.ai';

/** A sample link to a marketing newsletter page, on the production origin. */
function previewMarketingLink(path: string, token: string): string {
  const url = new URL(path, 'https://hushbox.ai');
  url.searchParams.set('token', token);
  return url.toString();
}

/**
 * The email-template preview gallery served at `GET /dev/emails` and rendered
 * (one iframe per entry) by the web `dev/emails` route. Sample params mirror
 * the notifications-slice template schemas; the response carries only the
 * rendered `html`, never a real send.
 */
export const EMAIL_TEMPLATE_PREVIEWS: readonly {
  name: string;
  label: string;
  render: () => string;
}[] = [
  {
    name: 'verification',
    label: 'Email Verification',
    render: (): string =>
      renderEmail(
        verificationEmail,
        {
          verificationUrl: 'https://hushbox.ai/verify?token=sample-token-abc123',
          userName: 'Alice',
          expiresInHours: 24,
        },
        { sentAt: PREVIEW_SENT_AT }
      ).html,
  },
  {
    name: 'password-changed',
    label: 'Password Changed',
    render: (): string =>
      renderEmail(passwordChangedEmail, { userName: 'Alice' }, { sentAt: PREVIEW_SENT_AT }).html,
  },
  {
    name: 'password-reset',
    label: 'Password Reset',
    render: (): string =>
      renderEmail(passwordResetEmail, { userName: 'Alice' }, { sentAt: PREVIEW_SENT_AT }).html,
  },
  {
    name: 'two-factor-enabled',
    label: 'Two-Factor Enabled',
    render: (): string =>
      renderEmail(twoFactorEnabledEmail, { userName: 'Alice' }, { sentAt: PREVIEW_SENT_AT }).html,
  },
  {
    name: 'two-factor-disabled',
    label: 'Two-Factor Disabled',
    render: (): string =>
      renderEmail(
        twoFactorDisabledEmail,
        { userName: 'Alice', settingsUrl: 'https://hushbox.ai/settings' },
        { sentAt: PREVIEW_SENT_AT }
      ).html,
  },
  {
    name: 'account-locked',
    label: 'Account Locked',
    render: (): string =>
      renderEmail(
        accountLockedEmail,
        { userName: 'Alice', lockoutMinutes: 15 },
        { sentAt: PREVIEW_SENT_AT }
      ).html,
  },
  {
    name: 'welcome',
    label: 'Welcome',
    render: (): string =>
      renderEmail(
        welcomeEmail,
        {
          userName: 'Alice',
          billingUrl: 'https://hushbox.ai/billing',
          appUrl: 'https://hushbox.ai/chat',
        },
        { sentAt: PREVIEW_SENT_AT }
      ).html,
  },
  {
    name: 'account-deleted',
    label: 'Account Deleted',
    render: (): string => renderEmail(accountDeletedEmail, {}, { sentAt: PREVIEW_SENT_AT }).html,
  },
  {
    name: 'chargeback-lock',
    label: 'Chargeback Lock',
    render: (): string => chargebackLockEmail({ userName: 'Alice' }).html,
  },
  {
    name: 'admin-op-notification',
    label: 'Admin Op Notification',
    render: (): string =>
      renderEmail(
        adminOpNotificationEmail,
        {
          opName: 'user.lock',
          actorEmail: 'admin@hushbox.ai',
          target: { type: 'user', id: PREVIEW_USER_ID },
          reason: 'Chargeback dispute on payment pay_1234',
          occurredAt: previewInstant(9, 30),
          isUndo: false,
          auditId: PREVIEW_AUDIT_ID,
          adminUrl: PREVIEW_ADMIN_URL,
        },
        { sentAt: PREVIEW_SENT_AT }
      ).html,
  },
  {
    name: 'admin-daily-digest',
    label: 'Admin Daily Digest',
    render: (): string =>
      renderEmail(
        adminDailyDigestEmail,
        {
          day: previewInstant(0, 0).slice(0, 10),
          actions: [
            {
              opName: 'user.lock',
              actorEmail: 'admin@hushbox.ai',
              target: { type: 'user', id: PREVIEW_USER_ID },
              occurredAt: previewInstant(9, 30),
            },
            {
              opName: 'job.redrive',
              actorEmail: 'admin@hushbox.ai',
              target: { type: 'job', id: PREVIEW_JOB_ID },
              occurredAt: previewInstant(14, 5),
            },
          ],
          adminUrl: PREVIEW_ADMIN_URL,
        },
        { sentAt: PREVIEW_SENT_AT }
      ).html,
  },
  {
    name: 'newsletter-confirmation',
    label: 'Newsletter Confirmation',
    render: (): string =>
      renderEmail(
        newsletterConfirmationEmail,
        {
          confirmUrl: previewMarketingLink(ROUTES.NEWSLETTER_CONFIRMED, 'sample-token-abc123'),
        },
        { sentAt: PREVIEW_SENT_AT }
      ).html,
  },
  {
    name: 'newsletter-issue',
    label: 'Newsletter Issue',
    render: (): string =>
      renderEmail(
        newsletterIssueEmail,
        {
          subject: 'What shipped this month',
          bodyMarkdown: [
            '## New this month',
            '',
            'We shipped **group conversations** and a faster composer.',
            '',
            'Read the full changelog at [hushbox.ai/blog](https://hushbox.ai/blog).',
          ].join('\n'),
          unsubscribeUrl: previewMarketingLink(
            ROUTES.NEWSLETTER_UNSUBSCRIBED,
            'sample-token-xyz789'
          ),
        },
        { sentAt: PREVIEW_SENT_AT }
      ).html,
  },
];
