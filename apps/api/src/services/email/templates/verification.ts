import { wrapInBaseTemplate, COLORS } from './base.js';

export interface VerificationEmailParams {
  userName?: string | undefined;
  verificationUrl: string;
  expiresInHours?: number | undefined;
}

export interface EmailContent {
  html: string;
  text: string;
}

const DEFAULT_EXPIRES_IN_HOURS = 24;

function buildHtmlContent(params: VerificationEmailParams): string {
  const { userName, verificationUrl, expiresInHours = DEFAULT_EXPIRES_IN_HOURS } = params;
  const greeting = userName ? `Hi ${userName},` : 'Hi,';

  const content = `
    <h1 style="margin: 0 0 16px 0; color: ${COLORS.textPrimary}; font-size: 24px; font-weight: 600;">
      Welcome to LOME-CHAT
    </h1>
    <p style="margin: 0 0 8px 0; color: ${COLORS.textPrimary}; font-size: 16px; line-height: 1.5;">
      ${greeting}
    </p>
    <p style="margin: 0 0 32px 0; color: ${COLORS.textSecondary}; font-size: 16px; line-height: 1.5;">
      Please verify your email address to get started.
    </p>
    <table role="presentation" cellpadding="0" cellspacing="0" style="margin: 0 0 32px 0;">
      <tr>
        <td align="center" style="background-color: ${COLORS.accent}; border-radius: 8px;">
          <a href="${verificationUrl}" style="display: inline-block; padding: 16px 32px; color: #ffffff; font-size: 16px; font-weight: 600; text-decoration: none; min-width: 120px; text-align: center;">
            Verify Email
          </a>
        </td>
      </tr>
    </table>
    <p style="margin: 0; color: ${COLORS.textSecondary}; font-size: 14px;">
      This link expires in ${String(expiresInHours)} hours.
    </p>
    <p style="margin: 16px 0 0 0; color: ${COLORS.textSecondary}; font-size: 12px; line-height: 1.5;">
      If you didn't create an account with LOME-CHAT, you can safely ignore this email.
    </p>
  `;

  return wrapInBaseTemplate(content);
}

function buildTextContent(params: VerificationEmailParams): string {
  const { userName, verificationUrl, expiresInHours = DEFAULT_EXPIRES_IN_HOURS } = params;
  const greeting = userName ? `Hi ${userName},` : 'Hi,';

  return `LOME-CHAT

Welcome to LOME-CHAT

${greeting}

Please verify your email address to get started.

Verify your email by visiting this link:
${verificationUrl}

This link expires in ${String(expiresInHours)} hours.

If you didn't create an account with LOME-CHAT, you can safely ignore this email.

---
© 2025 LOME-AI LLC
Questions? hello@lome-chat.com
`;
}

export function verificationEmail(params: VerificationEmailParams): EmailContent {
  return {
    html: buildHtmlContent(params),
    text: buildTextContent(params),
  };
}
