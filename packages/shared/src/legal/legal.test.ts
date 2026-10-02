// Document meta fields are pinned to literals, never to the constants they are assigned
// from: an assertion against its own source cannot catch a silent edit to that source.
// The effective date is the exception, because it is no longer typed: it is derived from
// the release that first shipped the document's current revision and injected by the
// build, so there is no approved literal to pin. What it is pinned to instead is the
// injection itself — the date a stubbed variable produces — which is what a literal
// written back into the source would fail. A silent edit to the published copy runs into
// the pinned copy digest.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PRIVACY_POLICY_META,
  PRIVACY_SECTIONS,
  TERMS_OF_SERVICE_META,
  TERMS_SECTIONS,
} from './index.ts';
import { legalCopyDigest } from './copy-digest.ts';
import { PRIVACY_POLICY_COPY_DIGEST, TERMS_OF_SERVICE_COPY_DIGEST } from '../constants.ts';
import {
  MEDIA_STORAGE_COST_PER_BYTE,
  STORAGE_COST_PER_1K_CHARS,
  TOTAL_FEE_RATE,
} from '../affordability/constants.ts';
import {
  ALL_FEE_CATEGORIES,
  FEE_CATEGORIES,
  formatFeePercent,
} from '../affordability/money/fees.ts';
import type { LegalDocumentMeta, LegalSection } from './types.ts';

// Retention claims are pinned per point and on the section's own summary line, never
// against the flattened document: a whole-document match is satisfied by any point that
// happens to carry both phrases, so it stays green while the claim it was written for is
// gone. Each needle is the clause carrying the commitment rather than the number alone,
// because a number can be moved into a neighbouring sentence that promises nothing, and
// each runs to its sentence terminator, because a substring match survives a clause
// appended after it — which is how a published limit gets reversed while its assertion
// stays green.
function retentionSection(): LegalSection {
  const section = PRIVACY_SECTIONS.find((s) => s.id === 'data-retention');
  expect(section).toBeDefined();
  return section!;
}

