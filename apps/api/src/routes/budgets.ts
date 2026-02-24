import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { conversations } from '@hushbox/db';
import { effectiveBudgetCents, ERROR_CODE_CONVERSATION_NOT_FOUND } from '@hushbox/shared';
import { createErrorResponse } from '../lib/error-response.js';
import type { AppEnv } from '../types.js';
import { requireAuth } from '../middleware/require-auth.js';
import { requirePrivilege } from '../middleware/require-privilege.js';
import {
  getConversationBudgets,
  updateMemberBudget,
  updateConversationBudget,
  computeGroupRemaining,
} from '../services/billing/budgets.js';
import { getUserTierInfo } from '../services/billing/balance.js';
import { getGroupReservedTotals } from '../lib/speculative-balance.js';

export const budgetsRoute = new Hono<AppEnv>()
  .use('*', requireAuth())
  .get(
    '/:conversationId',
    zValidator('param', z.object({ conversationId: z.string() })),
    requirePrivilege('read'),
    async (c) => {
      const db = c.get('db');
      const redis = c.get('redis');
      const member = c.get('member');
      const { conversationId } = c.req.valid('param');

      const result = await getConversationBudgets(db, conversationId);

      // Query conversation owner
      const convRow = await db
        .select({ userId: conversations.userId })
        .from(conversations)
        .where(eq(conversations.id, conversationId))
        .limit(1)
        .then((rows) => rows[0]);

      if (!convRow) {
        return c.json(createErrorResponse(ERROR_CODE_CONVERSATION_NOT_FOUND), 404);
      }
      const ownerId = convRow.userId;

      // Get owner balance and Redis reservation totals
      const [ownerTierInfo, reserved] = await Promise.all([
        getUserTierInfo(db, ownerId),
        getGroupReservedTotals(redis, conversationId, member.id, ownerId),
      ]);

      // Find the current member's budget
      const currentMemberBudget = result.memberBudgets.find((mb) => mb.memberId === member.id);

      // Exclude the conversation owner from the member budgets response —
      // the owner funds all budgets and doesn't need a personal spending limit.
      const filteredMemberBudgets = result.memberBudgets.filter((mb) => mb.privilege !== 'owner');

      const groupRemaining = computeGroupRemaining({
        conversationBudget: result.conversationBudget,
        conversationSpent: result.totalSpent,
        memberBudget: currentMemberBudget?.budget ?? '0.00',
        memberSpent: currentMemberBudget?.spent ?? '0',
        ownerBalanceCents: ownerTierInfo.balanceCents,
        reserved,
      });

      const effective = effectiveBudgetCents(groupRemaining);

      return c.json(
        {
          conversationBudget: result.conversationBudget,
          totalSpent: result.totalSpent,
          memberBudgets: filteredMemberBudgets,
          effectiveDollars: effective / 100,
          ownerTier: ownerTierInfo.tier,
          ownerBalanceDollars: ownerTierInfo.balanceCents / 100,
          memberBudgetDollars: Number.parseFloat(currentMemberBudget?.budget ?? '0.00'),
        },
        200
      );
    }
  )
  .patch(
    '/:conversationId/member/:memberId',
    zValidator('param', z.object({ conversationId: z.string(), memberId: z.string() })),
    zValidator(
      'json',
      z.object({
        budgetCents: z.number().int().min(0),
      })
    ),
    requirePrivilege('admin'),
    async (c) => {
      const db = c.get('db');
      const { memberId } = c.req.valid('param');
      const { budgetCents } = c.req.valid('json');

      await updateMemberBudget(db, memberId, budgetCents);

      return c.json({ updated: true }, 200);
    }
  )
  .patch(
    '/:conversationId/budget',
    zValidator('param', z.object({ conversationId: z.string() })),
    zValidator(
      'json',
      z.object({
        budgetCents: z.number().int().min(0),
      })
    ),
    requirePrivilege('owner'),
    async (c) => {
      const db = c.get('db');
      const { conversationId } = c.req.valid('param');
      const { budgetCents } = c.req.valid('json');

      await updateConversationBudget(db, conversationId, budgetCents);

      return c.json({ updated: true }, 200);
    }
  );
