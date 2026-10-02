import type { EmailAction, EmailBlock } from './document.js';

export const SECURITY_CONTACT_EMAIL = 'security@hushbox.ai';
export const QUESTIONS_CONTACT_EMAIL = 'hello@hushbox.ai';
export const EMAIL_LEGAL_OWNER = 'LOME-AI LLC';

export const SECURITY_TEAM_ACTION: EmailAction = {
  kind: 'mail',
  label: 'Email the security team',
  address: SECURITY_CONTACT_EMAIL,
};

/** "Hi <name>," for a named user, "Hi," otherwise; an empty name counts as none. */
export function greeting(userName: string | undefined): EmailBlock {
  const text = userName ? `Hi ${userName},` : 'Hi,';
  return { kind: 'paragraph', content: [text] };
}
