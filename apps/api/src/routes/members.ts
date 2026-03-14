import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq, and, isNull, sql } from 'drizzle-orm';
import {
  conversationMembers,
  epochMembers,
  epochs,
  conversations,
  users,
  sharedLinks,
  type Database,
} from '@hushbox/db';
import {
  ERROR_CODE_NOT_FOUND,
  ERROR_CODE_VALIDATION,
  ERROR_CODE_CONVERSATION_NOT_FOUND,
  ERROR_CODE_PRIVILEGE_INSUFFICIENT,
  ERROR_CODE_MEMBER_NOT_FOUND,
  ERROR_CODE_ALREADY_MEMBER,
  ERROR_CODE_CANNOT_CHANGE_OWN_PRIVILEGE,
  ERROR_CODE_CANNOT_REMOVE_OWNER,
  ERROR_CODE_CANNOT_REMOVE_SELF,
  ERROR_CODE_MEMBER_LIMIT_REACHED,
  ERROR_CODE_ROTATION_REQUIRED,
  ERROR_CODE_UNAUTHORIZED,
  MAX_CONVERSATION_MEMBERS,
  memberPrivilegeSchema,
  rotationSchema,
  canChangePrivilege,
  canRemoveMember,
  isOwner,
  fromBase64,
} from '@hushbox/shared';
import { createEvent } from '@hushbox/realtime/events';
import type { RealtimeEvent, RealtimeEventType } from '@hushbox/realtime/events';
import type { AppEnv, Bindings } from '../types.js';
import { requirePrivilege } from '../middleware/index.js';
import { createErrorResponse } from '../lib/error-response.js';
import { findActiveMember } from '../lib/db-helpers.js';
import { submitRotation, toRotationParams, handleRotationError } from '../services/keys/keys.js';
import { broadcastToRoom } from '../lib/broadcast.js';
import { fireAndForget } from '../lib/fire-and-forget.js';

interface BroadcastEventOptions<T extends RealtimeEventType> {
  env: Bindings | undefined;
  conversationId: string;
  type: T;
  data: Omit<Extract<RealtimeEvent, { type: T }>, 'type' | 'timestamp'>;
  errorContext: string;
}

/**
 * Fire-and-forget broadcast of a realtime event to a conversation room.
 * Captures the repeated `fireAndForget(broadcastToRoom(env, id, createEvent(...)))` pattern.
 */
function broadcastEvent<T extends RealtimeEventType>(options: BroadcastEventOptions<T>): void {
  fireAndForget(
    broadcastToRoom(options.env, options.conversationId, createEvent(options.type, options.data)),
    options.errorContext
  );
}

