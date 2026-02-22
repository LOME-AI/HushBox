import type { LegalSection, LegalDocumentMeta } from './types.js';
import { PRIVACY_POLICY_EFFECTIVE_DATE, PRIVACY_CONTACT_EMAIL } from '../constants.js';

export const PRIVACY_POLICY_META: LegalDocumentMeta = {
  title: 'Privacy Policy',
  effectiveDate: PRIVACY_POLICY_EFFECTIVE_DATE,
  contactEmail: PRIVACY_CONTACT_EMAIL,
};

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    id: 'data-collection',
    title: 'Data We Collect',
    simplyPut: 'Email, username, and encrypted messages. That\u2019s it.',
    points: [
      'Account information: your email address and username, provided during registration.',
      'Message content: stored as encrypted blobs that our servers cannot read. The encryption key is derived from your password, which never leaves your device.',
      'Transient metadata: your IP address is used for rate limiting during requests but is not stored persistently.',
      'We do not store your payment information. All payment processing is handled entirely by our third-party payment processor.',
    ],
  },
  {
    id: 'data-usage',
    title: 'How We Use Your Data',
    simplyPut: 'To run the service. Nothing else.',
    points: [
      'Providing and operating the HushBox service, including routing your messages to AI models.',
      'Maintaining the security of your account and our infrastructure.',
      'Processing billing and maintaining financial records.',
      'Complying with applicable legal obligations.',
      'We do not use your data for advertising, profiling, or any purpose other than operating the service. We do not sell your data.',
    ],
  },
  {
    id: 'third-party-services',
    title: 'Third-Party Services',
    simplyPut: 'AI providers see your messages but not your identity.',
    points: [
      'We route your messages through third-party AI providers to generate responses. Your messages are sent using HushBox\u2019s credentials, not yours \u2014 providers cannot identify you personally.',
      'Message content is visible to AI providers during processing. This is inherent to how AI models work. Avoid including sensitive personal information (names, addresses, financial details) in your messages.',
      'We use OpenRouter as our AI gateway service. You can review their privacy practices at openrouter.ai/privacy.',
      'Our payment processor handles all payment transactions. We never receive or store your credit card number or bank details.',
    ],
  },
  {
    id: 'encryption-security',
    title: 'Encryption & Security',
    simplyPut: 'Your messages are encrypted with a key only you hold.',
    points: [
      'Your password never leaves your device. We use OPAQUE, a zero-knowledge password protocol, so our servers never receive your password.',
      'Messages are encrypted before storage using your conversation\u2019s public key. Our servers can encrypt your data but cannot decrypt it \u2014 only you hold the private key.',
      'The encryption key for your messages is derived from your password. Without your password or recovery phrase, your data is inaccessible to everyone, including us.',
      'All data in transit is protected by HTTPS/TLS encryption.',
      'If you lose both your password and your recovery phrase, your encrypted data cannot be recovered by anyone.',
    ],
  },
  {
    id: 'data-retention',
    title: 'Data Retention & Deletion',
    simplyPut:
      'Messages are stored while your account is active. You can delete conversations at any time.',
    points: [
      'Your messages are stored in encrypted form for as long as your account is active.',
      'You can delete individual conversations at any time. Deletion is permanent \u2014 deleted data cannot be recovered.',
      'Anonymized billing records (transaction amounts, dates) are retained for financial and legal compliance.',
    ],
  },
  {
    id: 'cookies-storage',
    title: 'Cookies & Storage',
    simplyPut: 'One encrypted session cookie. No trackers.',
    points: [
      'We use a single encrypted session cookie to keep you signed in. It contains no personal data.',
      'Small amounts of data are stored in your browser\u2019s local storage for UI preferences (such as sidebar state and panel width). This data never leaves your device.',
      'We do not currently use any analytics or tracking tools. We do not use third-party cookies.',
      'We do not track you regardless of your browser\u2019s Do Not Track setting, because we do not track you at all.',
    ],
  },
  {
    id: 'children',
    title: 'Children\u2019s Privacy',
    simplyPut: 'You must be 13 or older to use HushBox.',
    points: [
      'HushBox is not intended for use by anyone under the age of 13.',
      'We do not knowingly collect personal information from children under 13. If we learn that we have collected data from a child under 13, we will delete it promptly.',
      'If you are a parent or guardian and believe your child has provided us with personal information, please contact us at privacy@hushbox.ai.',
    ],
  },
  {
    id: 'policy-changes',
    title: 'Changes to This Policy',
    simplyPut: 'Changes are effective when posted.',
    points: [
      'We may update this Privacy Policy from time to time. Changes are effective when posted on this page.',
      'Your continued use of HushBox after changes are posted constitutes your acceptance of the updated policy.',
      'We encourage you to review this page periodically.',
    ],
  },
  {
    id: 'contact',
    title: 'Contact',
    simplyPut: 'Reach out anytime.',
    points: [
      `For privacy-related inquiries, contact us at ${PRIVACY_CONTACT_EMAIL}.`,
      'LOME-AI LLC, Indiana, United States.',
    ],
  },
];