function retentionPointMatching(needle: string): string {
  const matches = retentionSection().points.filter((p) => p.toLowerCase().includes(needle));
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

function retentionPointContaining(needle: string): string {
  return retentionPointMatching(needle).toLowerCase();
}

// The founder-approved retention lines are pinned by exact equality as well as by the
// clause needles above them. A needle that runs to its sentence terminator still admits a
// sentence appended after it or a clause slipped between two sentences, either of which can
// reverse a published limit; only equality sees text that was added rather than rewritten.
// A copyedit is meant to fail here until the pin is updated with the new wording approved.
// Each pin selects its single point and compares strings, never `toContain` against the points
// array: array containment renders as a collapsed array and a truncated expected string, naming
// none of the changed text, while a string comparison prints both lines in full and the editor
// sees the edit itself.
const APPROVED_RETENTION_SUMMARY =
  'You can delete your account at any time. Your messages and personal data are erased, and encrypted backup copies expire within 90 days. What outlives the account: billing history, with your account link removed but the amount, date, card brand and last four of each payment intact; proof of your mailing-list consent if you subscribed; and a record of the deletion itself, which holds for 90 days the IP address the request came from.';

const APPROVED_ACCOUNT_DELETION_POINT =
  'When you delete your account, we remove what is tied to it from our live systems, including your conversations, files, custom instructions, and the locked copies of your encryption keys. The records that outlive it are named below.';

const APPROVED_BACKUP_POINT =
  'We keep encrypted backups of our database and your stored files for disaster recovery. A backup made before a deletion still holds the deleted data, encrypted, for up to 90 days; after that, no backup holds it. The same lock applies inside a backup: your conversations and files stay unreadable without your password or recovery phrase, and the locked keys expire with it. Your email address and username are held in the backup like any other database row, and expire on the same schedule.';

// The measurement section is pinned whole rather than point by point. Its points are one
// disclosure read top to bottom — what runs, what it sends, what it stores, what identity it
// counts under, what is kept, and what it is never joined to — so their ORDER and their COUNT
// carry meaning that per-point equality cannot see: a point deleted, or two swapped, leaves
// every surviving pin green while the disclosure reads as something else.
function measurementSection(): LegalSection {
  const section = PRIVACY_SECTIONS.find((s) => s.id === 'website-measurement');
  expect(section).toBeDefined();
  return section!;
}

function measurementText(): string {
  const section = measurementSection();
  return [section.title, section.simplyPut, ...section.points].join(' ').toLowerCase();
}

const APPROVED_MEASUREMENT_SUMMARY =
  'We count visits to our public website with our own counter, to learn which pages and links bring people here. It stores nothing on your device, and none of what it keeps is tied to your account.';

const APPROVED_MEASUREMENT_POINTS: readonly string[] = [
  'We measure our public website, the marketing pages and the blog, with a counter we wrote and run ourselves. It is there to tell us which pages people read and which links bring them to HushBox. No third-party analytics service runs on our website or in the app.',
  'Each page sends us a short message: whether this is a page view or something you did, the path you are on, the hostname of the site that linked you there, the campaign tag in the link you followed, and, for something you did, the name of the link or button you clicked or the scroll depth you passed. That is the whole message: no query strings, no full referring URL, nothing you type.',
  'It stores nothing on your device and reads nothing from it: no cookie, no local storage, no identifier of any kind. The campaign tag sits in the address bar and goes away with the tab.',
  'Every web request also carries your IP address and the line your browser sends describing itself. To count you once rather than once per page, we scramble those two into a daily visitor code, under a secret key that changes every day, so one day\u2019s code cannot be matched to the next day\u2019s. We never keep the address it was made from, and the code is never written to a log.',
  'The code is held only in our cache, which is separate from our database, and only inside the hourly and daily tallies it was counted into. Each tally is cleared 36 hours after the last visit counted into it, so a code is never held longer than two and a half days.',
  'Inside a single day, the code is also what links the page you arrived on to the pages you go on to read: if you arrive on one page and then read another, we add one to the number of people who made that same move that day. The code expires on the same schedule; the counts stay, and we keep them for good.',
  'What we keep are counts, never a list of people. For each hour and for each day: how many people visited, how many visited each page, and how many of them started on that page. For the same hours and days we keep which sites linked them there, which campaign tag they arrived under, and the country, the US state, and the device family (desktop, mobile, tablet, or other) the request came from. For each hour we also keep how many people clicked each link or button and passed each scroll depth on each page, under the campaign tag they arrived with, and how many clicked through into the app. These rows hold no code and no identifier, and we keep them for good.',
  'We also count how many people begin creating an account each hour, under the campaign tag they arrived with. That count is kept under a scrambled form of the address the request came from, the same value our rate limiting uses. It is not scrambled under a secret and does not change from day to day, so it hides the address less well than the visitor code does. It is held in our cache on the same schedule and never written to our database; what outlives it is the count, and we keep those counts for good.',
  'None of this is connected to an account. The counter never looks at whether you are signed in, and nothing it keeps says who anyone is.',
];

// `payments.card_type` and `payments.card_last_four` (`packages/db/src/schema/payments.ts`) are
// written on the charge path and survive a deletion, which nulls only the user reference. The
// three payment sentences are pinned because each one previously claimed less was kept than is.
// None of them says what the provider's response hands us: whether its card-number field
// arrives masked is a fact about that API, not one this repository settles.
const APPROVED_COLLECTION_PAYMENT_POINT =
  'Payment details: our payment processor handles the card itself. What reaches us and stays with the payment record is the card\u2019s brand and its last four digits. We never store the full number, the expiry, or bank details.';

// The billing form loads Helcim's script from `secure.myhelcim.com` (the one third-party script
// host in `scripts/generate-headers.ts`), and the purchase route passes the caller's address to
// Helcim (`apps/api/src/slices/billing/routes.ts`), so the point says Helcim sees it both ways.
const APPROVED_THIRD_PARTY_PAYMENT_POINT =
  'Our payment processor, Helcim, handles all payment transactions. Their form runs on our page, so your card number, expiry and security code go from your browser straight to them and never reach us. We never store your full card number or bank details; what we keep is the card\u2019s brand and last four digits, with the payment record. Because their form loads from their servers, Helcim sees your IP address when you open billing, and each card payment also passes them the IP address it came from, which their system requires.';

// The founder-approved wording of the web-search disclosure.
const APPROVED_WEB_SEARCH_POINT =
  'Web search. When a model searches the web for you, it uses Brave Search. Only the search text the model composed is sent, not your message. It is sent from our servers, so Brave receives no account, device, or IP address of yours. Under its zero data retention, Brave does not retain the search. Brave does not retain any message content or results. The results go back to the model to write its reply. The searches and the sources they found are saved with the reply, encrypted like the rest of the conversation.';

const APPROVED_RETENTION_PAYMENTS_POINT =
  'We keep records of past payments and credit usage after an account is deleted: the amounts, the dates, and the card\u2019s brand and last four digits remain, with your account link removed. We keep these to meet legal and tax requirements.';

const APPROVED_ACQUISITION_POINT =
  'Acquisition source: the campaign tag your signup link carried, the platform you signed up on (web, iOS, or Android), and, if you answer it, your pick from a short fixed list when we ask where you heard about HushBox. You can skip the question; the skip is stored with your account, so we ask at most once more, after a first payment. All of it is deleted when you delete your account.';

const APPROVED_TERMS_ACCEPTANCE_POINT =
  'When you create an account, we record which version of the Terms of Service you accepted and when.';

// `notification_preferences.timezone` (`packages/db/src/schema/notification-preferences.ts`) is
// held against `user_id` and a CHECK makes it mandatory once a quiet-hours window is set; the
// value is the device's own zone, read by the web app's settings page, in its Notifications
// group, when a quiet-hours bound is written.
// A zone name is coarse location against an identified person, so it is published as its own
// collection point.
const APPROVED_NOTIFICATION_SETTINGS_POINT =
  'Notification settings: if you set quiet hours, we store your device\u2019s time zone with your account, so the quiet window means the same thing wherever you are.';

const APPROVED_COLLECTION_SUMMARY =
  'Email, username, encrypted messages, feedback you send us, and where your signup came from.';

const APPROVED_IP_POINT =
  'Your IP address: rate limiting and the website counting described under Website Measurement scramble it first, and hold only the scrambled value in a cache that is separate from our database. Two records keep the address itself: proof of your consent if you subscribe to our mailing list, which we keep for as long as that subscription record exists, and the account-deletion record described under Data Retention & Deletion, which keeps it for 90 days. When you pay by card, we also pass it to our payment processor, as described under Third-Party Services.';

const APPROVED_COOKIES_SUMMARY =
  'Two encrypted cookies: one keeps you signed in, one is used when you open billing from the mobile app. No third-party trackers.';

// `apps/api/src/lib/context/principal.ts` declares both cookie names the product Worker
// seals, `SESSION_COOKIE_NAME` and `BILLING_PORTAL_COOKIE_NAME`, and no other module writes
// a cookie. The summary claims that set, so the second one is published as its own point.
const APPROVED_BILLING_COOKIE_POINT =
  'Opening billing from the mobile app sets a second encrypted cookie. It is a separate credential from your sign-in, it is sent only to the billing part of our service, and it expires an hour after it is issued.';

// The signed-in app writes an account id into Web Storage and the export key, encrypted
// under a non-extractable per-device key, into IndexedDB (`apps/web/src/lib/auth/client.ts`,
// `apps/web/src/lib/device-key-store.ts`). Calling all of it interface preferences was the
// same overstatement the removed "to recognize you" promise made.
const APPROVED_SIGNED_IN_STORAGE_POINT =
  'When you sign in, your browser keeps a marker saying which account is signed in, and the key that unlocks your messages without asking for your password again. That key is itself encrypted. Your browser holds the key that opens it and will not hand that key back to anything, including our own code. Neither leaves your device.';

const APPROVED_PREFERENCES_STORAGE_POINT =
  'Your browser also remembers your own settings and where you left off, such as your theme, the models you picked, and panel sizes. Some of these stay on your device; others, such as your accessibility settings and the notices you have dismissed, are saved to your account so they follow you to your other devices.';

// `getTrialToken` in `apps/web/src/lib/chat/trial-token.ts` mints a `crypto.randomUUID()` into
// Web Storage and is called on the send path alone; `peekTrialToken` is the display read that
// deliberately does not mint. That split is what makes the published "never just for visiting"
// true, so it is pinned here rather than left to the digest.
//
// The server-side half: `resolveTrialSessionPrincipal`
// (`apps/api/src/slices/identity/domain/trial-session.ts`) adopts a well-formed token as the
// trial principal, which scopes the turn's `idempotency_keys` row, and
// `IDEMPOTENCY_PURGE_TTL_SECONDS` (`apps/api/src/lib/idempotency/config.ts`) holds a terminal
// row for seven days past completion. That pair is what the published week is measured from.
const APPROVED_TRIAL_IDENTIFIER_POINT =
  'If you try HushBox without an account, your browser keeps a random identifier for that trial. It is created the first time you send a message, never just for visiting, and it is sent with your trial messages so we can apply the limits on the free trial. It is not tied to any account. It is also stored with the record of each trial message and removed a week after that message finishes.';

// The measurement the sentence points at is `createGrowthManifest` in
// `apps/api/src/slices/growth/routes.ts`, the single public write path the marketing beacon
// emitted by `growthInitScript` (`packages/ui/src/components/growth/init-script.ts`) posts to.
// What it counts and keeps is published in the Privacy Policy's `website-measurement` section,
// so the Terms carry the pointer rather than a second copy free to drift from it.
const APPROVED_MEASUREMENT_POINTER =
  'HushBox measures its own public website. What is counted and what is kept are described in the Privacy Policy.';

// `feedback.body` is plain `text` held against `user_id` with a cascade delete
// (`packages/db/src/schema/feedback.ts`), the one piece of user writing the server stores readable.
const APPROVED_FEEDBACK_POINT =
  'Feedback: if you send us a bug report or a suggestion from the app, we store what you wrote with your account. Unlike your messages, it is not encrypted with your key, because we read it to act on it. It is deleted when you delete your account.';

const APPROVED_USAGE_SUMMARY =
  'To run the service, bill you, send the newsletter if you subscribed, and publish anonymous totals. Never for ads, never sold.';

const APPROVED_NEWSLETTER_USE_POINT = 'Emailing you our newsletter, if you subscribed.';

const APPROVED_LEADERBOARD_POINT =
  'Publishing statistics about HushBox as a whole on our leaderboard page, such as each model\u2019s share of messages. They are built from anonymized, aggregate data across all users: percentages and average costs, with no identity attached to any of it.';

const APPROVED_THIRD_PARTY_SUMMARY =
  'AI providers see your messages but not your identity. Payment, email, push, error-report and hosting companies each get only what their job needs, and our hosts hold your messages only as ciphertext.';

// The Sentry `beforeSend` scrub rebuilds each event from an allowlist that drops user, headers,
// cookies, bodies and error messages (`apps/api/src/lib/telemetry/adapters/sentry-scrub.ts`),
// which is what the point's list of what a report carries rests on.
const APPROVED_ERROR_REPORTS_POINT =
  'Error reports. When our servers hit an error that needs fixing, a report goes to Sentry. We strip each report before it leaves: it says what kind of error happened and where in our code, and carries no message content, no account details, no IP address and no request contents.';

const APPROVED_ENCRYPTION_SUMMARY =
  'Your messages are encrypted with keys that only you, and the people you share a conversation with, hold.';

const APPROVED_ENCRYPTION_KEY_POINT =
  'Messages are encrypted before storage using your conversation\u2019s public key. Our servers can encrypt your data but cannot decrypt it: only you, and anyone you share the conversation with, hold the private key.';

const APPROVED_BREACH_POINT =
  'If a security breach exposes your personal data, we will tell you by email without undue delay, and notify regulators where the law requires it.';

const APPROVED_DELETION_ROUTE_POINT =
  'You can delete your account at any time from Settings, in the app or at hushbox.ai in any web browser.';

const APPROVED_FOREIGN_MESSAGES_POINT =
  'Messages you sent in a conversation someone else owns are deleted when you delete your account, and the other members see that a message was removed. Replies to them stay in the conversation, including the AI\u2019s, and may repeat what you wrote. What the other members already read stays with them. A conversation you own is deleted for every member. Every share link you created stops working.';

// A resend or a reopen overwrites the consent columns with the latest request
// (`apps/api/src/slices/newsletter/domain/subscribe.ts`), so the point names the most recent
// request's address; and `purgeUnconfirmedSubscribers`
// (`apps/api/src/slices/newsletter/adapters/subscriber-retention.ts`) removes a pending row a day
// after its day-long confirm link expires, on the daily retention pass, hence "within three days".
const APPROVED_MAILING_LIST_POINT =
  'If you subscribed to our mailing list, that subscription record outlives your account. It holds the email address the issues go to, whether you subscribed on our website or in the app, when you confirmed, which version of our sign-up wording you were shown, and the IP address your most recent subscription request came from. It is our evidence that you opted in, so we keep it for as long as the subscription record exists, including after you unsubscribe. Unsubscribing stops the emails and leaves the record in place. If you sign up on our website and never confirm, the record, address included, is deleted within three days.';

const APPROVED_CHILDREN_SUMMARY =
  'You must be 13 or older to use HushBox, or older where your local law sets a higher age.';

const APPROVED_CHILDREN_LOCAL_AGE_POINT =
  'If the law where you live sets a higher age for agreeing to online services on your own, as some European Union countries do at 16, you must be at least that age.';

const APPROVED_CONTACT_SUMMARY =
  'Email legal@hushbox.ai. LOME-AI LLC, based in Indiana, is responsible for your data, which is processed in the United States.';

const APPROVED_CONTACT_POINTS: readonly string[] = [
  'For privacy-related inquiries, contact us at legal@hushbox.ai.',
  'LOME-AI LLC, Indiana, United States, decides how your personal data is used and is responsible for it (the \u201Ccontroller\u201D under European data protection law).',
  'We are based in the United States, and your data is processed there and by the companies named under Third-Party Services.',
];

const APPROVED_PRIVACY_SECTION_ORDER: readonly string[] = [
  'data-collection',
  'data-usage',
  'legal-bases',
  'third-party-services',
  'sharing',
  'encryption-security',
  'data-retention',
  'your-rights',
  'cookies-storage',
  'website-measurement',
  'children',
  'policy-changes',
  'contact',
];

// Sections added whole are pinned whole, summary and points in order, for the reason the
// measurement section is: a point dropped or reordered leaves every per-point pin green.
const APPROVED_WHOLE_PRIVACY_SECTIONS: Readonly<
  Record<string, { readonly simplyPut: string; readonly points: readonly string[] }>
> = {
  'legal-bases': {
    simplyPut:
      'Running your account is contract; security and site counting are legitimate interest, which you can object to; the newsletter is consent; tax records are a legal duty.',
    points: [
      'Running your account, storing your conversations, sending your messages to AI models and processing your payments: these are necessary to provide the service you signed up for.',
      'Rate limiting, abuse prevention, the account-deletion record, the question about where you heard of us, and counting visits to our website: these rest on our legitimate interest in keeping HushBox secure and knowing how people find it. You can object to any of them by emailing us.',
      'The mailing list: your consent, which you can withdraw at any time.',
      'Payment and tax records kept after you delete your account: our legal obligation to keep them.',
    ],
  },
  sharing: {
    simplyPut:
      'Anyone you share a conversation or link with can read it, and we still can\u2019t. Revoking stops future access, not what they already saw.',
    points: [
      'You can invite other HushBox users into a conversation. Each member gets their own copy of the conversation\u2019s key and reads it on their own devices. Members you allow to write can add messages.',
      'You can also create a share link. The key that unlocks the conversation is in the part of the link after the # sign, which browsers never send to a server, so we cannot read a shared conversation either. Anyone who has the link can open the conversation until you revoke the link.',
      'A single message can be shared the same way. Anyone with its link can read that message.',
      'Removing a member or revoking a link stops their access from then on. It cannot take back what they have already read or copied.',
    ],
  },
  'your-rights': {
    simplyPut:
      'Email legal@hushbox.ai for a copy of your data, or to have it corrected, deleted or no longer used. We reply within one month.',
    points: [
      'You can ask us for a copy of the personal data we hold about you, and ask us to correct it, delete it, or stop using it. Email us at legal@hushbox.ai. We reply within one month.',
      'Your conversations and files are encrypted with keys we do not have, so we cannot read them or include them in a copy. You can read them in the app yourself.',
      'If you are in the European Economic Area or the United Kingdom, you can also complain to your local data protection authority.',
    ],
  },
};

const APPROVED_DELETION_EVENT_POINT =
  'We keep a record of the deletion event itself for 90 days so we can help if you contact us about it. It is not linked to your account, but it does hold the time, the IP address the request came from, and the line your browser sends describing itself.';

/** The whole rendered document, lowercased: what a reader of every section sees. */
function privacyText(): string {
  return PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points])
    .join(' ')
    .toLowerCase();
}

