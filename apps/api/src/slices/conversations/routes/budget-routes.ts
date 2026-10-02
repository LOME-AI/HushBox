import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { serializeNanoUSD } from '@hushbox/shared';
import { rejectInvalid, routeClass } from '../../../middleware/pipeline-manifest.js';
import {
  callerUserId,
  conversationIdParameterSchema,
  getConversationBudgets,
  getGuestFunding,
  memberParameterSchema,
  setBudgetOutcomeSchema,
  setConversationBudget,
  setConversationBudgetBodySchema,
  setMemberBudget,
  setMemberBudgetBodySchema,
} from '../domain/index.js';
import { respond200, runByKey } from './handler-tail.js';
import { authorizeCaller } from './caller-authorization.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './deps.js';

export function budgetRoutes(deps: ConversationsRouteDeps) {
  return (
    new Hono<AppEnv>()
      // Group-budget management, gated on the legacy privilege ladder inside
      // each domain function: setting a per-member cap needs admin+, setting the
      // per-conversation cap needs owner, and the display is readable by any
      // active member (a non-owner sees only their own figures; the owner sees
      // all). A stranger is refused `forbidden` (403). Link-guest and other
      // non-session principals never reach these `session`-class routes — they
      // are refused upstream at the pipeline, so budget-view over HTTP is a
      // signed-in-member surface only. Caps are nano-USD and cross the JSON
      // boundary as canonical `NanoUSD` strings.
      .put(
        '/:conversationId/member/:memberId/budget',
        routeClass('session'),
        zValidator('param', memberParameterSchema, rejectInvalid),
        zValidator('json', setMemberBudgetBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId, memberId } = c.req.valid('param');
          const { capNanoUsd } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, memberId, capNanoUsd: serializeNanoUSD(capNanoUsd) },
            responseSchema: setBudgetOutcomeSchema,
            execute: (tx) =>
              setMemberBudget(
                deps.stores(tx),
                (id, cap) => deps.billing.setMemberBudgetCapWithinTx(tx, id, cap),
                { conversationId, memberId, callerUserId: caller, capNanoUsd }
              ),
          });
          return respond200(c, result);
        }
      )
      .put(
        '/:conversationId/budget',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', setConversationBudgetBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const { capNanoUsd } = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body: { conversationId, capNanoUsd: serializeNanoUSD(capNanoUsd) },
            responseSchema: setBudgetOutcomeSchema,
            execute: (tx) =>
              setConversationBudget(
                deps.stores(tx),
                (id) => deps.billing.lockConversationSpentWithinTx(tx, id),
                {
                  conversationId,
                  callerUserId: caller,
                  capNanoUsd,
                }
              ),
          });
          return respond200(c, result);
        }
      )
      .get(
        '/:conversationId/budgets',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const result = await getConversationBudgets(
            {
              stores: deps.stores(c.var.db),
              billing: deps.billing,
              db: c.var.db,
              redis: c.var.redis,
            },
            {
              conversationId,
              callerUserId: callerUserId(c.var.principal),
              now: new Date(),
            }
          );
          return respond200(c, result);
        }
      )
      // The link guest's funding door. `/billing/spendable` is
      // billing-token-classed and a guest presents no session, so the PAYER's
      // snapshot — the conversation owner's, by §Group Funding 1 — is served
      // here instead, from the same producer and in the same shape. `public` by
      // necessity plus the in-handler credential gate every guest-reachable read
      // uses; a full session is refused, because a caller with a wallet has its
      // own door and one handler serving both principals is how a gate ends up
      // written for only one of them.
      .get(
        '/:conversationId/funding',
        routeClass('public'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await getGuestFunding(
            {
              stores: deps.stores(c.var.db),
              billing: deps.billing,
              db: c.var.db,
              redis: c.var.redis,
            },
            { conversationId, caller, now: new Date() }
          );
          return respond200(c, result);
        }
      )
  );
}
