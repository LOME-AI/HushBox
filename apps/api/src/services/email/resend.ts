import type { EmailClient, EmailOptions } from './types.js';

const DEFAULT_FROM = 'LOME-CHAT <noreply@mail.lome-chat.com>';
const RESEND_API_URL = 'https://api.resend.com/emails';

interface ResendErrorResponse {
  message: string;
}

export function createResendEmailClient(apiKey: string): EmailClient {
  return {
    async sendEmail(options: EmailOptions): Promise<void> {
      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: options.from ?? DEFAULT_FROM,
          to: options.to,
          subject: options.subject,
          html: options.html,
          ...(options.text && { text: options.text }),
        }),
      });

      if (!response.ok) {
        const error: ResendErrorResponse = await response.json();
        throw new Error(`Failed to send email: ${error.message}`);
      }
    },
  };
}