function privacySection(id: string): LegalSection {
  const section = PRIVACY_SECTIONS.find((s) => s.id === id);
  expect(section).toBeDefined();
  return section!;
}

// Beside the injection pin: that the published day is a real calendar day. The round-trip
// rejects both an unparseable string and one that silently rolls over to a neighbouring
// month.
function expectWellFormedDate(value: string): void {
  expect(value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const parsed = new Date(`${value}T00:00:00Z`);
  expect(Number.isNaN(parsed.getTime())).toBe(false);
  expect(parsed.toISOString().slice(0, 10)).toBe(value);
}

function assertValidSections(sections: readonly LegalSection[]): void {
  const ids = sections.map((s) => s.id);
  const uniqueIds = new Set(ids);

  it('has no duplicate IDs', () => {
    expect(ids.length).toBe(uniqueIds.size);
  });

  for (const section of sections) {
    describe(section.id, () => {
      it('has a non-empty title', () => {
        expect(section.title.length).toBeGreaterThan(0);
      });

      it('has a non-empty simplyPut summary', () => {
        expect(section.simplyPut.length).toBeGreaterThan(0);
      });

      it('has at least one point', () => {
        expect(section.points.length).toBeGreaterThan(0);
      });

      it('has non-empty points', () => {
        for (const point of section.points) {
          expect(point.length).toBeGreaterThan(0);
        }
      });

      it('has an id matching kebab-case format', () => {
        expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/);
      });
    });
  }
}

/**
 * The metadata a build that injected `date` would publish. The date is resolved
 * when it is read, so stubbing the variable and reading the property is what
 * tells an injected date from one written in this repository — the only
 * difference a check on the date's own shape cannot see, since a typed literal
 * satisfies every such check.
 */
