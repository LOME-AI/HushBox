import { Hono } from 'hono';
import { routePath } from 'hono/route';
import { zValidator } from '@hono/zod-validator';
import {
  ERROR_CODES,
  listTransactionsQuerySchema,
  serializeNanoUSD,
  nanoUSD,
  usageConversationQuerySchema,
  usageDateRangeQuerySchema,
  usageTimeSeriesQuerySchema,
  getSpendableQuerySchema,
} from '@hushbox/shared';
import {
  defineSliceManifest,
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import {
  applyPaymentWebhookEvent,
  billingLoginLinkResponseSchema,
  callerUserId,
  createErrorResponse,
  idempotencyExempt,
  idempotent,
  initiateCardPayment,
  initiatePaymentBodySchema,
  issueBillingLoginToken,
  okAsync,
  paymentMockDirectivesFor,
  billingPrincipalUserId,
  readBalance,
  readCostByModel,
  readIdempotencyKey,
  readLedgerTransactions,
  readFundingSnapshot,
  readSpendingByConversation,
  readSpendingOverTime,
  readUsageBreakdown,
  readUsageModels,
  readUsageSummary,
  recordPaymentWebhookEvidence,
  releaseHeldPaymentWebhook,
  releaseHeldWebhookQuerySchema,
  runMutation,
  serializeFundingSnapshot,
  signalPaymentWebhookDisposition,
  usageBreakdownQuerySchema,
} from './domain/index.js';
import type { Context } from 'hono';
import type { Database } from '@hushbox/db';
import type { SpendingByConversationResponse } from '@hushbox/shared';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  AccountDefensePort,
  ChargebackLockEmailPort,
  BillingStores,
  ConversationFundingReader,
  DomainError,
  JobRegistry,
  PaymentMockDirectives,
  PaymentProvider,
  PaymentWebhookApplication,
  WebhookDeliveryLifetime,
  WebhookVerifier,
} from './domain/index.js';

export interface BillingRouteDeps {
  readonly stores: BillingStores;
  /**
   * The conversations-owned facts that name a group turn's payer, bound to the
   * request db at the composition root: billing never reads the
   * `conversations` or `conversation_members` tables
   * (single-writer-per-table), and no single slice may span both those rows
   * and billing's budget rows.
   */
  readonly conversationFunding: (db: Database) => ConversationFundingReader;
  /**
   * Env-selected at request time (mock locally, Helcim otherwise). The
   * request-scoped `db` threads into the real Helcim adapter so an approved
   * charge records `helcim` service-evidence (CI-only, no-op in production).
   * The charge's mock directives reach only the local mock.
   */
  readonly paymentProvider: (
    env: AppEnv['Bindings'],
    db: Database,
    executionCtx?: WebhookDeliveryLifetime,
    mockDirectives?: PaymentMockDirectives
  ) => PaymentProvider;
  /** Fail-closed Helcim signature verification — never optional. */
  readonly webhookVerifier: (env: AppEnv['Bindings']) => WebhookVerifier;
  /**
   * Carries the `payment.verify.v1` registration for the pre-claim enqueue.
   * Either a ready registry (tests pass one directly) or a per-request factory
   * — the composition root has no module-scope DB, so it builds the registry
   * from `c.var.db` per request (the registration's DB is unused at enqueue,
   * which only reads the registered schema/lease/shard).
   */
  readonly jobRegistry: JobRegistry | ((env: AppEnv['Bindings'], db: Database) => JobRegistry);
  readonly accountDefense: AccountDefensePort;
  readonly accountLockedEmail: ChargebackLockEmailPort;
}

/** Resolves the enqueue registry: a ready registry, or the per-request factory built from `c.var.db`. */
function resolveJobRegistry(
  jobRegistry: BillingRouteDeps['jobRegistry'],
  env: AppEnv['Bindings'],
  db: Database
): JobRegistry {
  return typeof jobRegistry === 'function' ? jobRegistry(env, db) : jobRegistry;
}

/**
 * The pipeline enforced the header before the handler ran; absence here is a
 * composition defect, not a client error.
 */
