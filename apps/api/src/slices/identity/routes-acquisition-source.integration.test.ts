import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { userAcquisition } from '@hushbox/db';
import { ERROR_CODES } from '@hushbox/shared';
import {
  KEY_BLOBS,
  db,
  get,
  login,
  patch,
  registerAccount,
  sessionCookieOf,
  uniqueAccount,
} from './routes.integration.setup.js';
import type { AcquisitionSourceView } from '@hushbox/shared';

/** A registered, signed-in account carrying the acquisition stamp a signup writes. */
async function signedInWithAcquisition(): Promise<{ cookie: string; userId: string }> {
  const created = await registerAccount(uniqueAccount(), KEY_BLOBS, {
    acquisition: { platform: 'web' },
  });
  const cookie = sessionCookieOf(await login(created.email, created.password));
  return { cookie, userId: created.userId };
}

async function readDuePrompt(cookie: string): Promise<AcquisitionSourceView['duePrompt']> {
  const res = await get('/auth/account/acquisition-source', cookie);
  expect(res.status).toBe(200);
  const view = await res.json<AcquisitionSourceView>();
  return view.duePrompt;
}

describe('identity routes: acquisition source', () => {
  it('tells a fresh account the post-signup question is due', async () => {
    const { cookie } = await signedInWithAcquisition();
    expect(await readDuePrompt(cookie)).toBe('post_signup');
  });

  it('refuses the read to a caller holding no session', async () => {
    const res = await get('/auth/account/acquisition-source');
    expect(res.status).toBe(401);
  });

  it('records an answer and answers with nothing further due', async () => {
    const { cookie, userId } = await signedInWithAcquisition();

    const res = await patch(
      '/auth/account/acquisition-source',
      { action: 'answer', channel: 'podcast', context: 'post_signup' },
      cookie
    );

    expect(res.status).toBe(200);
    expect(await res.json<AcquisitionSourceView>()).toEqual({ duePrompt: null });
    const [row] = await db
      .select({ channel: userAcquisition.selfReportedChannel })
      .from(userAcquisition)
      .where(eq(userAcquisition.userId, userId));
    expect(row?.channel).toBe('podcast');
  });

  it('records a skip against the account and stops asking', async () => {
    const { cookie, userId } = await signedInWithAcquisition();

    const res = await patch(
      '/auth/account/acquisition-source',
      { action: 'skip', context: 'post_signup' },
      cookie
    );

    expect(res.status).toBe(200);
    expect(await readDuePrompt(cookie)).toBeNull();
    const [row] = await db
      .select({ skipped: userAcquisition.selfReportSkipped })
      .from(userAcquisition)
      .where(eq(userAcquisition.userId, userId));
    expect(row?.skipped).toBe('post_signup');
  });

  it('refuses a channel outside the closed set', async () => {
    const { cookie } = await signedInWithAcquisition();

    const res = await patch(
      '/auth/account/acquisition-source',
      { action: 'answer', channel: 'a podcast I heard on the way in', context: 'post_signup' },
      cookie
    );

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('refuses an answer carrying a field the closed contract does not name', async () => {
    const { cookie } = await signedInWithAcquisition();

    const res = await patch(
      '/auth/account/acquisition-source',
      {
        action: 'answer',
        channel: 'podcast',
        context: 'post_signup',
        detail: 'which podcast it was',
      },
      cookie
    );

    expect(res.status).toBe(400);
  });
});
