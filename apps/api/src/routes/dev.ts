import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { users } from '@hushbox/db';
import { ERROR_CODE_NOT_FOUND } from '@hushbox/shared';
import {
  listDevPersonas,
  cleanupTestData,
  resetTrialUsage,
  resetAuthRateLimits,
  createDevGroupChat,
  setWalletBalance,
} from '../services/dev/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';

export const devRoute = new Hono<AppEnv>()
  .get(
    '/personas',
    zValidator('query', z.object({ type: z.enum(['test', 'dev']).optional() })),
    async (c) => {
      const db = c.get('db');
      const { type } = c.req.valid('query');
      const resolvedType = type ?? 'dev';
      const personas = await listDevPersonas(db, resolvedType);
      return c.json({ personas });
    }
  )
  .delete('/test-data', async (c) => {
    const db = c.get('db');
    const deleted = await cleanupTestData(db);
    return c.json({ success: true, deleted });
  })
  .get('/verify-token/:email', zValidator('param', z.object({ email: z.email() })), async (c) => {
    const db = c.get('db');
    const { email } = c.req.valid('param');

    const [user] = await db
      .select({ emailVerifyToken: users.emailVerifyToken })
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    if (!user?.emailVerifyToken) {
      return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
    }

    return c.json({ token: user.emailVerifyToken });
  })
  .delete('/trial-usage', async (c) => {
    const redis = c.get('redis');
    const result = await resetTrialUsage(redis);
    return c.json({ success: true, deleted: result.deleted });
  })
  .delete('/auth-rate-limits', async (c) => {
    const redis = c.get('redis');
    const result = await resetAuthRateLimits(redis);
    return c.json({ success: true, deleted: result.deleted });
  })
  .post(
    '/group-chat',
    zValidator(
      'json',
      z.object({
        ownerEmail: z.email(),
        memberEmails: z.array(z.email()).min(1),
        messages: z
          .array(
            z.object({
              senderEmail: z.email().optional(),
              content: z.string(),
              senderType: z.enum(['user', 'ai']),
            })
          )
          .optional(),
      })
    ),
    async (c) => {
      const db = c.get('db');
      const { messages: rawMessages, ...rest } = c.req.valid('json');
      const result = await createDevGroupChat(db, {
        ...rest,
        ...(rawMessages !== undefined && {
          messages: rawMessages.map(({ senderEmail, ...msgRest }) => ({
            ...msgRest,
            ...(senderEmail !== undefined && { senderEmail }),
          })),
        }),
      });
      return c.json(result, 201);
    }
  )
  .post(
    '/wallet-balance',
    zValidator(
      'json',
      z.object({
        email: z.email(),
        walletType: z.enum(['purchased', 'free_tier']),
        balance: z.string(),
      })
    ),
    async (c) => {
      const db = c.get('db');
      const params = c.req.valid('json');
      try {
        const result = await setWalletBalance(db, params);
        return c.json({ success: true, newBalance: result.newBalance });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        if (message.includes('not found')) {
          return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
        }
        throw error;
      }
    }
  );