export const membersRoute = new Hono<AppEnv>()
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read', { allowLinkGuest: true }),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      const rows = await db
        .select({
          id: conversationMembers.id,
          userId: conversationMembers.userId,
          linkId: conversationMembers.linkId,
          privilege: conversationMembers.privilege,
          visibleFromEpoch: conversationMembers.visibleFromEpoch,
          joinedAt: conversationMembers.joinedAt,
          username: users.username,
          linkDisplayName: sharedLinks.displayName,
        })
        .from(conversationMembers)
        .leftJoin(users, eq(conversationMembers.userId, users.id))
        .leftJoin(sharedLinks, eq(conversationMembers.linkId, sharedLinks.id))
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            isNull(conversationMembers.leftAt)
          )
        );

      return c.json(
        {
          members: rows.map((r) => ({
            id: r.id,
            userId: r.userId ?? r.linkId ?? r.id,
            linkId: r.linkId,
            username: r.username ?? r.linkDisplayName ?? 'Unknown',
            privilege: r.privilege,
            visibleFromEpoch: r.visibleFromEpoch,
            joinedAt: r.joinedAt.toISOString(),
          })),
        },
        200
      );
    }
  )
  .post(
    '/:conversationId/add',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z
        .object({
          userId: z.string(),
          privilege: memberPrivilegeSchema,
          giveFullHistory: z.boolean(),
          wrap: z.string().optional(),
          rotation: rotationSchema.optional(),
        })
        .refine((d) => (d.giveFullHistory ? d.wrap !== undefined : d.rotation !== undefined), {
          message: 'wrap required for full history, rotation required without history',
        })
    ),
    // eslint-disable-next-line sonarjs/cognitive-complexity, complexity -- add-member handler has inherent branching from giveFullHistory/rotation/wrap guards
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const {
        userId: targetUserId,
        wrap,
        privilege,
        giveFullHistory,
        rotation,
      } = c.req.valid('json');

      // 1. Verify target user exists and has a publicKey
      const targetUser = await db
        .select({
          id: users.id,
          publicKey: users.publicKey,
          username: users.username,
        })
        .from(users)
        .where(eq(users.id, targetUserId))
        .limit(1)
        .then((rows) => rows[0]);

      if (!targetUser) {
        return c.json(createErrorResponse(ERROR_CODE_NOT_FOUND), 404);
      }

      // 2. Look up conversation and current epoch
      const convEpoch = await db
        .select({
          conversation: { id: conversations.id, currentEpoch: conversations.currentEpoch },
          epoch: { id: epochs.id, epochNumber: epochs.epochNumber },
          memberCount: sql<number>`(
            SELECT count(*)::int FROM conversation_members
            WHERE conversation_id = ${conversationId} AND left_at IS NULL
          )`,
        })
        .from(conversations)
        .innerJoin(
          epochs,
          and(
            eq(epochs.conversationId, conversations.id),
            eq(epochs.epochNumber, conversations.currentEpoch)
          )
        )
        .where(eq(conversations.id, conversationId))
        .limit(1)
        .then((rows) => rows[0]);

      if (!convEpoch) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }

      if (convEpoch.memberCount >= MAX_CONVERSATION_MEMBERS) {
        return c.json(createErrorResponse(ERROR_CODE_MEMBER_LIMIT_REACHED), 400);
      }

      // 3. Compute visibleFromEpoch server-side
      let visibleFromEpoch: number;
      if (giveFullHistory) {
        visibleFromEpoch = 1;
      } else {
        if (!rotation) {
          return c.json(createErrorResponse(ERROR_CODE_VALIDATION), 400);
        }
        visibleFromEpoch = rotation.expectedEpoch + 1;
      }

      // 4. Atomically insert conversationMembers + (epochMembers wrap OR epoch rotation)
      try {
        const newMember = await db.transaction(async (tx) => {
          const [memberRow] = await tx
            .insert(conversationMembers)
            .values({
              conversationId,
              userId: targetUserId,
              privilege,
              visibleFromEpoch,
              acceptedAt: null,
              invitedByUserId: user.id,
            })
            .onConflictDoNothing({
              target: [conversationMembers.conversationId, conversationMembers.userId],
              where: isNull(conversationMembers.leftAt),
            })
            .returning();

          if (!memberRow) {
            return null;
          }

          if (giveFullHistory) {
            // Full history: insert wrap for current epoch
            if (!wrap) throw new Error('invariant: wrap required for full history');
            const wrapBytes = fromBase64(wrap);
            await tx.insert(epochMembers).values({
              epochId: convEpoch.epoch.id,
              memberPublicKey: targetUser.publicKey,
              wrap: wrapBytes,
              visibleFromEpoch,
            });
          } else {
            // Without history: rotate epoch (creates new epoch + wraps for all members)
            if (!rotation) throw new Error('invariant: rotation required without history');
            await submitRotation(
              tx as unknown as Database,
              toRotationParams(conversationId, rotation)
            );
          }

          return memberRow;
        });

        if (!newMember) {
          return c.json(createErrorResponse(ERROR_CODE_ALREADY_MEMBER), 409);
        }

        // 5. Broadcast member:added event (fire-and-forget)
        broadcastEvent({
          env: c.env,
          conversationId,
          type: 'member:added',
          data: {
            conversationId,
            memberId: newMember.id,
            userId: targetUserId,
            privilege,
          },
          errorContext: 'broadcast member:added event',
        });

        // 6. Broadcast rotation:complete if epoch rotated (no rotation for full history)
        if (!giveFullHistory && rotation) {
          broadcastEvent({
            env: c.env,
            conversationId,
            type: 'rotation:complete',
            data: {
              conversationId,
              newEpochNumber: rotation.expectedEpoch + 1,
            },
            errorContext: 'broadcast rotation:complete after add-member rotation',
          });
        }

        return c.json(
          {
            member: {
              id: newMember.id,
              userId: targetUserId,
              username: targetUser.username,
              privilege,
              visibleFromEpoch,
              joinedAt: newMember.joinedAt.toISOString(),
            },
          },
          201
        );
      } catch (error) {
        return handleRotationError(error, c);
      }
    }
  )
  .post(
    '/:conversationId/remove',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z.object({
        memberId: z.string(),
        rotation: rotationSchema,
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { memberId, rotation } = c.req.valid('json');
      const requesterMember = c.get('member');

      // 1. Look up target membership by memberId
      const targetMember = await findActiveMember(db, memberId, conversationId);

      if (!targetMember) {
        return c.json(createErrorResponse(ERROR_CODE_MEMBER_NOT_FOUND), 404);
      }

      // 2. Cannot remove self (use /leave instead)
      if (targetMember.userId === user.id) {
        return c.json(createErrorResponse(ERROR_CODE_CANNOT_REMOVE_SELF), 400);
      }

      // 3. Cannot remove the owner
      if (isOwner(targetMember.privilege)) {
        return c.json(createErrorResponse(ERROR_CODE_CANNOT_REMOVE_OWNER), 403);
      }

      // 4. Validate privilege hierarchy
      if (!canRemoveMember(requesterMember.privilege, targetMember.privilege)) {
        return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
      }

      // 5. Atomic transaction: set leftAt + rotate epoch
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(conversationMembers)
            .set({ leftAt: new Date() })
            .where(eq(conversationMembers.id, memberId));

          await submitRotation(
            tx as unknown as Database,
            toRotationParams(conversationId, rotation)
          );
        });
      } catch (error) {
        return handleRotationError(error, c);
      }

      // 6. Broadcast member:removed event (fire-and-forget)
      broadcastEvent({
        env: c.env,
        conversationId,
        type: 'member:removed',
        data: {
          conversationId,
          memberId,
          ...(targetMember.userId != null && { userId: targetMember.userId }),
        },
        errorContext: 'broadcast member:removed event',
      });

      // 7. Broadcast rotation:complete (fire-and-forget)
      broadcastEvent({
        env: c.env,
        conversationId,
        type: 'rotation:complete',
        data: {
          conversationId,
          newEpochNumber: rotation.expectedEpoch + 1,
        },
        errorContext: 'broadcast rotation:complete after member removal',
      });

      return c.json({ removed: true }, 200);
    }
  )
  .patch(
    '/:conversationId/privilege',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('admin'),
    zValidator(
      'json',
      z.object({
        memberId: z.string(),
        privilege: memberPrivilegeSchema,
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { memberId, privilege: newPrivilege } = c.req.valid('json');
      const requesterMember = c.get('member');

      // 1. Look up target membership by memberId
      const targetMember = await findActiveMember(db, memberId, conversationId);

      if (!targetMember) {
        return c.json(createErrorResponse(ERROR_CODE_MEMBER_NOT_FOUND), 404);
      }

      // 2. Cannot change own privilege
      if (targetMember.userId === user.id) {
        return c.json(createErrorResponse(ERROR_CODE_CANNOT_CHANGE_OWN_PRIVILEGE), 403);
      }

      // 3. Validate privilege hierarchy
      if (!canChangePrivilege(requesterMember.privilege, targetMember.privilege, newPrivilege)) {
        return c.json(createErrorResponse(ERROR_CODE_PRIVILEGE_INSUFFICIENT), 403);
      }

      // 4. Update privilege
      await db
        .update(conversationMembers)
        .set({ privilege: newPrivilege })
        .where(eq(conversationMembers.id, memberId));

      // 5. Broadcast privilege change (fire-and-forget)
      broadcastEvent({
        env: c.env,
        conversationId,
        type: 'member:privilege-changed',
        data: {
          conversationId,
          memberId,
          privilege: newPrivilege,
        },
        errorContext: 'broadcast member:privilege-changed event',
      });

      return c.json(
        {
          updated: true,
          memberId,
          privilege: newPrivilege,
        },
        200
      );
    }
  )
  .post(
    '/:conversationId/leave',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read'),
    zValidator(
      'json',
      z.object({
        rotation: rotationSchema.optional(),
      })
    ),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { rotation } = c.req.valid('json');
      const requesterMember = c.get('member');

      // Owner leaving deletes the entire conversation (CASCADE handles cleanup)
      if (isOwner(requesterMember.privilege)) {
        await db.delete(conversations).where(eq(conversations.id, conversationId));
        return c.json({ deleted: true }, 200);
      }

      // Non-owner: rotation is always required (owner always remains)
      if (!rotation) {
        return c.json(createErrorResponse(ERROR_CODE_ROTATION_REQUIRED), 400);
      }

      // Non-owner: atomic transaction to leave + rotate epoch
      try {
        await db.transaction(async (tx) => {
          await tx
            .update(conversationMembers)
            .set({ leftAt: new Date() })
            .where(eq(conversationMembers.id, requesterMember.id));

          await submitRotation(
            tx as unknown as Database,
            toRotationParams(conversationId, rotation)
          );
        });
      } catch (error) {
        return handleRotationError(error, c);
      }

      // Broadcast member:removed event (fire-and-forget)
      broadcastEvent({
        env: c.env,
        conversationId,
        type: 'member:removed',
        data: {
          conversationId,
          memberId: requesterMember.id,
          userId: user.id,
        },
        errorContext: 'broadcast member:removed event after leave',
      });

      // Broadcast rotation:complete (fire-and-forget)
      broadcastEvent({
        env: c.env,
        conversationId,
        type: 'rotation:complete',
        data: {
          conversationId,
          newEpochNumber: rotation.expectedEpoch + 1,
        },
        errorContext: 'broadcast rotation:complete after leave',
      });

      return c.json({ left: true }, 200);
    }
  )
  .patch(
    '/:conversationId/mute',
    zValidator('param', z.object({ conversationId: z.string() })),
    zValidator('json', z.object({ muted: z.boolean() })),
    requirePrivilege('read'),
    async (c) => {
      const user = c.get('user');
      if (!user) {
        return c.json(createErrorResponse(ERROR_CODE_UNAUTHORIZED), 401);
      }
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { muted } = c.req.valid('json');

      await db
        .update(conversationMembers)
        .set({ muted })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id),
            isNull(conversationMembers.leftAt)
          )
        )
        .returning({ id: conversationMembers.id });

      return c.json({ muted }, 200);
    }
  )
  .patch(
    '/:conversationId/accept',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read'),
    async (c) => {
      const user = c.get('user');
      if (!user) throw new Error('User required after requirePrivilege');
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');

      // Atomic conditional update — idempotent: already accepted → still returns 200
      await db
        .update(conversationMembers)
        .set({ acceptedAt: new Date() })
        .where(
          and(
            eq(conversationMembers.conversationId, conversationId),
            eq(conversationMembers.userId, user.id),
            isNull(conversationMembers.leftAt)
          )
        )
        .returning({ id: conversationMembers.id });

      return c.json({ accepted: true }, 200);
    }
  );