function effectiveDateUnder(key: string, date: string, meta: LegalDocumentMeta): string {
  vi.stubEnv(key, date);
  return meta.effectiveDate;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('Privacy Policy', () => {
  describe('PRIVACY_POLICY_META', () => {
    it('has the correct title', () => {
      expect(PRIVACY_POLICY_META.title).toBe('Privacy Policy');
    });

    it('carries a well-formed effective date', () => {
      expectWellFormedDate(PRIVACY_POLICY_META.effectiveDate);
    });

    it('publishes the date the build injected, never one written in this repository', () => {
      const published = effectiveDateUnder(
        'VITE_PRIVACY_POLICY_EFFECTIVE_DATE',
        '2017-08-09',
        PRIVACY_POLICY_META
      );

      expect(published).toBe('2017-08-09');
    });

    it('publishes legal@hushbox.ai as the contact address', () => {
      expect(PRIVACY_POLICY_META.contactEmail).toBe('legal@hushbox.ai');
    });
  });

  describe('PRIVACY_SECTIONS', () => {
    it('publishes the sections in the approved order', () => {
      expect(PRIVACY_SECTIONS.map((s) => s.id)).toEqual(APPROVED_PRIVACY_SECTION_ORDER);
    });

    it('starts with data-collection section', () => {
      expect(PRIVACY_SECTIONS[0]!.id).toBe('data-collection');
    });

    it('ends with contact section', () => {
      expect(PRIVACY_SECTIONS.at(-1)!.id).toBe('contact');
    });

    it('includes encryption-security section', () => {
      const section = PRIVACY_SECTIONS.find((s) => s.id === 'encryption-security');
      expect(section).toBeDefined();
    });

    assertValidSections(PRIVACY_SECTIONS);
  });

  describe('content constraints', () => {
    it('does not mention iron-session', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('iron-session');
    });

    it('does not mention PostHog', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('posthog');
    });

    it('does not promise data export', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('export your data');
    });

    it('promises account deletion in plain language', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).toContain('delete your account');
    });

    it('summarizes the 90-day backup expiry in the retention section', () => {
      expect(retentionSection().simplyPut.toLowerCase()).toContain(
        'encrypted backup copies expire within 90 days.'
      );
    });

    it('publishes an account-deletion right available at any time', () => {
      expect(retentionSection().simplyPut.toLowerCase()).toContain(
        'you can delete your account at any time.'
      );
    });

    it('erases messages and personal data on deletion', () => {
      expect(retentionSection().simplyPut.toLowerCase()).toContain(
        'your messages and personal data are erased, and encrypted backup copies expire within 90 days.'
      );
    });

    // The summary enumerates what outlives a deletion rather than counting it: `payments`
    // (`packages/db/src/schema/payments.ts`) nulls only `user_id` and keeps the amount, the
    // date and the card's brand and last four, so it holds something of the person beside
    // `newsletter_subscribers` and `account_deletion_events`. A number in this sentence
    // would have to be edited every time that set changed.
    it('names each thing that outlives a deletion in the summary', () => {
      expect(retentionSection().simplyPut.toLowerCase()).toContain(
        'what outlives the account: billing history, with your account link removed but the amount, date, card brand and last four of each payment intact; proof of your mailing-list consent if you subscribed; and a record of the deletion itself, which holds for 90 days the ip address the request came from.'
      );
    });

    it('does not count the records that outlive a deletion', () => {
      expect(retentionSection().simplyPut.toLowerCase()).not.toContain(
        'records keep something of yours'
      );
    });

    it('publishes a 90-day limit on the deletion-event record', () => {
      expect(retentionPointContaining('deletion event')).toContain(
        'we keep a record of the deletion event itself for 90 days so we can help if you contact us about it.'
      );
    });

    // The row holds a raw address and a raw user-agent string beside the deletion time, with
    // no account reference (`packages/db/src/schema/account-deletion-events.ts`). Unlinked
    // from an account is not anonymized, so the point names what it holds and the word that
    // claimed otherwise is asserted gone.
    it('does not call the deletion-event record anonymized', () => {
      expect(retentionPointContaining('deletion event')).not.toContain('anonymized record');
    });

    it('discloses what the deletion-event record holds', () => {
      expect(retentionPointContaining('deletion event')).toContain(
        'it does hold the time, the ip address the request came from, and the line your browser sends describing itself.'
      );
    });

    it('publishes the approved deletion-event point verbatim', () => {
      expect(retentionPointMatching('deletion event')).toBe(APPROVED_DELETION_EVENT_POINT);
    });

    it('publishes a 90-day limit on deleted data held inside backups', () => {
      expect(retentionPointContaining('backup')).toContain(
        'a backup made before a deletion still holds the deleted data, encrypted, for up to 90 days; after that, no backup holds it.'
      );
    });

    it('expires the locked keys with the backup that holds them', () => {
      expect(retentionPointContaining('backup')).toContain(
        'recovery phrase, and the locked keys expire with it.'
      );
    });

    it('covers stored files as well as the database in the backup promise', () => {
      expect(retentionPointContaining('backup')).toContain(
        'we keep encrypted backups of our database and your stored files for disaster recovery.'
      );
    });

    it('limits the published backup purpose to disaster recovery', () => {
      expect(retentionPointContaining('backup')).toContain('files for disaster recovery.');
    });

    it('promises conversations and files inside a backup stay unreadable without the password or recovery phrase', () => {
      expect(retentionPointContaining('backup')).toContain(
        'the same lock applies inside a backup: your conversations and files stay unreadable without your password or recovery phrase, and the locked keys expire with it.'
      );
    });

    // The lock the point publishes stops at the content. `email` and `username` are stored as
    // `text` and `varchar` in `packages/db/src/schema/users.ts`, so a restore of a pre-deletion
    // snapshot yields them in the clear to whoever holds the repository password; these two
    // assertions are what keep the published copy saying so.
    it('discloses that a backup holds the account record like any other database row', () => {
      expect(retentionPointContaining('backup')).toContain(
        'your email address and username are held in the backup like any other database row, and expire on the same schedule.'
      );
    });

    it('expires the account record held in a backup on the same schedule as the backup', () => {
      expect(retentionPointContaining('backup')).toContain(
        'like any other database row, and expire on the same schedule.'
      );
    });

    it('removes every listed category of stored data from live systems on deletion', () => {
      expect(retentionPointContaining('when you delete your account, we remove')).toContain(
        'when you delete your account, we remove what is tied to it from our live systems, including your conversations, files, custom instructions, and the locked copies of your encryption keys.'
      );
    });

    // The deletion point points forward rather than promising in place, so the pointer has to
    // resolve: every record the section's summary says outlives the account is named in a point
    // BELOW it. Asserted over the tail alone, because a point above the pointer is not below it,
    // and a whole-section match would stay green if the named records moved above.
    it('names each record that outlives the account below the deletion point', () => {
      const points = retentionSection().points.map((p) => p.toLowerCase());
      const below = points.slice(points.findIndex((p) => p.startsWith('when you delete')) + 1);
      const text = below.join(' ');
      expect(text).toContain('records of past payments and credit usage');
      expect(text).toContain('that subscription record outlives your account');
      expect(text).toContain('we keep encrypted backups of our database and your stored files');
      expect(text).toContain('a record of the deletion event itself');
    });

    it('publishes the approved retention summary verbatim', () => {
      expect(retentionSection().simplyPut).toBe(APPROVED_RETENTION_SUMMARY);
    });

    it('publishes the approved account-deletion point verbatim', () => {
      expect(retentionPointMatching('when you delete your account, we remove')).toBe(
        APPROVED_ACCOUNT_DELETION_POINT
      );
    });

    it('publishes the approved retention payments point verbatim', () => {
      expect(retentionPointMatching('past payments')).toBe(APPROVED_RETENTION_PAYMENTS_POINT);
    });

    it('publishes the approved backup point verbatim', () => {
      expect(retentionPointMatching('backup')).toBe(APPROVED_BACKUP_POINT);
    });

    // Pinned so a retention point cannot be added alongside the approved ones: a new point
    // that avoids the words the needles select on is otherwise invisible to every assertion.
    it('publishes exactly seven retention points', () => {
      expect(retentionSection().points).toHaveLength(7);
    });

    it('does not state that no analytics or tracking tools are used', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points])
        .join(' ')
        .toLowerCase();
      expect(allText).not.toContain('analytics or tracking');
      expect(allText).not.toContain('we do not track you at all');
    });

    // The setting is read nowhere in the repository, so the document says so rather than
    // promising a response to it.
    it('publishes that the Do Not Track setting is not read', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points])
        .join(' ')
        .toLowerCase();
      expect(allText).toContain(
        'we do not read your browser\u2019s do not track setting, because we do not track you across sites.'
      );
    });

    it('publishes the approved website-measurement summary verbatim', () => {
      expect(measurementSection().simplyPut).toBe(APPROVED_MEASUREMENT_SUMMARY);
    });

    it('publishes the approved website-measurement points verbatim and in order', () => {
      expect(measurementSection().points).toEqual(APPROVED_MEASUREMENT_POINTS);
    });

    it('discloses that the counting uses the visitor\u2019s IP address', () => {
      expect(measurementText()).toContain('your ip address');
    });

    it('discloses that the counting uses the browser\u2019s own description of itself', () => {
      expect(measurementText()).toContain('the line your browser sends describing itself');
    });

    it('publishes when the code a visitor is counted under is cleared', () => {
      expect(measurementText()).toContain('cleared 36 hours after the last visit counted into it');
    });

    it('publishes the longest a visitor code can be held', () => {
      expect(measurementText()).toContain(
        'so a code is never held longer than two and a half days'
      );
    });

    // The lifetime is re-applied on every write with no anchor (`addUnderCeiling` in
    // `apps/api/src/slices/growth/domain/ceiling-gate.ts` calls `EXPIRE` on every call it
    // admits, including one whose member the set already held), so a code added early in a
    // daily tally outlives 36 hours by the span of the tally. A fixed 36-hour ceiling on the
    // code is the claim that must not come back.
    it('does not publish a fixed 36-hour ceiling on the visitor code', () => {
      expect(measurementText()).not.toContain('at most 36 hours');
    });

    it('publishes that the counts are never connected to an account', () => {
      expect(measurementText()).toContain('none of this is connected to an account.');
    });

    it('discloses the within-day link between the page a visitor arrived on and later pages', () => {
      expect(measurementText()).toContain(
        'links the page you arrived on to the pages you go on to read'
      );
    });

    it('publishes what the measurement is for', () => {
      expect(measurementText()).toContain(
        'which pages people read and which links bring them to hushbox'
      );
    });

    it('publishes every device family a request is classified into', () => {
      expect(measurementText()).toContain('desktop, mobile, tablet, or other');
    });

    // The registration-start value is `callerIpIdForAddress` in
    // `apps/api/src/lib/redis/caller-ip.ts`: an unkeyed SHA-256 that does not rotate. Calling
    // it a one-way hash beside a keyed, daily-rotating one reads as the same protection.
    it('does not describe the registration-start value as a one-way hash', () => {
      expect(measurementText()).not.toContain('one-way hash');
    });

    // `growth_hourly_funnel` is unique on (hour, campaign, step)
    // (`packages/db/src/schema/growth-hourly-funnel.ts`), so the campaign tag is a dimension of
    // the count rather than something kept beside it. The sentence claims what the table holds.
    it('publishes that registration starts are counted under the campaign tag', () => {
      expect(measurementText()).toContain(
        'begin creating an account each hour, under the campaign tag they arrived with.'
      );
    });

    it('publishes that the registration-start value protects the address less', () => {
      expect(measurementText()).toContain(
        'it is not scrambled under a secret and does not change from day to day'
      );
    });

    // The summary names every purpose the section's points publish, the newsletter and the
    // leaderboard included, so it cannot be read as a narrower promise than the list beneath it.
    it('publishes a purpose summary that its own points do not exceed', () => {
      expect(privacySection('data-usage').simplyPut).toBe(APPROVED_USAGE_SUMMARY);
    });

    it('publishes the newsletter and the leaderboard among the uses', () => {
      const points = privacySection('data-usage').points;
      expect(points.filter((p) => p === APPROVED_NEWSLETTER_USE_POINT)).toHaveLength(1);
      expect(points.filter((p) => p === APPROVED_LEADERBOARD_POINT)).toHaveLength(1);
    });

    it('publishes the approved feedback point verbatim', () => {
      const matches = privacySection('data-collection').points.filter((p) =>
        p.startsWith('Feedback:')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_FEEDBACK_POINT);
    });

    it('publishes the approved third-party summary verbatim', () => {
      expect(privacySection('third-party-services').simplyPut).toBe(APPROVED_THIRD_PARTY_SUMMARY);
    });

    it('publishes the approved error-reports point verbatim', () => {
      const matches = privacySection('third-party-services').points.filter((p) =>
        p.startsWith('Error reports.')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_ERROR_REPORTS_POINT);
    });

    for (const [id, approved] of Object.entries(APPROVED_WHOLE_PRIVACY_SECTIONS)) {
      it(`publishes the approved ${id} section whole`, () => {
        const section = privacySection(id);
        expect(section.simplyPut).toBe(approved.simplyPut);
        expect(section.points).toEqual(approved.points);
      });
    }

    it('publishes the approved encryption summary verbatim', () => {
      expect(privacySection('encryption-security').simplyPut).toBe(APPROVED_ENCRYPTION_SUMMARY);
    });

    it('publishes who holds the private key', () => {
      const matches = privacySection('encryption-security').points.filter((p) =>
        p.startsWith('Messages are encrypted before storage')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_ENCRYPTION_KEY_POINT);
    });

    it('publishes the breach-notice point verbatim', () => {
      expect(
        privacySection('encryption-security').points.filter((p) => p === APPROVED_BREACH_POINT)
      ).toHaveLength(1);
    });

    it('publishes the deletion route on the web as well as in the app', () => {
      expect(retentionPointMatching('from settings')).toBe(APPROVED_DELETION_ROUTE_POINT);
    });

    it('publishes what happens to messages sent in other people\u2019s conversations', () => {
      expect(retentionPointMatching('someone else owns')).toBe(APPROVED_FOREIGN_MESSAGES_POINT);
    });

    it('publishes the approved mailing-list point verbatim', () => {
      expect(retentionPointMatching('mailing list')).toBe(APPROVED_MAILING_LIST_POINT);
    });

    it('publishes the approved children summary verbatim', () => {
      expect(privacySection('children').simplyPut).toBe(APPROVED_CHILDREN_SUMMARY);
    });

    it('publishes the local-age rule for children', () => {
      expect(
        privacySection('children').points.filter((p) => p === APPROVED_CHILDREN_LOCAL_AGE_POINT)
      ).toHaveLength(1);
    });

    it('publishes the approved contact section', () => {
      const contact = privacySection('contact');
      expect(contact.simplyPut).toBe(APPROVED_CONTACT_SUMMARY);
      expect(contact.points).toEqual(APPROVED_CONTACT_POINTS);
    });

    it('publishes the approved collection summary verbatim', () => {
      expect(privacySection('data-collection').simplyPut).toBe(APPROVED_COLLECTION_SUMMARY);
    });

    it('publishes the approved IP-address point verbatim', () => {
      const matches = privacySection('data-collection').points.filter((p) =>
        p.startsWith('Your IP address:')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_IP_POINT);
    });

    // `packages/db/src/schema` declares exactly two columns holding a caller address:
    // `newsletter_subscribers.consent_ip` and `account_deletion_events.ip_address`. The
    // sentence claims that set, so it is asserted as the set rather than as a phrase.
    it('names both records that keep the address itself', () => {
      expect(privacyText()).toContain('two records keep the address itself:');
    });

    it('publishes the approved cookies summary verbatim', () => {
      expect(privacySection('cookies-storage').simplyPut).toBe(APPROVED_COOKIES_SUMMARY);
    });

    it('publishes the second cookie the summary counts', () => {
      const matches = privacySection('cookies-storage').points.filter((p) =>
        p.startsWith('Opening billing')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_BILLING_COOKIE_POINT);
    });

    it('publishes what a signed-in browser holds beside the preferences', () => {
      const matches = privacySection('cookies-storage').points.filter((p) =>
        p.startsWith('When you sign in')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_SIGNED_IN_STORAGE_POINT);
    });

    it('publishes the approved preferences-storage point verbatim', () => {
      const matches = privacySection('cookies-storage').points.filter((p) =>
        p.startsWith('Your browser also remembers')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_PREFERENCES_STORAGE_POINT);
    });

    it('publishes the approved trial-identifier point verbatim', () => {
      const matches = privacySection('cookies-storage').points.filter((p) =>
        p.startsWith('If you try HushBox without an account')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_TRIAL_IDENTIFIER_POINT);
    });

    // The claim removed here has to stay removed: only an absence assertion sees browser
    // storage described as preferences again in different words.
    it('does not describe browser storage as preferences alone', () => {
      expect(privacyText()).not.toContain('for ui preferences');
    });

    it('names the deletion record among what outlives the account', () => {
      expect(retentionSection().simplyPut).toContain('a record of the deletion itself');
    });

    // The signed-in app writes the account id into Web Storage and keeps a wrapped key in
    // IndexedDB beside it (`apps/web/src/lib/auth/client.ts`), which is how a returning
    // person is recognized. Only the counter can promise this, and it does, in its own
    // section.
    it('does not promise that nothing on the device recognizes you', () => {
      expect(privacyText()).not.toContain('to recognize you');
    });

    // `docs/DESIGN.md` §6 bans long dashes in copy a user reads. The whole document is inside
    // the ban, not only the sections carrying the measurement disclosure.
    it('sets the whole privacy policy without long dashes', () => {
      const text = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(' ');
      expect(text).not.toContain('\u2014');
      expect(text).not.toContain('\u2013');
    });

    it('publishes the approved notification-settings point verbatim', () => {
      const matches = privacySection('data-collection').points.filter((p) =>
        p.startsWith('Notification settings:')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_NOTIFICATION_SETTINGS_POINT);
    });

    it('publishes the approved collection payment point verbatim', () => {
      const matches = privacySection('data-collection').points.filter((p) =>
        p.startsWith('Payment details:')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_COLLECTION_PAYMENT_POINT);
    });

    it('publishes the approved third-party payment point verbatim', () => {
      const matches = privacySection('third-party-services').points.filter((p) =>
        p.startsWith('Our payment processor')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_THIRD_PARTY_PAYMENT_POINT);
    });

    it('publishes the approved web-search point verbatim', () => {
      const matches = privacySection('third-party-services').points.filter((p) =>
        p.startsWith('Web search.')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_WEB_SEARCH_POINT);
    });

    it('does not name Perplexity anywhere in the privacy policy', () => {
      expect(privacyText()).not.toContain('perplexity');
    });

    it('publishes the approved acquisition-source point verbatim', () => {
      const collection = PRIVACY_SECTIONS.find((s) => s.id === 'data-collection');
      expect(collection).toBeDefined();
      const matches = collection!.points.filter((p) => p.startsWith('Acquisition source:'));
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_ACQUISITION_POINT);
    });

    it('closes the collection section with the approved terms-acceptance point', () => {
      expect(privacySection('data-collection').points.at(-1)).toBe(APPROVED_TERMS_ACCEPTANCE_POINT);
    });
  });
});

