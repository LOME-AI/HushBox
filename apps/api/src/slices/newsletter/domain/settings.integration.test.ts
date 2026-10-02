import { afterAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { LOCAL_NEON_DEV_CONFIG, createDb, newsletterSubscribers, users } from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import { NEWSLETTER_CONSENT_TEXT_VERSION } from '@hushbox/shared';
import { TEST_DAY_START } from '@hushbox/shared/test-time';
import { createNewsletterStores } from '../adapters/stores.js';
import { okAsync } from '../../../lib/result/index.js';
import { readNewsletterSettings, writeNewsletterSettings } from './settings.js';
import type { NewsletterStatus } from '@hushbox/shared';
import type { AccountEmailReader } from '../ports/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL is required for newsletter settings tests');
}

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const store = createNewsletterStores(db);
const NOW = new Date(TEST_DAY_START);
const KEY_BYTES = new Uint8Array([1, 2, 3]);
const CONSENT_IP = '192.0.2.1';

const createdEmails: string[] = [];
const createdUserIds: string[] = [];

function nextEmail(tag: string): string {
  const email = `${tag}-${crypto.randomUUID().slice(0, 8)}@newsletter-settings.test`;
  createdEmails.push(email, email.toUpperCase());
  return email;
}

afterAll(async () => {
  if (createdEmails.length > 0) {
    await db
      .delete(newsletterSubscribers)
      .where(inArray(newsletterSubscribers.email, createdEmails));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

/** An account whose stored email is the mixed-case form of `email`. */
async function mixedCaseAccount(email: string): Promise<{
  readonly userId: string;
  readonly users: AccountEmailReader;
}> {
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: email.toUpperCase(),
        username: `nlset${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`,
        opaqueRegistration: KEY_BYTES,
        publicKey: KEY_BYTES,
        passwordWrappedPrivateKey: KEY_BYTES,
        recoveryWrappedPrivateKey: KEY_BYTES,
        recoveryPublicKey: KEY_BYTES,
      })
    )
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  return { userId, users: { findById: () => okAsync({ email: email.toUpperCase() }) } };
}

async function seedSubscriber(email: string, status: NewsletterStatus): Promise<void> {
  await db.insert(newsletterSubscribers).values({
    email,
    status,
    consentSource: 'marketing_site',
    consentIp: CONSENT_IP,
    consentTextVersion: NEWSLETTER_CONSENT_TEXT_VERSION,
    unsubscribeToken: crypto.randomUUID(),
    ...(status === 'subscribed' ? { confirmedAt: NOW } : { unsubscribedAt: NOW }),
  });
}

async function rowsFor(email: string): Promise<{ email: string; status: NewsletterStatus }[]> {
  return db
    .select({ email: newsletterSubscribers.email, status: newsletterSubscribers.status })
    .from(newsletterSubscribers)
    .where(inArray(newsletterSubscribers.email, [email, email.toUpperCase()]));
}

describe('newsletter settings over a mixed-case account email', () => {
  it('reads the subscriber row stored under the lowercase address', async () => {
    const email = nextEmail('read');
    await seedSubscriber(email, 'subscribed');
    const account = await mixedCaseAccount(email);

    const result = await readNewsletterSettings({
      store,
      users: account.users,
      userId: account.userId,
    });

    expect(result.isOk() && result.value).toEqual({ subscribed: true });
  });

  it('converges the existing lowercase row on toggle-on instead of adding a second', async () => {
    const email = nextEmail('write-on');
    await seedSubscriber(email, 'unsubscribed');
    const account = await mixedCaseAccount(email);

    const result = await writeNewsletterSettings({
      store,
      users: account.users,
      userId: account.userId,
      subscribed: true,
      consentIp: CONSENT_IP,
      now: NOW,
    });

    expect(result.isOk() && result.value).toEqual({ subscribed: true });
    expect(await rowsFor(email)).toEqual([{ email, status: 'subscribed' }]);
  });

  it('unsubscribes the existing lowercase row on toggle-off', async () => {
    const email = nextEmail('write-off');
    await seedSubscriber(email, 'subscribed');
    const account = await mixedCaseAccount(email);

    const result = await writeNewsletterSettings({
      store,
      users: account.users,
      userId: account.userId,
      subscribed: false,
      consentIp: CONSENT_IP,
      now: NOW,
    });

    expect(result.isOk() && result.value).toEqual({ subscribed: false });
    expect(await rowsFor(email)).toEqual([{ email, status: 'unsubscribed' }]);
  });
});

describe('newsletter settings when the account row is gone', () => {
  it('fails not-found on the read path', async () => {
    const result = await readNewsletterSettings({
      store,
      users: { findById: () => okAsync(null) },
      userId: crypto.randomUUID(),
    });

    expect(result.isErr() && result.error.code).toBe('not_found');
  });
});