export function requiredIdempotencyKey(c: Context<AppEnv>): string {
  const key = readIdempotencyKey(c);
  if (key === undefined) {
    throw new Error('billing: idempotency key missing after the pipeline stage');
  }
  return key;
}

/**
 * The caller's network address for Helcim's card-token purchase API. The edge
 * sets `cf-connecting-ip` in production and miniflare's entry worker, which
 * fronts the app in the local Worker runtime, injects it locally (the socket
 * peer) when a client sends none, so the neutral
 * placeholder fills Helcim's required field only for an in-process caller —
 * this package's tests, which invoke the app directly and send no header.
 */
function clientIp(c: Context<AppEnv>): string {
  return c.req.header('cf-connecting-ip') ?? '0.0.0.0';
}

/**
 * Records the webhook application where the byEventId envelope can replay it,
 * yielding the wrapper's claimed flag.
 */
function recordApplication(holder: {
  application: PaymentWebhookApplication;
}): (value: PaymentWebhookApplication) => boolean {
  return (value) => {
    holder.application = value;
    return value.claimed;
  };
}

/**
 * The billing slice's HTTP surface. The return type is deliberately inferred:
 * annotating it with a bare `Hono<AppEnv>` widens the routes to `BlankSchema`
 * and erases the route schema from `AppType` (the typed client goes blind to
 * this slice).
 */