// Media storage is quoted per DECIMAL megabyte, a million bytes. The binary reading prices the
// same byte rate about five percent higher, so the unit is part of the published price rather
// than a rendering detail. A million is what the rate's own tests already price it at
// (`prices one megabyte at 18_000_000 nano-USD` in `../affordability/estimate/storage-rate.test.ts`,
// and the per-megabyte pins in `../affordability/constants.test.ts`). Re-derived here rather than
// imported from the copy module, so a respelling of the unit in the prose fails this pin.
const BYTES_PER_MEGABYTE = 1_000_000;
const mediaCostPerMegabyte = `$${String(MEDIA_STORAGE_COST_PER_BYTE * BYTES_PER_MEGABYTE)}`;

const APPROVED_TERMS_SECTION_ORDER: readonly string[] = [
  'acceptance',
  'eligibility',
  'description',
  'beta',
  'account-responsibilities',
  'acceptable-use',
  'intellectual-property',
  'ai-disclaimer',
  'third-party-services',
  'payment-terms',
  'limitation-of-liability',
  'warranties',
  'indemnification',
  'termination',
  'governing-law',
  'app-stores',
  'general',
  'changes',
];

const APPROVED_WHOLE_TERMS_SECTIONS: Readonly<
  Record<string, { readonly simplyPut: string; readonly points: readonly string[] }>
