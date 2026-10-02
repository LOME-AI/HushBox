import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { ERROR_CODES, createConversationBodySchema } from '@hushbox/shared';
import { DECLARED_CURSORS_PARAM } from '@hushbox/realtime/protocol';
import {
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../../middleware/pipeline-manifest.js';
import { isAllowedOrigin } from '../../../middleware/csrf.js';
import {
  callerUserId,
  conversationIdParameterSchema,
  createConversation,
  createConversationOutcomeSchema,
  createErrorResponse,
  freshUpgradeTicketGrant,
  getConversation,
  idempotencyExempt,
  idempotent,
  issueUpgradeTicket,
  listConversations,
  listConversationsQuerySchema,
  runMutation,
} from '../domain/index.js';
import { respond200, runByKey } from './handler-tail.js';
import {
  authorizeCaller,
  authorizeUpgradeCaller,
  resolveUpgradePrincipal,
} from './caller-authorization.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { ConversationsRouteDeps } from './deps.js';

export function conversationRoutes(deps: ConversationsRouteDeps) {
  return (
    new Hono<AppEnv>()
      .post(
        '/',
        routeClass('session'),
        zValidator('json', createConversationBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const caller = callerUserId(c.var.principal);
          const result = await runByKey({
            c,
            body,
            responseSchema: createConversationOutcomeSchema,
            execute: (tx) => createConversation(deps.stores(tx), { callerUserId: caller, ...body }),
          });
          return respond200(c, result);
        }
      )
      .get(
        '/',
        routeClass('session'),
        zValidator('query', listConversationsQuerySchema, rejectInvalid),
        async (c) => {
          const { cursor, limit } = c.req.valid('query');
          const result = await listConversations(deps.stores(c.var.db), {
            callerUserId: callerUserId(c.var.principal),
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          });
          return result.match(
            (page) => c.json(page, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Guest-reachable read: `public` by necessity (the HTTP matrix admits no
      // link-guest principal), so the handler resolves the caller — a full
      // session OR a live link credential — itself. A link guest reads exactly
      // the member data for its own conversation; the domain read gates on the
      // active member row (a revoked guest gets not-found).
      .get(
        '/:conversationId',
        routeClass('public'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await getConversation(deps.stores(c.var.db), { conversationId, caller });
          return respond200(c, result);
        }
      )
      // A link guest's single-use socket ticket, minted with its credential
      // header and presented on the upgrade, because the credential itself must
      // never ride a URL. `public` because the HTTP matrix admits no link-guest
      // principal; only a link guest may mint — a session opens its socket with
      // its cookie.
      .post(
        '/:conversationId/websocket-ticket',
        routeClass('public'),
        idempotencyExempt('fresh-ephemeral-grant'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = await authorizeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const result = await runMutation(() =>
            idempotent.byEventId(
              freshUpgradeTicketGrant(() =>
                issueUpgradeTicket({
                  stores: deps.stores(c.var.db),
                  redis: c.var.redis,
                  conversationId,
                  caller,
                })
              )
            )
          );
          return respond200(c, result);
        }
      )
      // The realtime WebSocket upgrade. `public` by necessity: a link guest has
      // no session principal, so the handler resolves the caller — full session
      // OR a ticket its link credential minted — and authorizes membership
      // BEFORE the socket is proxied to the DO. A full session upgrades as a
      // user; an active link guest upgrades with `isGuest: true` (principalId =
      // its linkId). A non-member, a revoked guest (member row left), or a
      // guest of another conversation never upgrades. The adapter returns the
      // DO's 101 untouched.
      .get(
        '/:conversationId/websocket',
        routeClass('public'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const caller = await authorizeUpgradeCaller(deps, c, conversationId);
          if (caller instanceof Response) return caller;
          const principal = await resolveUpgradePrincipal(deps, c, conversationId, caller);
          if (principal instanceof Response) return principal;
          // CSWSH guard before the socket opens: the handshake is a GET
          // (structurally exempt from csrfProtection), the session cookie is
          // SameSite=None, and CORS never gates a handshake — so a cross-site
          // page could otherwise open an authenticated socket as the victim.
          // Reject any Origin (missing included) not in the CSRF allowlist,
          // against the same shared source as mutating HTTP.
          const origin = c.req.header('Origin');
          if (origin === undefined || !isAllowedOrigin(origin, c.env)) {
            return c.json(createErrorResponse(ERROR_CODES.CSRF_REJECTED), 403);
          }
          // The client's replay position rides the upgrade query (a browser
          // WebSocket can set no headers). Forwarded raw and bounded at the
          // realtime port, which refuses a malformed declaration.
          const upgraded = await deps
            .realtime(c.env)
            .upgrade(
              conversationId,
              principal,
              c.req.raw.headers,
              c.req.query(DECLARED_CURSORS_PARAM) ?? null
            );
          return upgraded.match(
            (response) => response,
            (error) => respondDomainError(c, error)
          );
        }
      )
  );
}
