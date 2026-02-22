import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, desc, isNull, sql } from 'drizzle-orm';
import { epochs, sharedLinks } from '@hushbox/db';
import {
  ERROR_CODE_LINK_NOT_FOUND,
  ERROR_CODE_EPOCH_NOT_FOUND,
  ERROR_CODE_MEMBER_LIMIT_REACHED,
  MAX_CONVERSATION_MEMBERS,
  toBase64,
  fromBase64,
  rotationSchema,
} from '@hushbox/shared';
import { createEvent } from '@hushbox/realtime/events';
import { toRotationParams, handleRotationError } from '../services/keys/keys.js';
import type { AppEnv } from '../types.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePrivilege } from '../middleware/require-privilege.js';
import { createErrorResponse } from '../lib/error-response.js';
import { broadcastToRoom } from '../lib/broadcast.js';
import { fireAndForget } from '../lib/fire-and-forget.js';
import { listLinks, createLink, revokeLink, changeLinkPrivilege } from '../services/links/index.js';

export const linksRoute = new Hono<AppEnv>()
  .use('*', requireAuth())
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read'),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const links = await listLinks(db, conversationId);

      return c.json(
        {
          links: links.map((link) => ({
            id: link.id,
            linkPublicKey: toBase64(link.linkPublicKey),
            privilege: link.privilege,
            displayName: link.displayName,
            createdAt: link.createdAt.toISOString(),
          })),
        },
        200
      );
    }
  )
  .post(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    zValidator(
      'json',
      z.object({
        linkPublicKey: z.string(),
        memberWrap: z.string(),
        privilege: z.string(),
        giveFullHistory: z.boolean(),
        displayName: z.string().min(1).max(100).optional(),
      })
    ),
    requirePrivilege('admin'),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const body = c.req.valid('json');

      // Look up current epoch and member count
      const currentEpoch = await db
        .select({
          id: epochs.id,
          epochNumber: epochs.epochNumber,
          memberCount: sql<number>`(
            SELECT count(*)::int FROM conversation_members
            WHERE conversation_id = ${conversationId} AND left_at IS NULL
          )`,
        })
        .from(epochs)
        .where(eq(epochs.conversationId, conversationId))
        .orderBy(desc(epochs.epochNumber))
        .limit(1)
        .then((rows) => rows[0]);

      if (!currentEpoch) {
        return c.json(createErrorResponse(ERROR_CODE_EPOCH_NOT_FOUND), 404);
      }

      if (currentEpoch.memberCount >= MAX_CONVERSATION_MEMBERS) {
        return c.json(createErrorResponse(ERROR_CODE_MEMBER_LIMIT_REACHED), 400);
      }

      const visibleFromEpoch = body.giveFullHistory ? 1 : currentEpoch.epochNumber;

      try {
        const result = await createLink(db, {
          conversationId,
          linkPublicKey: fromBase64(body.linkPublicKey),
          memberWrap: fromBase64(body.memberWrap),
          privilege: body.privilege,
          visibleFromEpoch,
          currentEpochId: currentEpoch.id,
          ...(body.displayName !== undefined && { displayName: body.displayName }),
        });

        return c.json({ linkId: result.linkId, memberId: result.memberId }, 201);
      } catch (error) {
        return handleRotationError(error, c);
      }
    }
  )
  .post(
    '/:conversationId/revoke',
    zValidator('param', z.object({ conversationId: z.string() })),
    zValidator(
      'json',
      z.object({
        linkId: z.string(),
        rotation: rotationSchema,
      })
    ),
    requirePrivilege('admin'),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { linkId, rotation } = c.req.valid('json');

      const rotationParams = toRotationParams(conversationId, rotation);

      try {
        const result = await revokeLink(db, linkId, conversationId, rotationParams);

        if (!result.revoked) {
          return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
        }

        // Fire-and-forget broadcast
        if (result.memberId) {
          fireAndForget(
            broadcastToRoom(
              c.env,
              conversationId,
              createEvent('member:removed', {
                conversationId,
                memberId: result.memberId,
              })
            ),
            'broadcast member:removed event after link revocation'
          );
        }

        // Broadcast rotation:complete (fire-and-forget)
        fireAndForget(
          broadcastToRoom(
            c.env,
            conversationId,
            createEvent('rotation:complete', {
              conversationId,
              newEpochNumber: rotation.expectedEpoch + 1,
            })
          ),
          'broadcast rotation:complete after link revocation'
        );

        return c.json({ revoked: true }, 200);
      } catch (error) {
        return handleRotationError(error, c);
      }
    }
  )
  .patch(
    '/:conversationId/:linkId/privilege',
    zValidator('param', z.object({ conversationId: z.string(), linkId: z.string() })),
    zValidator('json', z.object({ privilege: z.enum(['read', 'write']) })),
    requirePrivilege('admin'),
    async (c) => {
      const db = c.get('db');
      const { conversationId, linkId } = c.req.valid('param');
      const { privilege } = c.req.valid('json');

      const result = await changeLinkPrivilege(db, { conversationId, linkId, privilege });

      if (!result.changed) {
        return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
      }

      if (result.memberId) {
        fireAndForget(
          broadcastToRoom(
            c.env,
            conversationId,
            createEvent('member:privilege-changed', {
              conversationId,
              memberId: result.memberId,
              privilege,
            })
          ),
          'broadcast member:privilege-changed event for link'
        );
      }

      return c.json({ changed: true }, 200);
    }
  )
  .patch(
    '/:conversationId/:linkId/name',
    zValidator('param', z.object({ conversationId: z.string(), linkId: z.string() })),
    zValidator('json', z.object({ displayName: z.string().min(1).max(100) })),
    requirePrivilege('admin'),
    async (c) => {
      const db = c.get('db');
      const { linkId } = c.req.valid('param');
      const { displayName } = c.req.valid('json');

      // Check link exists and is not revoked
      const link = await db
        .select({ id: sharedLinks.id })
        .from(sharedLinks)
        .where(and(eq(sharedLinks.id, linkId), isNull(sharedLinks.revokedAt)))
        .limit(1)
        .then((rows) => rows[0]);

      if (!link) {
        return c.json(createErrorResponse(ERROR_CODE_LINK_NOT_FOUND), 404);
      }

      // Update display name
      await db.update(sharedLinks).set({ displayName }).where(eq(sharedLinks.id, linkId));

      return c.json({ success: true }, 200);
    }
  );