> = {
  eligibility: {
    simplyPut: 'You must be 13 or older, and older where your local law sets a higher age.',
    points: [
      'You must be at least 13 years old to use HushBox. If the law where you live sets a higher age for agreeing to online services on your own, you must be at least that age.',
      'If you are under 18, you confirm that a parent or guardian has agreed to these terms for you.',
    ],
  },
  indemnification: {
    simplyPut: 'If your misuse gets us sued, you cover the cost.',
    points: [
      'If someone brings a claim against LOME-AI LLC because you broke these terms or the law while using HushBox, you agree to cover the resulting losses, including reasonable legal fees.',
      'This applies only as far as the law where you live allows.',
    ],
  },
  // Apple's minimum EULA terms apply only to a custom EULA uploaded in App Store Connect; with
  // Apple's standard EULA in place, the section states the stores' role and no duty of ours.
  'app-stores': {
    simplyPut:
      'Your app store\u2019s terms also cover the download. Apple and Google are not parties to these terms.',
    points: [
      'If you downloaded HushBox from the App Store or Google Play, that store\u2019s own terms also apply to the download.',
      'Apple and Google are not parties to these terms and are not responsible for HushBox or its content.',
    ],
  },
  general: {
    simplyPut:
      'Consumer-law rights still apply. If a court strikes one term the rest stand, and these terms plus the Privacy Policy are the whole agreement.',
    points: [
      'Nothing in these terms takes away a right you have under consumer protection law that a contract cannot waive.',
      'If a court finds part of these terms unenforceable, the rest stay in effect.',
      'These terms and the Privacy Policy are the whole agreement between you and LOME-AI LLC about HushBox.',
      'You may not transfer your account or these terms to anyone else. We may transfer them to a company that takes over HushBox, and we will email you if we do.',
      'We are not responsible for a failure caused by events outside our reasonable control, such as an outage at a provider we rely on.',
      'If we do not enforce part of these terms at some point, we keep the right to enforce it later.',
      'Questions about these terms: legal@hushbox.ai. LOME-AI LLC, Indiana, United States.',
    ],
  },
};

