import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { ERROR_CODE_CONVERSATION_NOT_FOUND, toBase64 } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import { requirePrivilege } from '../middleware/index.js';
import {
  getKeyChain,
  getKeyChainBatch,
  getMemberKeys,
  verifyMembership,
  type KeyChainResult,
} from '../services/keys/index.js';
import type { AppEnv } from '../types.js';

interface SerializedKeyChain {
  wraps: {
    epochNumber: number;
    wrap: string;
    confirmationHash: string;
    visibleFromEpoch: number;
  }[];
  chainLinks: { epochNumber: number; chainLink: string; confirmationHash: string }[];
  currentEpoch: number;
}

function serializeKeyChain(result: KeyChainResult): SerializedKeyChain {
  return {
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
  };
}

export const keysRoute = new Hono<AppEnv>()
  .post(
    '/batch',
    zValidator('json', z.object({ conversationIds: z.array(z.string()).min(1).max(100) })),
    requirePrivilege('read', {
      resolve: (c) =>
        (c.req.valid('json' as never) as { conversationIds: string[] }).conversationIds,
    }),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationIds } = c.req.valid('json');

      const batchResults = await getKeyChainBatch(db, conversationIds, user.publicKey);
      const keys: Record<string, SerializedKeyChain> = {};
      for (const [id, result] of batchResults) {
        keys[id] = serializeKeyChain(result);
      }
      return c.json({ keys }, 200);
    }
  )
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read', { allowLinkGuest: true }),
    async (c) => {
      const publicKey = c.get('user')?.publicKey ?? c.get('linkGuest')?.publicKey;
      if (!publicKey) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const result = await getKeyChain(db, conversationId, publicKey);
      if (!result) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      return c.json(serializeKeyChain(result), 200);
    }
  )
  .get(
    '/:conversationId/member-keys',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
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
