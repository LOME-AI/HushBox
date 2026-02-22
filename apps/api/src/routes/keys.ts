import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  ERROR_CODE_UNAUTHORIZED,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  toBase64,
} from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { requireAuth } from '../middleware/require-auth.js';
import { getKeyChain, getMemberKeys, verifyMembership } from '../services/keys/index.js';
import type { AppEnv } from '../types.js';

export const keysRoute = new Hono<AppEnv>()
  .use('*', requireAuth())
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const result = await getKeyChain(db, conversationId, user.publicKey);
      if (!result) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      return c.json(
        {
          wraps: result.wraps.map((w) => ({
            epochNumber: w.epochNumber,
            wrap: toBase64(w.wrap),
            confirmationHash: toBase64(w.confirmationHash),
            visibleFromEpoch: w.visibleFromEpoch,
          })),
          chainLinks: result.chainLinks.map((cl) => ({
            epochNumber: cl.epochNumber,
            chainLink: toBase64(cl.chainLink),
            confirmationHash: toBase64(cl.confirmationHash),
          })),
          currentEpoch: result.currentEpoch,
        },
        200
      );
    }
  )
  .get(
    '/:conversationId/member-keys',
    zValidator('param', z.object({ conversationId: z.string() })),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const membership = await verifyMembership(db, conversationId, user.id);
      if (!membership) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      const memberKeys = await getMemberKeys(db, conversationId);

      return c.json(
        {
          members: memberKeys.map((m) => ({
            memberId: m.memberId,
            userId: m.userId,
            linkId: m.linkId,
            publicKey: toBase64(m.publicKey),
            privilege: m.privilege,
            visibleFromEpoch: m.visibleFromEpoch,
          })),
        },
        200
      );
    }
  );