const APPROVED_DESCRIPTION_SUMMARY =
  'Chat with many AI models in one app, with your conversations stored encrypted. The mobile apps update directly from us and may require an update to keep working.';

// The apps take interface bundles over the air from the `updates` slice, and a required update
// blocks the app until it is applied.
const APPROVED_APP_UPDATES_POINT =
  'The HushBox apps for iOS and Android download updates to their interface directly from us, outside the app stores. When an update is required, the app asks you to apply it before you can keep using it.';

const APPROVED_IP_SUMMARY =
  'Your inputs are yours. We\u2019ll never claim your AI outputs. Feedback you send us, we may use freely.';

const APPROVED_FEEDBACK_LICENCE_POINT =
  'If you send us feedback or suggestions, we may use them to improve HushBox without owing you anything for them.';

const APPROVED_PURCHASES_FINAL_POINT =
  'All purchases are final. If you believe a charge was made in error, contact legal@hushbox.ai within 30 days.';

const APPROVED_WITHDRAWAL_POINT =
  'If you live in the European Union or the United Kingdom, you can cancel a credit purchase within 14 days of making it by emailing legal@hushbox.ai, and we will refund the credit that remains. Credit you have already used is not refunded.';

const APPROVED_PRICE_REFERENCE_POINT =
  'Model prices shown in HushBox, and any estimate of what a message will cost, are references rather than exact quotes. A reply can cost more or less than shown, for example when a different provider serves it, or when a long conversation moves a model to its higher long-conversation rate. The fee percentage and storage prices in these terms do not vary from reply to reply. Before a reply starts, we reserve an amount to cover it. If the reply costs more than that amount, we still charge its full cost.';

const APPROVED_PRICE_REFERENCE_SUMMARY_SENTENCE =
  'Model prices are references and can vary with the provider that serves a reply.';

const APPROVED_SURVIVAL_POINT =
  'Upon termination by either side, certain provisions survive, including Limitation of Liability, Intellectual Property, Disclaimer of Warranties, Indemnification, and Governing Law.';

function termsSection(id: string): LegalSection {
  const section = TERMS_SECTIONS.find((s) => s.id === id);
  expect(section).toBeDefined();
  return section!;
}

describe('Terms of Service', () => {
  describe('TERMS_OF_SERVICE_META', () => {
    it('has the correct title', () => {
      expect(TERMS_OF_SERVICE_META.title).toBe('Terms of Service');
    });

    it('carries a well-formed effective date', () => {
      expectWellFormedDate(TERMS_OF_SERVICE_META.effectiveDate);
    });

    it('publishes the date the build injected, never one written in this repository', () => {
      const published = effectiveDateUnder(
        'VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE',
        '2018-03-22',
        TERMS_OF_SERVICE_META
      );

      expect(published).toBe('2018-03-22');
    });

    it('publishes legal@hushbox.ai as the contact address', () => {
      expect(TERMS_OF_SERVICE_META.contactEmail).toBe('legal@hushbox.ai');
    });
  });

  describe('TERMS_SECTIONS', () => {
    it('publishes the sections in the approved order', () => {
      expect(TERMS_SECTIONS.map((s) => s.id)).toEqual(APPROVED_TERMS_SECTION_ORDER);
    });

    it('starts with acceptance section', () => {
      expect(TERMS_SECTIONS[0]!.id).toBe('acceptance');
    });

    it('ends with changes section', () => {
      expect(TERMS_SECTIONS.at(-1)!.id).toBe('changes');
    });

    it('includes intellectual-property section', () => {
      const section = TERMS_SECTIONS.find((s) => s.id === 'intellectual-property');
      expect(section).toBeDefined();
    });

    assertValidSections(TERMS_SECTIONS);
  });

  describe('content constraints', () => {
    it('does not mention OpenRouter by name', () => {
      const allText = TERMS_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(' ');
      expect(allText.toLowerCase()).not.toContain('openrouter');
    });

    it('disclaims ownership of AI outputs in IP section', () => {
      const ipSection = TERMS_SECTIONS.find((s) => s.id === 'intellectual-property');
      expect(ipSection).toBeDefined();
      const allPoints = ipSection!.points.join(' ').toLowerCase();
      expect(allPoints).toContain('never claim ownership');
    });

    it('states no refunds in payment section', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ').toLowerCase();
      expect(allPoints).toContain('all purchases are final.');
    });

    it('references the total fee rate from constants', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).toContain(formatFeePercent(TOTAL_FEE_RATE));
    });

    it('references every non-zero fee category by percent and label', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      for (const category of FEE_CATEGORIES) {
        expect(allPoints).toContain(formatFeePercent(category.rate));
        expect(allPoints).toContain(category.label);
      }
    });

    it('does not mention any zero-rate fee category label', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      for (const category of ALL_FEE_CATEGORIES) {
        if (category.rate === 0) {
          expect(allPoints).not.toContain(category.label);
        }
      }
    });

    it('includes the breakdown bullet iff at least one fee is non-zero', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      if (FEE_CATEGORIES.length > 0) {
        expect(allPoints).toContain('Fee breakdown:');
      } else {
        expect(allPoints).not.toContain('Fee breakdown:');
      }
    });

    it('does not contain a malformed empty breakdown ("Fee breakdown: .")', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).not.toMatch(/Fee breakdown:\s*\./);
    });

    it('references storage cost from constants', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).toContain(`$${String(STORAGE_COST_PER_1K_CHARS)}`);
    });

    it('references the media storage cost from constants', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).toContain(mediaCostPerMegabyte);
    });

    // The byte count the price is per is part of the price rather than a gloss on it, for the
    // reason {@link BYTES_PER_MEGABYTE} carries, so every statement of the price carries it.
    it('states the byte count the media storage price is per', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const priced = paymentSection!.points.filter((point) => point.includes(mediaCostPerMegabyte));
      expect(priced).toHaveLength(1);
      expect(priced[0]).toContain(`${mediaCostPerMegabyte} per megabyte (a million bytes)`);
    });

    it('points to the Privacy Policy for the website measurement', () => {
      const description = TERMS_SECTIONS.find((s) => s.id === 'description');
      expect(description).toBeDefined();
      expect(description!.points).toContain(APPROVED_MEASUREMENT_POINTER);
    });

    // "No hidden charges" is a claim about the set of prices charged, so a summary naming the
    // usage fee alone contradicts the storage fee published in the points beneath it. Both are
    // asserted from the constants the section computes them from, never from a literal.
    it('names the usage fee rate in the payment summary', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      expect(paymentSection!.simplyPut).toContain(formatFeePercent(TOTAL_FEE_RATE));
    });

    it('names the storage price in the payment summary', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      expect(paymentSection!.simplyPut).toContain(`$${String(STORAGE_COST_PER_1K_CHARS)}`);
    });

    it('names the media storage price in the payment summary', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      expect(paymentSection!.simplyPut).toContain(mediaCostPerMegabyte);
    });

    it('states the byte count the media storage price is per in the payment summary', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      expect(paymentSection!.simplyPut).toContain(
        `${mediaCostPerMegabyte} per megabyte (a million bytes)`
      );
    });

    // The section's other summaries are flat declaratives, and the principle is the line's own
    // claim rather than a lead-in to the prices: it ends in a period, and this is what holds it
    // there when the price list beside it changes again.
    it('opens the payment summary with the pay-as-you-go principle as its own sentence', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      expect(paymentSection!.simplyPut.startsWith('Pay for what you use. ')).toBe(true);
    });

    it('sets the whole terms of service without long dashes', () => {
      const text = TERMS_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(' ');
      expect(text).not.toContain('\u2014');
      expect(text).not.toContain('\u2013');
    });

    it('specifies Indiana as governing law', () => {
      const govSection = TERMS_SECTIONS.find((s) => s.id === 'governing-law');
      expect(govSection).toBeDefined();
      const allPoints = govSection!.points.join(' ');
      expect(allPoints).toContain('Indiana');
    });

    for (const [id, approved] of Object.entries(APPROVED_WHOLE_TERMS_SECTIONS)) {
      it(`publishes the approved ${id} section whole`, () => {
        const section = termsSection(id);
        expect(section.simplyPut).toBe(approved.simplyPut);
        expect(section.points).toEqual(approved.points);
      });
    }

    it('publishes the approved description summary verbatim', () => {
      expect(termsSection('description').simplyPut).toBe(APPROVED_DESCRIPTION_SUMMARY);
    });

    it('publishes that the mobile apps update from us', () => {
      expect(
        termsSection('description').points.filter((p) => p === APPROVED_APP_UPDATES_POINT)
      ).toHaveLength(1);
    });

    it('publishes the approved intellectual-property summary verbatim', () => {
      expect(termsSection('intellectual-property').simplyPut).toBe(APPROVED_IP_SUMMARY);
    });

    it('publishes the feedback licence', () => {
      expect(
        termsSection('intellectual-property').points.filter(
          (p) => p === APPROVED_FEEDBACK_LICENCE_POINT
        )
      ).toHaveLength(1);
    });

    it('publishes the approved purchases-final point verbatim', () => {
      const matches = termsSection('payment-terms').points.filter((p) =>
        p.startsWith('All purchases are final.')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_PURCHASES_FINAL_POINT);
    });

    // The 14-day right comes from EU and UK consumer law, not from these terms; the point states
    // it with the refund limited to credit that remains, as ruled.
    it('publishes the EU and UK withdrawal point verbatim', () => {
      const matches = termsSection('payment-terms').points.filter((p) => p.includes('14 days'));
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_WITHDRAWAL_POINT);
    });

    it('publishes the approved price-reference point verbatim', () => {
      const matches = termsSection('payment-terms').points.filter((p) =>
        p.startsWith('Model prices shown in HushBox')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_PRICE_REFERENCE_POINT);
    });

    it('names model prices as references in the payment summary', () => {
      expect(termsSection('payment-terms').simplyPut).toContain(
        APPROVED_PRICE_REFERENCE_SUMMARY_SENTENCE
      );
    });

    it('lists Indemnification among the provisions that survive termination', () => {
      const matches = termsSection('termination').points.filter((p) =>
        p.startsWith('Upon termination')
      );
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(APPROVED_SURVIVAL_POINT);
    });

    it('grants an explicit account-deletion right in the termination section', () => {
      const terminationSection = TERMS_SECTIONS.find((s) => s.id === 'termination');
      expect(terminationSection).toBeDefined();
      const sectionText = [
        terminationSection!.title,
        terminationSection!.simplyPut,
        ...terminationSection!.points,
      ]
        .join(' ')
        .toLowerCase();
      expect(sectionText).toContain('delete your account');
    });
  });
});

