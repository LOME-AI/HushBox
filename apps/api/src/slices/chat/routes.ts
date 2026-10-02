import { Hono } from 'hono';
import { routePath } from 'hono/route';
import { zValidator } from '@hono/zod-validator';
import {
  ERROR_CODES,
  canSendMessages,
  regenerateTurnBodySchema,
  senderPrincipalId,
  startTurnBodySchema,
  stopTurnBodySchema,
  trialTurnBodySchema,
  userOnlyMessageSchema,
} from '@hushbox/shared';
import { DECLARED_CURSORS_PARAM } from '@hushbox/realtime/protocol';
import {
  defineSliceManifest,
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import {
  LINK_CREDENTIAL_HEADER,
  broadcastUserMessageNew,
  callerIpId,
  callerUserId,
  canRegenerate,
  consumeTrialQuota,
  consumeTrialRemainingIpLimit,
  createErrorResponse,
  hashRequestBody,
  idempotent,
  memberAdmits,
  readTrialQuotaRemaining,
  resolveCallerMember,
  resolveConversationCaller,
  resolveTrialSessionPrincipal,
  runMutation,
  saveUserOnlyMessage,
  storesNewUserMessage,
  turnInputs,
} from './domain/index.js';
import {
  conversationIdParameterSchema,
  releaseStreamQuerySchema,
  releaseStreamResponseSchema,
  randomUuid,
  normalizedHistory,
  mockDirectivesBody,
  runScopedInstructions,
  turnPromptCharacterCount,
  requiredIdempotencyKey,
  userOnlyMessageResponseSchema,
  startTurnBodyHash,
  regenerateTurnBodyHash,
} from './routes/request-shapes.js';
import {
  regenerateRejection,
  rateLimitRejection,
  chatUserRateLimitRejection,
  trialPreWorkRejection,
  respondRunStart,
  respondTrialRunStart,
} from './routes/refusals.js';
import { turnDefinitionOrRefusal } from './routes/turn-definition.js';
import { trialTurnDefinitionOrRefusal } from './routes/trial-definition.js';
import { regeneratePremiumTierGate, resolveGatedTurnContext } from './routes/payer-seam.js';
import type { Context } from 'hono';
import type { SenderPrincipal } from '@hushbox/shared';
import type { RunStartBody } from '@hushbox/realtime';
import type { AppEnv, RefusalResponse } from '../../middleware/pipeline-manifest.js';
import type { ChatRouteDeps, GatedCallerAction, TurnBudget } from './domain/index.js';
import type { ReleaseStreamRoomEnv } from './routes/request-shapes.js';
import type { PaidRun } from './routes/payer-seam.js';

/**
 * Resolves and gates the link-guest caller for a public chat route,
 * SERVER-SIDE, returning a refusal `Response` or the resolved `SenderPrincipal`.
 * Gates, in order: the presented credential resolves a caller (else 401 — no
 * session and no live link, which is where a revoked or expired link lands); a
 * guest's credential is bound to THIS conversation (the typed match, else 403);
 * the caller holds an active member row (else 403 — a revoked/departed guest
 * resolves to null); the member carries the privilege {@link GatedCallerAction}
 * demands (else 403). Nothing is trusted from the request body — the guest's
 * linkId/conversationId come from the credential and the member from the active
 * row, so a spoofed body id can never elevate a send or a stop.
 */
async function resolveGuestSenderOrRefusal(
  c: Context<AppEnv>,
  deps: ChatRouteDeps,
  conversationId: string,
  action: GatedCallerAction
): Promise<RefusalResponse | SenderPrincipal> {
  const resolved = await resolveConversationCaller({
    principal: c.var.principal,
    linkCredential: c.req.header(LINK_CREDENTIAL_HEADER),
    linkResolution: deps.linkResolution(c.var.db),
  });
  if (resolved.isErr()) return respondDomainError(c, resolved.error);
  const caller = resolved.value;
  if (caller === null) {
    return c.json(createErrorResponse(ERROR_CODES.UNAUTHORIZED), 401);
  }
  if (caller.kind === 'linkGuest' && caller.conversationId !== conversationId) {
    return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
  }
  const member = await resolveCallerMember(deps.conversations(c.var.db), conversationId, caller);
  if (member.isErr()) return respondDomainError(c, member.error);
  if (!memberAdmits(action, caller, member.value)) {
    return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
  }
  return caller.kind === 'user'
    ? { kind: 'user', userId: caller.userId }
    : { kind: 'linkGuest', linkId: caller.linkId };
}

/**
 * The paid run-start body every paid entrypoint (send, guest send, regenerate)
 * hands the DO. The routes differ only in what they resolved — the payer
 * context and whether a re-run block is present — so the field list is stated
 * once here rather than restated per route: a hand-maintained copy is what lets
 * a field migration compile green after two of the three were updated.
 *
 * The PAYER rides `userId` and the SENDER rides `sender`, which is what lets the
 * guest send reuse this unchanged — its owner-funded context resolves the two to
 * different principals.
 */
function paidRunStartBody(c: Context<AppEnv>, run: PaidRun): RunStartBody {
  return {
    mode: 'paid',
    runKey: run.runKey,
    bodyHash: run.bodyHash,
    definition: run.definition.definition,
    inputs: turnInputs(run.definition, run.body.userMessage.content, run.history),
    history: run.history,
    userId: run.context.payerUserId,
    sender: run.context.sender,
    walletId: run.context.walletId,
    epochNumber: run.context.epochNumber,
    userMessage: { id: run.userMessageId, content: run.body.userMessage.content },
    ...(run.body.forkId === undefined ? {} : { forkId: run.body.forkId }),
    ...(run.regenerate === undefined ? {} : { regenerate: run.regenerate }),
    // Run-scoped client context, never baked into the definition (which stays
    // free of user content, safe to log).
    ...runScopedInstructions(run.body),
    ...mockDirectivesBody(c),
  };
}

/**
 * The chat turn's HTTP surface. The route resolves the run identity (paying
 * wallet, current epoch), compiles the single-model turn, and hands the run to
 * the conversation DO — the DO owns the referee claim, deadline, streaming, and
 * settlement. No business logic settles here; the handler only composes.
 *
 * The return type is deliberately inferred so the route schema flows into
 * `AppType` (annotating `Hono<AppEnv>` erases it to `BlankSchema`).
 */
export function createChatManifest(deps: ChatRouteDeps) {
  return defineSliceManifest({
    basePath: '/chat',
    routes: new Hono<AppEnv>()
      .post(
        '/',
        routeClass('session'),
        zValidator('json', startTurnBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const runKey = requiredIdempotencyKey(c);

          // History always rides the hash normalized — absent and [] must
          // hash identically, so a client upgrade never causes a spurious 409.
          // Normalized BEFORE the payer freeze: the same characters price the
          // turn's minimum and, below, the output-token ceiling's input estimate.
          const history = normalizedHistory(body.history);
          const promptCharacterCount = turnPromptCharacterCount(
            body,
            body.userMessage.content,
            history
          );

          // One count for both: the freeze reserves the prompt storage the
          // definition's stamp will make admission hold.
          const inputCharacterCount = body.userMessage.content.length;

          const context = await resolveGatedTurnContext(c, deps, body, {
            sender: { kind: 'user', userId },
            premiumTierGate: 'enforced',
            promptCharacterCount,
            inputCharacterCount,
          });
          if (context instanceof Response) return context;

          const budget: TurnBudget = {
            promptCharacterCount,
            inputCharacterCount,
            funding: context.funding,
          };
          const definition = await turnDefinitionOrRefusal(c, deps, body, { userId, budget });
          if (definition instanceof Response) return definition;

          const bodyHash = startTurnBodyHash(body, history);
          const userMessageId = randomUuid();
          const runStartBody = paidRunStartBody(c, {
            body,
            runKey,
            bodyHash,
            definition,
            history,
            context,
            userMessageId,
          });

          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(body.conversationId, runStartBody),
            userMessageId
          );
        }
      )
      // The link-guest send: the SAME single-run/single-settlement paid pipeline
      // as `POST /` (reused, not a parallel path), reached on a PUBLIC route
      // because the HTTP matrix admits no link-guest principal. It resolves the
      // guest SERVER-SIDE from its `x-link-auth` credential (never a
      // client-claimed id), then gates on the active member row, its WRITE
      // privilege, and the typed conversation match, before deferring to the same
      // turn-context/startRun path. The server accepts a guest's `forkId` and
      // validates it downstream, so a guest may send onto an existing branch.
      // A write-privileged guest is also rendered a Fork control, while the
      // fork-management routes are session-classed and answer 401 without a
      // session — so pressing it cannot succeed. That gap is a product one and
      // is not closed here. The OWNER funds the turn; the guest is the sender.
      .post(
        '/guest',
        routeClass('public'),
        zValidator('json', startTurnBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const runKey = requiredIdempotencyKey(c);

          // Resolve and gate the guest SERVER-SIDE (credential → active member →
          // WRITE → typed conversation match); nothing is trusted from the body.
          const gated = await resolveGuestSenderOrRefusal(c, deps, body.conversationId, 'send');
          if (gated instanceof Response) return gated;
          const sender = gated;

          // Flood protection keyed on the sender principal (linkId for a guest).
          const rateLimited = await chatUserRateLimitRejection(c, senderPrincipalId(sender));
          if (rateLimited !== null) return rateLimited;

          const history = normalizedHistory(body.history);
          const promptCharacterCount = turnPromptCharacterCount(
            body,
            body.userMessage.content,
            history
          );

          // One count for both: the freeze reserves the prompt storage the
          // definition's stamp will make admission hold.
          const inputCharacterCount = body.userMessage.content.length;

          const context = await resolveGatedTurnContext(c, deps, body, {
            sender,
            premiumTierGate: 'enforced',
            promptCharacterCount,
            inputCharacterCount,
          });
          if (context instanceof Response) return context;

          const budget: TurnBudget = {
            promptCharacterCount,
            inputCharacterCount,
            funding: context.funding,
          };
          const definition = await turnDefinitionOrRefusal(c, deps, body, {
            userId: context.payerUserId,
            budget,
          });
          if (definition instanceof Response) return definition;

          const bodyHash = startTurnBodyHash(body, history);
          const userMessageId = randomUuid();
          const runStartBody = paidRunStartBody(c, {
            body,
            runKey,
            bodyHash,
            definition,
            history,
            context,
            userMessageId,
          });

          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(body.conversationId, runStartBody),
            userMessageId
          );
        }
      )
      // The regenerate/edit turn: the SAME paid pipeline, but the settlement
      // deletes the superseded reply(s) and re-parents the new one. Two extra
      // pre-run gates: the target must belong to the conversation (404), and a
      // group regenerate must not delete across another member's message (403).
      .post(
        '/regenerate',
        routeClass('session'),
        zValidator('json', regenerateTurnBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const userId = callerUserId(c.var.principal);
          const runKey = requiredIdempotencyKey(c);

          // Normalized and measured BEFORE the payer freeze: the re-run prompt
          // + resent history price the turn's minimum and, below, the
          // output-token ceiling's input estimate. Absent and [] hash
          // identically, so a client upgrade never causes a spurious 409.
          const history = normalizedHistory(body.history);
          const promptCharacterCount = turnPromptCharacterCount(
            body,
            body.userMessage.content,
            history
          );

          // A retry re-runs against the anchor the original turn stored, so its
          // resent prompt rests nowhere new: it reserves no storage at the
          // freeze and stamps none for admission. The gate is settlement's own
          // predicate — the one deciding whether this turn is CHARGED that
          // storage — so the three cannot disagree.
          const inputCharacterCount = storesNewUserMessage(body)
            ? body.userMessage.content.length
            : 0;

          const premiumTierGate = await regeneratePremiumTierGate(c, deps, body);
          if (premiumTierGate instanceof Response) return premiumTierGate;

          const context = await resolveGatedTurnContext(c, deps, body, {
            sender: { kind: 'user', userId },
            premiumTierGate,
            promptCharacterCount,
            inputCharacterCount,
          });
          if (context instanceof Response) return context;

          const decision = await canRegenerate(deps.conversations(c.var.db), {
            conversationId: body.conversationId,
            targetMessageId: body.targetMessageId,
            userId,
            action: body.action,
            forkId: body.forkId,
            replaceAssistantId: body.replaceAssistantId,
          });
          if (decision.isErr()) return respondDomainError(c, decision.error);
          const rejection = regenerateRejection(c, decision.value.decision);
          if (rejection !== null) return rejection;

          // Symmetric with `/chat`: absent `models` is the single-model
          // regenerate (`model` is the anchor); two or more fans out.
          const budget: TurnBudget = {
            promptCharacterCount,
            inputCharacterCount,
            funding: context.funding,
          };
          // The SAME resolver as the send paths — a regenerate resolves media
          // lists, the Smart Model sentinel, multi-model fan-out, and the
          // web-search flag identically.
          const definition = await turnDefinitionOrRefusal(c, deps, body, { userId, budget });
          if (definition instanceof Response) return definition;

          // The client-intent fields that scope idempotency dedup; the
          // server-derived observed tip is bound to the run body below, NOT the
          // body hash — a retry after the tip legitimately moved must not 409.
          const regenerateCore = {
            action: body.action,
            targetMessageId: body.targetMessageId,
            ...(body.replaceAssistantId === undefined
              ? {}
              : { replaceAssistantId: body.replaceAssistantId }),
          };
          const bodyHash = regenerateTurnBodyHash(body, history, regenerateCore);
          // Carry the tip the guard validated its deletable tail against so the
          // settlement can assert the fork-row-locked tip still matches it (the
          // fork-tip TOCTOU fence). Only meaningful on a fork regenerate.
          const regenerate = {
            ...regenerateCore,
            ...(body.forkId === undefined
              ? {}
              : { observedForkTipId: decision.value.observedForkTipId }),
          };
          // A retry stores no new user row: its user message is the anchor.
          const userMessageId = storesNewUserMessage(body) ? randomUuid() : body.targetMessageId;
          const runStartBody = paidRunStartBody(c, {
            body,
            runKey,
            bodyHash,
            definition,
            history,
            context,
            userMessageId,
            regenerate,
          });

          return respondRunStart(
            c,
            deps.realtime(c.env).startRun(body.conversationId, runStartBody),
            userMessageId
          );
        }
      )
      // The trial turn: the SAME single-model pipeline under the no-persist /
      // no-charge policy. Public (no session) — an authenticated caller is
      // refused; a trial-session principal is resolved from `x-trial-token`,
      // never a cookie. The 5/day dual-identity quota (token + IP) lives here
      // because only the route holds both; the global Sybil budget is enforced
      // by the trial admission hook.
      .post(
        '/trial',
        routeClass('public'),
        zValidator('json', trialTurnBodySchema, rejectInvalid),
        async (c) => {
          if (c.var.principal.kind !== 'none') {
            return c.json(createErrorResponse(ERROR_CODES.AUTHENTICATED_ON_TRIAL), 403);
          }
          const body = c.req.valid('json');
          // Web search is an account feature; trial reserves no budget for the
          // tool cap, so a hand-crafted request enabling it is refused.
          if (body.webSearchEnabled === true) {
            return c.json(createErrorResponse(ERROR_CODES.FEATURE_REQUIRES_AUTH), 403);
          }
          // Custom instructions are an account feature too; the body schema strips
          // them rather than refusing, because a dropped field costs nothing and a
          // 403 would only break a stray old client.
          const runKey = requiredIdempotencyKey(c);
          const principal = resolveTrialSessionPrincipal({
            credential: c.req.header('x-trial-token') ?? null,
            newId: () => crypto.randomUUID(),
          });
          // The identity every per-IP counter on this route keys on; compute it
          // once and reuse it (never double-hash).
          const ipHash = await callerIpId((name) => c.req.header(name), c.var.envUtils);
          // Two limiters, two jobs: this one bounds the work an anonymous
          // caller can buy, the 5/day quota below meters the entitlement.
          // Before the compile and the quota INCR — a refusal burns no slot.
          const preWorkRejection = await trialPreWorkRejection(c, body, ipHash);
          if (preWorkRejection !== null) return preWorkRejection;
          // Normalized like the paid routes: absent and [] hash identically,
          // and the pricing gates see the full resent history (its honest cost).
          const history = normalizedHistory(body.history);
          // Validate, gate, and compile the turn BEFORE consuming a quota slot:
          // a refused request must never burn one.
          const definition = await trialTurnDefinitionOrRefusal(c, body, history);
          if (definition instanceof Response) return definition;

          // Consume one 5/day slot only now that the turn is runnable. The INCR
          // is atomic (Redis) and fails closed. Residual replay edge: the run
          // referee is the conversation DO (startRun), so the route cannot
          // cheaply distinguish a same-key network retry from a first send
          // before this gate — a retry re-increments the slot even though the DO
          // then replays/attaches without executing a second run. Bounded and
          // accepted; splitting claim from check would need a new DO surface.
          const quota = await consumeTrialQuota(c.var.redis, {
            sessionId: principal.sessionId,
            ipHash,
            now: new Date(),
          });
          if (quota.isErr()) return respondDomainError(c, quota.error);
          if (!quota.value.allowed) {
            return c.json(createErrorResponse(ERROR_CODES.TRIAL_LIMIT_REACHED), 429);
          }

          const bodyHash = hashRequestBody({
            turnSources: body.turnSources,
            prompt: body.prompt,
            history,
            // The REQUESTED selection scopes dedup (client intent), not the
            // trial-resolved level — a same-body retry must hash identically.
            ...(body.reasoningEffort === undefined
              ? {}
              : { reasoningEffort: body.reasoningEffort }),
          });
          const runStartBody: RunStartBody = {
            mode: 'trial',
            runKey,
            bodyHash,
            definition: definition.definition,
            inputs: turnInputs(definition, body.prompt, history),
            history,
            sessionId: principal.sessionId,
            ...mockDirectivesBody(c),
          };
          return respondTrialRunStart(
            c,
            deps.realtime(c.env).startRun(deps.trialRoomName(principal.sessionId), runStartBody),
            principal.sessionId
          );
        }
      )
      // The trial WebSocket upgrade — the trial client's only way to attach to
      // the run streaming server-side (the paid `/:conversationId/websocket` is
      // membership-gated and keyed by a conversationId, neither of which a trial
      // session has). Public: an authenticated caller belongs on the
      // conversation socket and is refused. The room and the principal id are
      // BOTH derived server-side as `trialRoomName(sessionId)`, where `sessionId`
      // comes only from the resolved `x-trial-token`; the client supplies no
      // conversationId or principalId. So the DO addressed (`idFromName`) and the
      // socket's attachment principal are prefix-scoped to this session's own
      // trial room, and the broadcast-time `isTrialRoomSelf` verifier confines
      // delivery there — a trial credential can never upgrade to another trial
      // room or any conversation DO (the `trial:` prefix disjoints the DO
      // namespace). No membership check: a trial session has no membership.
      //
      // Per-IP window-capped ahead of the handler: the send path is
      // quota-gated but the upgrade is not, so without a window an anonymous
      // caller mints Durable Object connections without bound. Its posture
      // declares `countedAt: 'edge'` rather than spending in the handler
      // because the refusal has to land BEFORE the upgrade is issued.
      .get('/trial/websocket', routeClass('public'), async (c) => {
        if (c.var.principal.kind !== 'none') {
          return c.json(createErrorResponse(ERROR_CODES.AUTHENTICATED_ON_TRIAL), 403);
        }
        // WS-upgrade-only query fallback: a browser WebSocket cannot set the
        // `x-trial-token` header, so the client sends `?trialToken=`. The HTTP
        // POST stays header-only — this fallback exists only where headers are
        // physically unavailable.
        const principal = resolveTrialSessionPrincipal({
          credential: c.req.header('x-trial-token') ?? c.req.query('trialToken') ?? null,
          newId: () => crypto.randomUUID(),
        });
        const room = deps.trialRoomName(principal.sessionId);
        // The client's replay position rides the upgrade query (a browser
        // WebSocket can set no headers). Forwarded raw and bounded at the
        // realtime port, which refuses a malformed declaration.
        const upgraded = await deps
          .realtime(c.env)
          .upgrade(
            room,
            { principalId: room, isGuest: false },
            c.req.raw.headers,
            c.req.query(DECLARED_CURSORS_PARAM) ?? null
          );
        return upgraded.match(
          (response) => response,
          (error) => respondDomainError(c, error)
        );
      })
      // How many trial messages the caller has left today — the number the
      // composer shows, read from the counters POST /chat/trial enforces, so the
      // display and the gate can never be two different rules.
      //
      // Public with an in-handler credential gate, exactly like its trial
      // siblings: the class alone admits an unauthenticated caller, so the
      // handler refuses any authenticated principal (a signed-in user has no
      // trial allowance to read) and resolves the trial session SERVER-SIDE from
      // `x-trial-token`. Both identities the answer is keyed on — that session
      // and the edge-derived IP — come from the request's own credentials; no
      // query or body field can name an identity, so no crafted request reaches
      // a count that is not the caller's.
      //
      // Not an existence oracle: trial sessions are never persisted, so an
      // unknown token and a well-formed token that has sent nothing are the same
      // state, and both take the identical path to the identical 200. The quota
      // lookup DOES miss for an identity that has never spent — a miss
      // coalesces to zero, and that indistinguishability is the property, not
      // the absence of a miss.
      //
      // A GET: it spends no trial quota slot and writes no durable state — the
      // per-IP throttle counter below is the one thing it writes, and that is a
      // TTL-bounded Redis key — so the idempotency-key stage does not apply.
      .get('/trial/remaining', routeClass('public'), async (c) => {
        if (c.var.principal.kind !== 'none') {
          return c.json(createErrorResponse(ERROR_CODES.AUTHENTICATED_ON_TRIAL), 403);
        }
        const ipHash = await callerIpId((name) => c.req.header(name), c.var.envUtils);
        // Ahead of every other backend touch on this path: an anonymous caller
        // must not be able to buy a Redis read per request.
        const throttled = await rateLimitRejection(
          c,
          consumeTrialRemainingIpLimit(c.var.redis, ipHash)
        );
        if (throttled !== null) return throttled;

        const principal = resolveTrialSessionPrincipal({
          credential: c.req.header('x-trial-token') ?? null,
          newId: () => crypto.randomUUID(),
        });
        const remaining = await readTrialQuotaRemaining(c.var.redis, {
          sessionId: principal.sessionId,
          ipHash,
          now: new Date(),
        });
        return remaining.match(
          (count) => c.json({ remaining: count }, 200),
          (error) => respondDomainError(c, error)
        );
      })
      // Explicit user stop. Plain HTTP by design — a WS-blocked caller must
      // still be able to stop a paid run — and membership-gated so no one can
      // stop another conversation's run. The resolved caller rides to the room,
      // the only place it can be compared against the live run's own sender and
      // payer: a member with no money at stake must not be able to trigger a
      // settlement that bills the payer, and the room refuses it. The DO starts
      // nothing new, lets the work in flight finish, and settles what the run
      // produced; a repeat is a no-op (`stopped:false` once the run is gone).
      //
      // PUBLIC, like the guest send and for the same reason: the HTTP matrix
      // admits no link-guest principal, so a guest reaches the run it started
      // only through the in-handler credential gate. Both send and stop resolve
      // through that one gate, so a guest that may start a run may stop it and
      // no revocation predicate exists twice.
      .post(
        '/stop',
        routeClass('public'),
        zValidator('json', stopTurnBodySchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('json');
          const gated = await resolveGuestSenderOrRefusal(c, deps, conversationId, 'runControl');
          if (gated instanceof Response) return gated;
          const stopped = await deps.realtime(c.env).stopRun(conversationId, gated);
          return stopped.match(
            (didStop) => c.json({ stopped: didStop }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // The dev/E2E held-stream release: forwards to the addressed conversation
      // room DO so an E2E test can free a stream parked by the `holdPrimaryStream`
      // mock directive. `dev-only` 404s in production — the sole production-safety
      // gate for this surface (there is no held stream to release in production
      // regardless, since no production run carries mock directives). A GET (never
      // a mutating turn) so the idempotency-key stage does not apply.
      .get(
        '/mock/release-stream',
        routeClass('dev-only'),
        zValidator('query', releaseStreamQuerySchema, rejectInvalid),
        async (c) => {
          const { conversationId, runKey } = c.req.valid('query');
          const env: ReleaseStreamRoomEnv = c.env;
          const namespace = env.CONVERSATION_ROOM;
          if (namespace === undefined) {
            return c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503);
          }
          const stub = namespace.get(namespace.idFromName(conversationId));
          const target = new URL('https://conversation-room/mock/release-stream');
          if (runKey !== undefined) {
            target.searchParams.set('runKey', runKey);
          }
          const response = await stub.fetch(target.toString(), { method: 'POST' });
          if (!response.ok) {
            return c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503);
          }
          const parsed = releaseStreamResponseSchema.safeParse(await response.json());
          if (!parsed.success) {
            return c.json(createErrorResponse(ERROR_CODES.SERVICE_UNAVAILABLE), 503);
          }
          return c.json({ released: parsed.data.released }, 200);
        }
      )
      // The runless user-only send (legacy "AI toggle off" group message): one
      // transaction, no run, no charge. The server mints the message id, so
      // the send dedups on its `Idempotency-Key` instead: a resend under the
      // same key replays the stored response and writes nothing.
      .post(
        '/:conversationId/message',
        routeClass('session'),
        zValidator('param', conversationIdParameterSchema, rejectInvalid),
        zValidator('json', userOnlyMessageSchema, rejectInvalid),
        async (c) => {
          const { conversationId } = c.req.valid('param');
          const body = c.req.valid('json');
          const { content, forkId } = body;
          const userId = callerUserId(c.var.principal);
          const member = await resolveCallerMember(deps.conversations(c.var.db), conversationId, {
            kind: 'user',
            userId,
          });
          if (member.isErr()) return respondDomainError(c, member.error);
          // Write privilege required (legacy parity): a non-member and a
          // member below `write` are both refused before anything is written.
          if (member.value === null || !canSendMessages(member.value.privilege)) {
            return c.json(createErrorResponse(ERROR_CODES.FORBIDDEN), 403);
          }
          // Set only inside the execution, so a replay, which executes nothing,
          // repeats neither the post-commit broadcast nor the push.
          const execution = { ran: false };
          const result = await runMutation(() =>
            idempotent.byKey({
              db: c.var.db,
              scope: { userId, route: routePath(c), key: requiredIdempotencyKey(c) },
              body: { conversationId, ...body },
              executorId: randomUuid(),
              responseSchema: userOnlyMessageResponseSchema,
              execute: (tx) => {
                execution.ran = true;
                return saveUserOnlyMessage(
                  {
                    tx,
                    stores: deps.chatStores,
                    readEpochPublicKey: deps.readEpochPublicKey,
                    newId: randomUuid,
                  },
                  {
                    conversationId,
                    senderId: userId,
                    content,
                    ...(forkId !== undefined && { forkId }),
                  }
                );
              },
            })
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          const outcome = result.value;
          if (execution.ran) {
            // Post-commit, best-effort: the message already committed; a failed
            // broadcast is logged and a client resync recovers.
            const broadcast = await broadcastUserMessageNew(deps.realtime(c.env), {
              conversationId,
              messageId: outcome.messageId,
              senderId: userId,
              sequenceNumber: outcome.sequenceNumber,
            });
            if (broadcast.isErr()) {
              c.var.logger.warn('user message broadcast failed', {
                conversationId,
                errorCode: broadcast.error.code,
              });
            }
            // Post-commit, best-effort push side-band (parity with the AI-turn
            // path, which the runless send historically lacked): absent, non-muted
            // members with a device token get a content-free notification, while
            // members watching live (DO presence), muted members, and the sender
            // are suppressed downstream. Registered as a side-band so it survives
            // the response AND keeps the request pool open across the presence
            // round trip its membership reads follow; a presence-read or push
            // failure can never touch the committed message or this 200 (the
            // capability logs its own code and
            // never throws — and the guard wraps the factory construction too, so a
            // synchronous throw from `createPushSenderFromEnv` on a misconfigured
            // deploy is swallowed, never escaping onto the request path).
            const notifyFactory = deps.notifyNewMessage;
            if (notifyFactory !== undefined) {
              const pushTask = (async () => {
                try {
                  const notify = notifyFactory(c.env, c.var.db, c.var.logger);
                  const presence = await deps.realtime(c.env).presence(conversationId);
                  if (presence.isErr()) {
                    c.var.logger.warn('user message push presence unavailable', {
                      conversationId,
                      errorCode: presence.error.code,
                    });
                    return;
                  }
                  await notify({
                    conversationId,
                    senderUserId: userId,
                    presentUserIds: presence.value,
                  });
                  // eslint-disable-next-line catch-swallow/no-silent-catch -- best-effort push side-band; notify self-reports; nothing escapes onto the request path.
                } catch {
                  // Best-effort: `notify` already swallows its own failures; this
                  // guards the presence read + scheduling so nothing ever escapes.
                }
              })();
              c.var.sideBand(pushTask);
            }
          }
          return c.json(
            {
              messageId: outcome.messageId,
              sequenceNumber: outcome.sequenceNumber,
              epochNumber: outcome.epochNumber,
            },
            200
          );
        }
      ),
  });
}
