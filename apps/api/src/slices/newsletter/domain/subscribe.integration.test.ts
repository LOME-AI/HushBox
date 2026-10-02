import { afterAll, describe, expect, it } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, newsletterSubscribers } from '@hushbox/db';
import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import { okAsync } from '../../../lib/result/index.js';
import { createNewsletterStores } from '../adapters/stores.js';
import { NEWSLETTER_RESEND_THROTTLE_MS, subscribeToNewsletter } from './subscribe.js';
import type { NewsletterConfirmEmailPort } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter subscribe tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const store = createNewsletterStores(db);
const createdEmails: string[] = [];

function nextEmail(tag: string): string {
  const email = `${tag}-${crypto.randomUUID().slice(0, 8)}@newsletter-subscribe.test`;
  createdEmails.push(email);
  return email;
}

interface SentConfirmation {
  readonly to: string;
  readonly token: string;
}

function recordingEmailPort(): { port: NewsletterConfirmEmailPort; sent: SentConfirmation[] } {
  const sent: SentConfirmation[] = [];
  return {
    port: {
      sendConfirmation: (args) => {
        sent.push(args);
        return okAsync();
      },
    },
    sent,
  };
}

async function seedPending(
  email: string,
  confirmSentAt: Date | null
): Promise<typeof newsletterSubscribers.$inferSelect> {
  const rows = await db
    .insert(newsletterSubscribers)
    .values({
      email,
      status: 'pending',
      consentSource: 'marketing_site',
      consentIp: '192.0.2.1',
      consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
      unsubscribeToken: crypto.randomUUID(),
      confirmToken: crypto.randomUUID(),
      confirmExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      confirmSentAt,
    })
    .returning();
  const row = rows[0];
  if (row === undefined) throw new Error('newsletter seed failed');
  return row;
}

async function readRow(email: string): Promise<typeof newsletterSubscribers.$inferSelect> {
  const rows = await db
    .select()
    .from(newsletterSubscribers)
    .where(eq(newsletterSubscribers.email, email));
  const row = rows[0];
  if (row === undefined) throw new Error(`no subscriber row for ${email}`);
  return row;
}

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db
      .delete(newsletterSubscribers)
      .where(inArray(newsletterSubscribers.email, createdEmails));
  }
  await db.$client.end();
});

describe('subscribeToNewsletter (integration: real Postgres)', () => {
  it('sends exactly one confirmation when twenty signups race one stale pending row', async () => {
    const email = nextEmail('burst');
    const seeded = await seedPending(
      email,
      new Date(Date.now() - NEWSLETTER_RESEND_THROTTLE_MS - 60_000)
    );
    const { port, sent } = recordingEmailPort();

    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        subscribeToNewsletter({
          store,
          emailPort: port,
          email,
          consentIp: '192.0.2.9',
          now: new Date(),
        })
      )
    );

    expect(results.every((result) => result.isOk())).toBe(true);
    expect(sent).toHaveLength(1);
    const row = await readRow(email);
    // The refused racers each minted a token; none of them may reach the row.
    expect(row.confirmToken).toBe(sent[0]?.token);
    expect(row.confirmToken).not.toBe(seeded.confirmToken);
  });

  it('resends once for a lone signup past the throttle window', async () => {
    const email = nextEmail('stale');
    const seeded = await seedPending(
      email,
      new Date(Date.now() - NEWSLETTER_RESEND_THROTTLE_MS - 60_000)
    );
    const { port, sent } = recordingEmailPort();

    const result = await subscribeToNewsletter({
      store,
      emailPort: port,
      email,
      consentIp: '192.0.2.9',
      now: new Date(),
    });

    expect(result.isOk()).toBe(true);
    expect(sent).toHaveLength(1);
    const row = await readRow(email);
    expect(row.confirmToken).toBe(sent[0]?.token);
    expect(row.confirmToken).not.toBe(seeded.confirmToken);
    expect(row.confirmSentAt?.getTime()).toBeGreaterThan(seeded.confirmSentAt?.getTime() ?? 0);
  });

  it('resends at the exact window boundary', async () => {
    const email = nextEmail('boundary');
    const now = new Date();
    const seeded = await seedPending(
      email,
      new Date(now.getTime() - NEWSLETTER_RESEND_THROTTLE_MS)
    );
    const { port, sent } = recordingEmailPort();

    const result = await subscribeToNewsletter({
      store,
      emailPort: port,
      email,
      consentIp: '192.0.2.9',
      now,
    });

    expect(result.isOk()).toBe(true);
    expect(sent).toHaveLength(1);
    const row = await readRow(email);
    expect(row.confirmToken).not.toBe(seeded.confirmToken);
  });

  it('sends nothing for a signup inside the throttle window', async () => {
    const email = nextEmail('throttled');
    const now = new Date();
    const seeded = await seedPending(email, new Date(now.getTime() - 1000));
    const { port, sent } = recordingEmailPort();

    const result = await subscribeToNewsletter({
      store,
      emailPort: port,
      email,
      consentIp: '192.0.2.9',
      now,
    });

    expect(result.isOk()).toBe(true);
    expect(sent).toHaveLength(0);
    const row = await readRow(email);
    expect(row.confirmToken).toBe(seeded.confirmToken);
    expect(row.consentIp).toBe('192.0.2.1');
  });

  it('sends for a pending row that has no recorded send', async () => {
    const email = nextEmail('never-sent');
    const seeded = await seedPending(email, null);
    const { port, sent } = recordingEmailPort();

    const result = await subscribeToNewsletter({
      store,
      emailPort: port,
      email,
      consentIp: '192.0.2.9',
      now: new Date(),
    });

    expect(result.isOk()).toBe(true);
    expect(sent).toHaveLength(1);
    const row = await readRow(email);
    expect(row.confirmToken).toBe(sent[0]?.token);
    expect(row.confirmToken).not.toBe(seeded.confirmToken);
  });
});