describe('published copy is the copy a human last judged', () => {
  interface PinnedDocument {
    readonly name: string;
    readonly revisionConstant: string;
    readonly digestConstant: string;
    readonly pinnedDigest: string;
    readonly meta: LegalDocumentMeta;
    readonly sections: readonly LegalSection[];
  }

  function changedCopyNotice(document: PinnedDocument, recomputed: string): string {
    return [
      `The published ${document.name} no longer matches the copy a human last approved.`,
      `  pinned digest:     ${document.pinnedDigest}`,
      `  recomputed digest: ${recomputed}`,
      'Decide which kind of change this is; no automation can, which is why this fails.',
      `  Substantive (a new promise, a changed limit, a different obligation): raise ${document.revisionConstant}`,
      `    in packages/shared/src/constants.ts by one and set ${document.digestConstant} to the`,
      '    recomputed digest. The published effective date is derived from the revision, so this',
      '    is what moves the date the document carries.',
      `  Cosmetic (a typo, punctuation, a formatting fix, a contact address): set ${document.digestConstant}`,
      `    to the recomputed digest and leave ${document.revisionConstant} alone. Re-pinning it is`,
      '    the record that a human read the change and judged it cosmetic.',
    ].join('\n');
  }

  // The digest is taken over the rendered document, so it moves when a fee clause the Terms
  // compute from an imported rate moves, and stays put when the source respells a character
  // the reader sees unchanged.
  async function expectPinnedCopy(document: PinnedDocument): Promise<void> {
    const recomputed = await legalCopyDigest(document.meta, document.sections);
    expect(recomputed, changedCopyNotice(document, recomputed)).toBe(document.pinnedDigest);
  }

  it('renders the privacy policy copy that PRIVACY_POLICY_COPY_DIGEST pins', async () => {
    await expectPinnedCopy({
      name: 'Privacy Policy',
      revisionConstant: 'PRIVACY_POLICY_REVISION',
      digestConstant: 'PRIVACY_POLICY_COPY_DIGEST',
      pinnedDigest: PRIVACY_POLICY_COPY_DIGEST,
      meta: PRIVACY_POLICY_META,
      sections: PRIVACY_SECTIONS,
    });
  });

  it('renders the terms of service copy that TERMS_OF_SERVICE_COPY_DIGEST pins', async () => {
    await expectPinnedCopy({
      name: 'Terms of Service',
      revisionConstant: 'TERMS_OF_SERVICE_REVISION',
      digestConstant: 'TERMS_OF_SERVICE_COPY_DIGEST',
      pinnedDigest: TERMS_OF_SERVICE_COPY_DIGEST,
      meta: TERMS_OF_SERVICE_META,
      sections: TERMS_SECTIONS,
    });
  });
});

// Uncoverable branch note: terms-sections.ts evaluates
// `FEE_CATEGORIES.length > 0 ? [...] : []` once at module load against the
// imported fee constants. The empty-list arm is a deliberate guard for a
// future zero-fee configuration; with the current FEE_CATEGORIES it cannot
// execute, and re-evaluating it would require mocking an internal module,
// which the testing rules forbid.

describe('published legal text sources no address twice', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));

  /** Every module holding published legal prose. Adding one belongs on this list. */
  const DOCUMENT_SOURCES = ['privacy-sections.ts', 'terms-sections.ts'] as const;

  const EMAIL_LITERAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

  for (const source of DOCUMENT_SOURCES) {
    // Structural, because both spellings render the same string today: a rendered
    // assertion passes whether the prose interpolates the constant or repeats it,
    // and so cannot see the copy drift away from the constant it duplicates.
    it(`spells no contact address in ${source}`, () => {
      const text = readFileSync(path.join(HERE, source), 'utf8');
      expect(text).not.toMatch(EMAIL_LITERAL);
    });
  }
});

describe('published legal prose renders its canonical address', () => {
  const EVERY_EMAIL_LITERAL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

  function addressesRenderedIn(sections: readonly LegalSection[]): string[] {
    const prose = sections.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join('\n');
    return [...new Set(prose.match(EVERY_EMAIL_LITERAL))];
  }

  // Pinned to the address as a literal, never to the constant the prose interpolated:
  // an expectation built from that same constant holds under any substitution, so it
  // cannot see one document's prose reach for the other document's address — which
  // renders as a well-formed address and reads as correct.
  it('renders legal@hushbox.ai as the only address in the privacy policy', () => {
    expect(addressesRenderedIn(PRIVACY_SECTIONS)).toEqual(['legal@hushbox.ai']);
  });

  it('renders legal@hushbox.ai as the only address in the terms of service', () => {
    expect(addressesRenderedIn(TERMS_SECTIONS)).toEqual(['legal@hushbox.ai']);
  });
});
