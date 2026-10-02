import { LEGAL_CONTACT_EMAIL } from '../constants.ts';
import { privacyPolicyEffectiveDate } from './effective-dates.ts';
import type { LegalSection, LegalDocumentMeta } from './types.ts';

export const PRIVACY_POLICY_META: LegalDocumentMeta = {
  title: 'Privacy Policy',
  // Resolved on access rather than assigned here: `./effective-dates.ts` states why the
  // read cannot happen when this module loads.
  get effectiveDate(): string {
    return privacyPolicyEffectiveDate();
  },
  contactEmail: LEGAL_CONTACT_EMAIL,
};

export const PRIVACY_SECTIONS: readonly LegalSection[] = [
  {
    id: 'data-collection',
    title: 'Data We Collect',
    simplyPut:
      'Email, username, encrypted messages, feedback you send us, and where your signup came from.',
    points: [
      'Account information: your email address and username, provided during registration.',
      'Acquisition source: the campaign tag your signup link carried, the platform you signed up on (web, iOS, or Android), and, if you answer it, your pick from a short fixed list when we ask where you heard about HushBox. You can skip the question; the skip is stored with your account, so we ask at most once more, after a first payment. All of it is deleted when you delete your account.',
      'Message content: stored as encrypted blobs that our servers cannot read. The encryption key is derived from your password, which never leaves your device.',
      'Your IP address: rate limiting and the website counting described under Website Measurement scramble it first, and hold only the scrambled value in a cache that is separate from our database. Two records keep the address itself: proof of your consent if you subscribe to our mailing list, which we keep for as long as that subscription record exists, and the account-deletion record described under Data Retention & Deletion, which keeps it for 90 days. When you pay by card, we also pass it to our payment processor, as described under Third-Party Services.',
      'Feedback: if you send us a bug report or a suggestion from the app, we store what you wrote with your account. Unlike your messages, it is not encrypted with your key, because we read it to act on it. It is deleted when you delete your account.',
      'Notification settings: if you set quiet hours, we store your device\u2019s time zone with your account, so the quiet window means the same thing wherever you are.',
      'Payment details: our payment processor handles the card itself. What reaches us and stays with the payment record is the card\u2019s brand and its last four digits. We never store the full number, the expiry, or bank details.',
      'When you create an account, we record which version of the Terms of Service you accepted and when.',
    ],
  },
  {
    id: 'data-usage',
    title: 'How We Use Your Data',
    simplyPut:
      'To run the service, bill you, send the newsletter if you subscribed, and publish anonymous totals. Never for ads, never sold.',
    points: [
      'Providing and operating the HushBox service, including routing your messages to AI models.',
      'Maintaining the security of your account and our infrastructure.',
      'Processing billing and maintaining financial records.',
      'Emailing you our newsletter, if you subscribed.',
      'Publishing statistics about HushBox as a whole on our leaderboard page, such as each model\u2019s share of messages. They are built from anonymized, aggregate data across all users: percentages and average costs, with no identity attached to any of it.',
      'Complying with applicable legal obligations.',
      'We do not use your data for advertising, profiling, or any purpose other than operating the service and understanding how people find it. We do not sell your data.',
    ],
  },
  {
    id: 'legal-bases',
    title: 'Legal Bases',
    simplyPut:
      'Running your account is contract; security and site counting are legitimate interest, which you can object to; the newsletter is consent; tax records are a legal duty.',
    points: [
      'Running your account, storing your conversations, sending your messages to AI models and processing your payments: these are necessary to provide the service you signed up for.',
      'Rate limiting, abuse prevention, the account-deletion record, the question about where you heard of us, and counting visits to our website: these rest on our legitimate interest in keeping HushBox secure and knowing how people find it. You can object to any of them by emailing us.',
      'The mailing list: your consent, which you can withdraw at any time.',
      'Payment and tax records kept after you delete your account: our legal obligation to keep them.',
    ],
  },
  {
    id: 'third-party-services',
    title: 'Third-Party Services',
    simplyPut:
      'AI providers see your messages but not your identity. Payment, email, push, error-report and hosting companies each get only what their job needs, and our hosts hold your messages only as ciphertext.',
    points: [
      'We route your messages through third-party AI providers to generate responses. Your messages are sent using HushBox\u2019s credentials, not yours: providers cannot identify you personally.',
      'Message content is visible to AI providers during processing. This is inherent to how AI models work. Avoid including sensitive personal information (names, addresses, financial details) in your messages.',
      'We route all AI model requests through OpenRouter, a single AI gateway that enforces zero-data-retention across providers. We never grant model providers access to your account, billing information, or long-term conversation history.',
      'Our payment processor, Helcim, handles all payment transactions. Their form runs on our page, so your card number, expiry and security code go from your browser straight to them and never reach us. We never store your full card number or bank details; what we keep is the card\u2019s brand and last four digits, with the payment record. Because their form loads from their servers, Helcim sees your IP address when you open billing, and each card payment also passes them the IP address it came from, which their system requires.',
      'Email. We send account emails and newsletter issues through Resend. They receive your email address and the contents of the message.',
      'Notifications. If you turn on push notifications, your device token and the notification text go to Google\u2019s Firebase Cloud Messaging on Android, to Apple\u2019s push service on iOS, and to your browser\u2019s own push service on the web.',
      'Web search. When a model searches the web for you, it uses Brave Search. Only the search text the model composed is sent, not your message. It is sent from our servers, so Brave receives no account, device, or IP address of yours. Under its zero data retention, Brave does not retain the search. Brave does not retain any message content or results. The results go back to the model to write its reply. The searches and the sources they found are saved with the reply, encrypted like the rest of the conversation.',
      'Error reports. When our servers hit an error that needs fixing, a report goes to Sentry. We strip each report before it leaves: it says what kind of error happened and where in our code, and carries no message content, no account details, no IP address and no request contents.',
      'Infrastructure. Our database is hosted by Neon, our cache by Upstash, and our site, our servers and our file storage by Cloudflare. Encrypted backups go to Backblaze. Cloudflare sees every request\u2019s IP address, because it sits in front of everything we run; the others hold what the service stores, which for your files and messages is only ciphertext.',
      'Runnable documents. When you run a document a model generated, your browser fetches code libraries directly from esm.sh and the Python package index. Those requests come from your browser, so those hosts see your IP address. We send them nothing.',
    ],
  },
  {
    id: 'sharing',
    title: 'Sharing',
    simplyPut:
      'Anyone you share a conversation or link with can read it, and we still can\u2019t. Revoking stops future access, not what they already saw.',
    points: [
      'You can invite other HushBox users into a conversation. Each member gets their own copy of the conversation\u2019s key and reads it on their own devices. Members you allow to write can add messages.',
      'You can also create a share link. The key that unlocks the conversation is in the part of the link after the # sign, which browsers never send to a server, so we cannot read a shared conversation either. Anyone who has the link can open the conversation until you revoke the link.',
      'A single message can be shared the same way. Anyone with its link can read that message.',
      'Removing a member or revoking a link stops their access from then on. It cannot take back what they have already read or copied.',
    ],
  },
  {
    id: 'encryption-security',
    title: 'Encryption & Security',
    simplyPut:
      'Your messages are encrypted with keys that only you, and the people you share a conversation with, hold.',
    points: [
      'Your password never leaves your device. We use OPAQUE, a zero-knowledge password protocol, so our servers never receive your password.',
      'Messages are encrypted before storage using your conversation\u2019s public key. Our servers can encrypt your data but cannot decrypt it: only you, and anyone you share the conversation with, hold the private key.',
      'The encryption key for your messages is derived from your password. Without your password or recovery phrase, your data is inaccessible to everyone, including us.',
      'All data in transit is protected by HTTPS/TLS encryption.',
      'If you lose both your password and your recovery phrase, your encrypted data cannot be recovered by anyone.',
      'If a security breach exposes your personal data, we will tell you by email without undue delay, and notify regulators where the law requires it.',
    ],
  },
  {
    id: 'data-retention',
    title: 'Data Retention & Deletion',
    simplyPut:
      'You can delete your account at any time. Your messages and personal data are erased, and encrypted backup copies expire within 90 days. What outlives the account: billing history, with your account link removed but the amount, date, card brand and last four of each payment intact; proof of your mailing-list consent if you subscribed; and a record of the deletion itself, which holds for 90 days the IP address the request came from.',
    points: [
      'You can delete your account at any time from Settings, in the app or at hushbox.ai in any web browser.',
      'When you delete your account, we remove what is tied to it from our live systems, including your conversations, files, custom instructions, and the locked copies of your encryption keys. The records that outlive it are named below.',
      'We keep records of past payments and credit usage after an account is deleted: the amounts, the dates, and the card\u2019s brand and last four digits remain, with your account link removed. We keep these to meet legal and tax requirements.',
      'Messages you sent in a conversation someone else owns are deleted when you delete your account, and the other members see that a message was removed. Replies to them stay in the conversation, including the AI\u2019s, and may repeat what you wrote. What the other members already read stays with them. A conversation you own is deleted for every member. Every share link you created stops working.',
      'If you subscribed to our mailing list, that subscription record outlives your account. It holds the email address the issues go to, whether you subscribed on our website or in the app, when you confirmed, which version of our sign-up wording you were shown, and the IP address your most recent subscription request came from. It is our evidence that you opted in, so we keep it for as long as the subscription record exists, including after you unsubscribe. Unsubscribing stops the emails and leaves the record in place. If you sign up on our website and never confirm, the record, address included, is deleted within three days.',
      'We keep encrypted backups of our database and your stored files for disaster recovery. A backup made before a deletion still holds the deleted data, encrypted, for up to 90 days; after that, no backup holds it. The same lock applies inside a backup: your conversations and files stay unreadable without your password or recovery phrase, and the locked keys expire with it. Your email address and username are held in the backup like any other database row, and expire on the same schedule.',
      'We keep a record of the deletion event itself for 90 days so we can help if you contact us about it. It is not linked to your account, but it does hold the time, the IP address the request came from, and the line your browser sends describing itself.',
    ],
  },
  {
    id: 'your-rights',
    title: 'Your Rights',
    simplyPut: `Email ${LEGAL_CONTACT_EMAIL} for a copy of your data, or to have it corrected, deleted or no longer used. We reply within one month.`,
    points: [
      `You can ask us for a copy of the personal data we hold about you, and ask us to correct it, delete it, or stop using it. Email us at ${LEGAL_CONTACT_EMAIL}. We reply within one month.`,
      'Your conversations and files are encrypted with keys we do not have, so we cannot read them or include them in a copy. You can read them in the app yourself.',
      'If you are in the European Economic Area or the United Kingdom, you can also complain to your local data protection authority.',
    ],
  },
  {
    id: 'cookies-storage',
    title: 'Cookies & Storage',
    simplyPut:
      'Two encrypted cookies: one keeps you signed in, one is used when you open billing from the mobile app. No third-party trackers.',
    points: [
      'We use an encrypted session cookie to keep you signed in. Only our servers can read it.',
      'Opening billing from the mobile app sets a second encrypted cookie. It is a separate credential from your sign-in, it is sent only to the billing part of our service, and it expires an hour after it is issued.',
      'When you sign in, your browser keeps a marker saying which account is signed in, and the key that unlocks your messages without asking for your password again. That key is itself encrypted. Your browser holds the key that opens it and will not hand that key back to anything, including our own code. Neither leaves your device.',
      'If you try HushBox without an account, your browser keeps a random identifier for that trial. It is created the first time you send a message, never just for visiting, and it is sent with your trial messages so we can apply the limits on the free trial. It is not tied to any account. It is also stored with the record of each trial message and removed a week after that message finishes.',
      'Your browser also remembers your own settings and where you left off, such as your theme, the models you picked, and panel sizes. Some of these stay on your device; others, such as your accessibility settings and the notices you have dismissed, are saved to your account so they follow you to your other devices.',
      'We use no third-party analytics service and no third-party cookies. We measure our own public website ourselves, as described under Website Measurement.',
      'We do not read your browser\u2019s Do Not Track setting, because we do not track you across sites.',
    ],
  },
  {
    id: 'website-measurement',
    title: 'Website Measurement',
    simplyPut:
      'We count visits to our public website with our own counter, to learn which pages and links bring people here. It stores nothing on your device, and none of what it keeps is tied to your account.',
    points: [
      'We measure our public website, the marketing pages and the blog, with a counter we wrote and run ourselves. It is there to tell us which pages people read and which links bring them to HushBox. No third-party analytics service runs on our website or in the app.',
      'Each page sends us a short message: whether this is a page view or something you did, the path you are on, the hostname of the site that linked you there, the campaign tag in the link you followed, and, for something you did, the name of the link or button you clicked or the scroll depth you passed. That is the whole message: no query strings, no full referring URL, nothing you type.',
      'It stores nothing on your device and reads nothing from it: no cookie, no local storage, no identifier of any kind. The campaign tag sits in the address bar and goes away with the tab.',
      'Every web request also carries your IP address and the line your browser sends describing itself. To count you once rather than once per page, we scramble those two into a daily visitor code, under a secret key that changes every day, so one day\u2019s code cannot be matched to the next day\u2019s. We never keep the address it was made from, and the code is never written to a log.',
      'The code is held only in our cache, which is separate from our database, and only inside the hourly and daily tallies it was counted into. Each tally is cleared 36 hours after the last visit counted into it, so a code is never held longer than two and a half days.',
      'Inside a single day, the code is also what links the page you arrived on to the pages you go on to read: if you arrive on one page and then read another, we add one to the number of people who made that same move that day. The code expires on the same schedule; the counts stay, and we keep them for good.',
      'What we keep are counts, never a list of people. For each hour and for each day: how many people visited, how many visited each page, and how many of them started on that page. For the same hours and days we keep which sites linked them there, which campaign tag they arrived under, and the country, the US state, and the device family (desktop, mobile, tablet, or other) the request came from. For each hour we also keep how many people clicked each link or button and passed each scroll depth on each page, under the campaign tag they arrived with, and how many clicked through into the app. These rows hold no code and no identifier, and we keep them for good.',
      'We also count how many people begin creating an account each hour, under the campaign tag they arrived with. That count is kept under a scrambled form of the address the request came from, the same value our rate limiting uses. It is not scrambled under a secret and does not change from day to day, so it hides the address less well than the visitor code does. It is held in our cache on the same schedule and never written to our database; what outlives it is the count, and we keep those counts for good.',
      'None of this is connected to an account. The counter never looks at whether you are signed in, and nothing it keeps says who anyone is.',
    ],
  },
  {
    id: 'children',
    title: 'Children\u2019s Privacy',
    simplyPut:
      'You must be 13 or older to use HushBox, or older where your local law sets a higher age.',
    points: [
      'HushBox is not intended for use by anyone under the age of 13.',
      'If the law where you live sets a higher age for agreeing to online services on your own, as some European Union countries do at 16, you must be at least that age.',
      'We do not knowingly collect personal information from children under 13. If we learn that we have collected data from a child under 13, we will delete it promptly.',
      `If you are a parent or guardian and believe your child has provided us with personal information, please contact us at ${LEGAL_CONTACT_EMAIL}.`,
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
    simplyPut: `Email ${LEGAL_CONTACT_EMAIL}. LOME-AI LLC, based in Indiana, is responsible for your data, which is processed in the United States.`,
    points: [
      `For privacy-related inquiries, contact us at ${LEGAL_CONTACT_EMAIL}.`,
      'LOME-AI LLC, Indiana, United States, decides how your personal data is used and is responsible for it (the \u201Ccontroller\u201D under European data protection law).',
      'We are based in the United States, and your data is processed there and by the companies named under Third-Party Services.',
    ],
  },
];

// Published legal text: frozen so no importer can rewrite what the site serves. The freeze
// backs a readonly declared type, which rejects a static mutation before it can run.
for (const section of PRIVACY_SECTIONS) {
  Object.freeze(section.points);
  Object.freeze(section);
}
Object.freeze(PRIVACY_SECTIONS);