export function createBillingManifest(deps: BillingRouteDeps) {
  return defineSliceManifest({
    basePath: '/billing',
    routes: new Hono<AppEnv>()
      // billing-token: the mobile → web portal reads its wallet with its own
      // credential, so the balance route admits that kind and a full session.
      // `billingPrincipalUserId` (unlike `callerUserId`) accepts the portal
      // principal and scopes the read strictly to that principal's own userId.
      .get('/balance', routeClass('billing-token'), async (c) => {
        const userId = billingPrincipalUserId(c.var.principal);
        const result = await readBalance(deps.stores, c.var.db, userId, new Date());
        return result.match(
          (balance) =>
            c.json(
              {
                purchased: { balanceNanoUsd: serializeNanoUSD(nanoUSD(balance.purchasedNanoUsd)) },
                free: { balanceNanoUsd: serializeNanoUSD(nanoUSD(balance.freeNanoUsd)) },
                allowance: {
                  day: balance.allowance.day,
                  limitNanoUsd: serializeNanoUSD(nanoUSD(balance.allowance.limitNanoUsd)),
                  spentNanoUsd: serializeNanoUSD(nanoUSD(balance.allowance.spentNanoUsd)),
                  remainingNanoUsd: serializeNanoUSD(nanoUSD(balance.allowance.remainingNanoUsd)),
                },
              },
              200
            ),
          (error) => respondDomainError(c, error)
        );
      })
      // billing-token: the PAYER's funding snapshot — hold-aware, and the
      // admission gate itself when the payer is the caller; an owner-funded
      // figure prices the owner dimension through the same spendable-funds seam
      // every other dimension uses, cushion included, so it refuses nothing
      // admission would accept (BILLING §Affordability 8). It can still exceed
      // what admission admits, because the owner wallet's own holds elsewhere
      // are not subtracted — a divergence the spec settles as a hard refusal at
      // admission (§Group Funding 7(b); see `FundingSnapshot.spendableNanoUsd`).
      // Deliberately separate from `/balance`: this read's answer needs Redis
      // — the holds it nets out live there — so a store outage leaves it
      // nothing to answer with and it fails CLOSED, 503, like admission. That
      // is not a contrast in availability: `/balance` answers 503 in the same
      // outage, because the session every caller of it carries is itself
      // checked against Redis. What its `open` limiter posture buys is
      // answerability against a limiter-specific fault, never against the
      // store being down; `domain/rate-limit.ts` argues that row, including
      // what it does not buy.
      // `conversationId` names the payer — an owner-funded group turn is
      // priced from the owner's funds at the owner's tier (BILLING §Group
      // Funding 1), so a conversation-blind read would serve the wrong wallet
      // AND the wrong tier to every group member.
      .get(
        '/spendable',
        routeClass('billing-token'),
        zValidator('query', getSpendableQuerySchema, rejectInvalid),
        async (c) => {
          const userId = billingPrincipalUserId(c.var.principal);
          const { conversationId } = c.req.valid('query');
          const result = await readFundingSnapshot(
            { redis: c.var.redis, db: c.var.db, stores: deps.stores },
            {
              userId,
              conversationId,
              conversationFunding: deps.conversationFunding(c.var.db),
              now: new Date(),
            }
          );
          return result.match(
            (snapshot) => c.json(serializeFundingSnapshot(snapshot), 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // Mobile → web billing-portal handoff: mint the short-lived login token
      // the web app exchanges for the portal credential (redeemed on identity's
      // `POST /auth/token-login`). A normal session-class mutation: `byKey`
      // replays the same minted token for a retried Idempotency-Key.
      .post('/login-link', routeClass('session'), async (c) => {
        const userId = callerUserId(c.var.principal);
        const redis = c.var.redis;
        const result = await runMutation(() =>
          idempotent.byKey({
            db: c.var.db,
            scope: { userId, route: routePath(c), key: requiredIdempotencyKey(c) },
            body: {},
            executorId: crypto.randomUUID(),
            responseSchema: billingLoginLinkResponseSchema,
            execute: () => issueBillingLoginToken({ redis, userId }),
          })
        );
        return result.match(
          (outcome) => c.json(outcome, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/usage',
        routeClass('session'),
        zValidator('query', usageBreakdownQuerySchema, rejectInvalid),
        async (c) => {
          // Session-scoped by the pipeline principal — never client input, so
          // a caller can only ever read their own usage.
          const userId = callerUserId(c.var.principal);
          const { cursor, limit } = c.req.valid('query');
          const result = await readUsageBreakdown(deps.stores, c.var.db, {
            userId,
            ...(cursor === undefined ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          });
          return result.match(
            (page) =>
              c.json(
                {
                  models: page.models.map((model) => ({
                    modelId: model.modelId,
                    totalNanoUsd: serializeNanoUSD(nanoUSD(model.totalNanoUsd)),
                    recordCount: model.recordCount,
                    estimatedCount: model.estimatedCount,
                  })),
                  nextCursor: page.nextCursor,
                },
                200
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/usage/summary',
        routeClass('session'),
        zValidator('query', usageDateRangeQuerySchema, rejectInvalid),
        async (c) => {
          const userId = callerUserId(c.var.principal);
          const { startDate, endDate } = c.req.valid('query');
          const result = await readUsageSummary(deps.stores, c.var.db, {
            userId,
            startDate,
            endDate,
          });
          return result.match(
            (row) =>
              c.json(
                {
                  totalSpent: serializeNanoUSD(nanoUSD(row.totalNanoUsd)),
                  messageCount: row.messageCount,
                  totalInputTokens: row.inputTokens,
                  totalOutputTokens: row.outputTokens,
                  totalCachedTokens: row.cachedTokens,
                },
                200
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/usage/spending-over-time',
        routeClass('session'),
        zValidator('query', usageTimeSeriesQuerySchema, rejectInvalid),
        async (c) => {
          const userId = callerUserId(c.var.principal);
          const { startDate, endDate, granularity, model } = c.req.valid('query');
          const result = await readSpendingOverTime(deps.stores, c.var.db, {
            userId,
            startDate,
            endDate,
            granularity,
            ...(model === undefined ? {} : { model }),
          });
          return result.match(
            (rows) =>
              c.json(
                {
                  data: rows.map((row) => ({
                    period: row.period,
                    model: row.modelId,
                    totalCost: serializeNanoUSD(nanoUSD(row.totalNanoUsd)),
                    count: row.count,
                  })),
                },
                200
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/usage/cost-by-model',
        routeClass('session'),
        zValidator('query', usageDateRangeQuerySchema, rejectInvalid),
        async (c) => {
          const userId = callerUserId(c.var.principal);
          const { startDate, endDate } = c.req.valid('query');
          const result = await readCostByModel(deps.stores, c.var.db, {
            userId,
            startDate,
            endDate,
          });
          return result.match(
            (rows) =>
              c.json(
                {
                  data: rows.map((row) => ({
                    model: row.modelId,
                    provider: row.providerName,
                    totalCost: serializeNanoUSD(nanoUSD(row.totalNanoUsd)),
                    messageCount: row.messageCount,
                    totalInputTokens: row.inputTokens,
                    totalOutputTokens: row.outputTokens,
                  })),
                },
                200
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get(
        '/usage/spending-by-conversation',
        routeClass('session'),
        zValidator('query', usageConversationQuerySchema, rejectInvalid),
        async (c) => {
          const userId = callerUserId(c.var.principal);
          const { startDate, endDate, limit } = c.req.valid('query');
          const result = await readSpendingByConversation(deps.stores, c.var.db, {
            userId,
            startDate,
            endDate,
            limit,
          });
          return result.match(
            (rows) =>
              c.json(
                {
                  data: rows.map((row) => ({
                    conversationId: row.conversationId,
                    totalSpent: serializeNanoUSD(nanoUSD(row.totalNanoUsd)),
                    messageCount: row.messageCount,
                    modelIds: [...row.modelIds],
                  })),
                } satisfies SpendingByConversationResponse,
                200
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get('/usage/models', routeClass('session'), async (c) => {
        const userId = callerUserId(c.var.principal);
        const result = await readUsageModels(deps.stores, c.var.db, userId);
        return result.match(
          (models) => c.json({ models }, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .get(
        '/transactions',
        // billing-token: the mobile → web portal reads its ledger with its own
        // credential, so the transactions route admits that kind and a full
        // session. `billingPrincipalUserId` scopes the read to the principal's own userId.
        routeClass('billing-token'),
        zValidator('query', listTransactionsQuerySchema, rejectInvalid),
        async (c) => {
          const userId = billingPrincipalUserId(c.var.principal);
          const { limit, cursor, offset, type } = c.req.valid('query');
          const result = await readLedgerTransactions(deps.stores, c.var.db, {
            userId,
            limit,
            ...(cursor === undefined ? {} : { cursor }),
            ...(offset === undefined ? {} : { offset }),
            ...(type === undefined ? {} : { kind: type }),
          });
          return result.match(
            (page) =>
              c.json(
                {
                  transactions: page.transactions.map((txn) => ({
                    id: txn.id,
                    amount: serializeNanoUSD(nanoUSD(txn.amountNanoUsd)),
                    balanceAfter: serializeNanoUSD(nanoUSD(txn.balanceAfterNanoUsd)),
                    type: txn.kind,
                    paymentId: txn.paymentId,
                    model: null,
                    inputCharacters: null,
                    outputCharacters: null,
                    createdAt: txn.createdAt.toISOString(),
                  })),
                  nextCursor: page.nextCursor,
                },
                200
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/payments',
        // billing-token: the mobile → web handoff pays with its own credential,
        // so the charge route admits that kind and a full session.
        routeClass('billing-token'),
        zValidator('json', initiatePaymentBodySchema, rejectInvalid),
        async (c) => {
          const body = c.req.valid('json');
          const result = await runMutation(() =>
            initiateCardPayment(
              {
                db: c.var.db,
                stores: deps.stores,
                // The mock self-delivers its confirming webhook after the
                // charge response returns; registering that delivery as a
                // side-band keeps workerd from abandoning it and holds the
                // request pool open for the whole of it. The real Helcim
                // provider ignores the handle entirely.
                provider: deps.paymentProvider(
                  c.env,
                  c.var.db,
                  {
                    waitUntil: (promise) => {
                      c.var.sideBand(promise);
                    },
                  },
                  paymentMockDirectivesFor(c.var.envUtils, (name) => c.req.header(name))
                ),
                registry: resolveJobRegistry(deps.jobRegistry, c.env, c.var.db),
              },
              {
                userId: billingPrincipalUserId(c.var.principal),
                amountNanoUsd: body.amountNanoUsd,
                cardToken: body.cardToken,
                customerCode: body.customerCode,
                ipAddress: clientIp(c),
                idempotencyKey: requiredIdempotencyKey(c),
                now: new Date(),
              }
            )
          );
          return result.match(
            (outcome) =>
              c.json(
                {
                  paymentId: outcome.paymentId,
                  status: outcome.status,
                  amountNanoUsd: serializeNanoUSD(nanoUSD(outcome.amountNanoUsd)),
                },
                200
              ),
            (error) => respondDomainError(c, error)
          );
        }
      )
      // The dev/E2E held-webhook release: delivers the confirming webhook a
      // charge's `x-mock-hold-payment-webhook` directive held, so an E2E test
      // decides when that payment completes. `dev-only` 404s in production, and
      // the real provider there carries no release regardless. A GET, like the
      // held-stream release, so the idempotency-key stage does not apply; the
      // webhook it delivers is applied as idempotently as any other.
      .get(
        '/mock/release-webhook',
        routeClass('dev-only'),
        zValidator('query', releaseHeldWebhookQuerySchema, rejectInvalid),
        async (c) => {
          const { paymentId } = c.req.valid('query');
          const result = await releaseHeldPaymentWebhook(
            {
              db: c.var.db,
              stores: deps.stores,
              provider: deps.paymentProvider(c.env, c.var.db),
            },
            paymentId
          );
          return result.match(
            (outcome) => c.json({ released: outcome.released }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/webhooks/payment',
        routeClass('public'),
        idempotencyExempt('webhook-event-id'),
        async (c) => {
          // A webhook signature covers the raw body, so the body is read and
          // hashed in full before the request can be authorized. No limiter
          // counts this route — its posture is `exempt` — but the app-wide
          // ceiling in `middleware/body-limit.ts` still refuses an oversized
          // body at the edge, ahead of this handler and of the signature check.
          const rawBody = await c.req.text();
          const verified = await deps.webhookVerifier(c.env).verify(rawBody, {
            signature: c.req.header('webhook-signature'),
            timestamp: c.req.header('webhook-timestamp'),
            webhookId: c.req.header('webhook-id'),
          });
          if (verified.isErr()) return respondDomainError(c, verified.error);
          await recordPaymentWebhookEvidence(c.var.db, c.var.envUtils.isCI);
          const event = verified.value;
          // The claim is the payment row's own conditional status transition,
          // plus the unique ledger leg keys the dispute path posts under —
          // both keyed on the payment the delivery names, never on a delivery
          // id, so this route claims no per-event-id row. It runs the whole
          // fenced application (the money claim and its effect must share one
          // transaction); execute/onDuplicate only pass the recorded
          // application through the byEventId shape.
          const holder: { application: PaymentWebhookApplication } = {
            application: { claimed: false, disposition: { kind: 'ignored' } },
          };
          const result = await runMutation(() =>
            idempotent.byEventId({
              claim: () =>
                applyPaymentWebhookEvent(
                  {
                    db: c.var.db,
                    stores: deps.stores,
                    accountDefense: deps.accountDefense,
                    accountLockedEmail: deps.accountLockedEmail,
                    registry: resolveJobRegistry(deps.jobRegistry, c.env, c.var.db),
                  },
                  event
                ).map(recordApplication(holder)),
              execute: () => okAsync<PaymentWebhookApplication, DomainError>(holder.application),
              onDuplicate: () =>
                okAsync<PaymentWebhookApplication, DomainError>(holder.application),
            })
          );
          return result.match(
            (value) => {
              signalPaymentWebhookDisposition(c.var.logger, value.disposition);
              // A completed event racing ahead of the charge finalize has no
              // row yet — non-2xx makes the provider redeliver; the verify
              // job remains the guaranteed reconciler.
              if (value.disposition.kind === 'unmatched') {
                return c.json(createErrorResponse(ERROR_CODES.NOT_FOUND), 404);
              }
              return c.json({ received: true }, 200);
            },
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
