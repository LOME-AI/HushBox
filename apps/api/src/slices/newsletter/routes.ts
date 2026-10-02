import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import {
  ERROR_CODES,
  newsletterConfirmBodySchema,
  newsletterSettingsBodySchema,
  newsletterSubscribeBodySchema,
  newsletterUnsubscribeBodySchema,
} from '@hushbox/shared';
import {
  defineSliceManifest,
  rejectInvalid,
  respondDomainError,
  routeClass,
} from '../../middleware/pipeline-manifest.js';
import {
  applyWebhookSuppression,
  callerUserId,
  confirmNewsletterSubscription,
  createErrorResponse,
  idempotencyExempt,
  idempotent,
  okAsync,
  readNewsletterSettings,
  resolveClientIp,
  runMutation,
  subscribeToNewsletter,
  unsubscribeFromNewsletter,
  writeNewsletterSettings,
} from './domain/index.js';
import type { Context } from 'hono';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type {
  AccountEmailReaderFactory,
  DomainError,
  NewsletterConfirmEmailPort,
  NewsletterStoresFactory,
  ResendWebhookVerifier,
  WebhookSuppressionApplication,
} from './domain/index.js';

interface NewsletterRouteDeps {
  /** Constructed per request from the pipeline's `c.var.db`. */
  readonly stores: NewsletterStoresFactory;
  /** Composition-root adapter: owns the confirm-link construction. */
  readonly confirmEmail: NewsletterConfirmEmailPort;
  /** Identity's published users store, bound structurally to the email read. */
  readonly identityUsers: AccountEmailReaderFactory;
  /** Fail-closed Resend (Svix-scheme) signature verification, bound to the env secret. */
  readonly webhookVerifier: (env: AppEnv['Bindings']) => ResendWebhookVerifier;
}

/**
 * The literal address recorded as double-opt-in consent evidence — never
 * collapsed and never hashed, unlike the rate-limit identity. In production it
 * is the edge-authoritative `cf-connecting-ip`, so a caller cannot write its own
 * consent record via `x-forwarded-for`; a request arriving without it records
 * the sentinel, which is honest about what is known.
 */
function clientIp(c: Context<AppEnv>): string {
  return resolveClientIp((name) => c.req.header(name), c.var.envUtils);
}

/**
 * Records the webhook application where the byEventId envelope can replay it,
 * yielding the wrapper's claimed flag.
 */
function recordApplication(holder: {
  application: WebhookSuppressionApplication;
}): (value: WebhookSuppressionApplication) => boolean {
  return (value) => {
    holder.application = value;
    return value.claimed;
  };
}

/**
 * The unsubscribe token rides EITHER the query string (RFC 8058 one-click:
 * mail clients POST `List-Unsubscribe=One-Click` as a bare form body, so the
 * token must live in the URL) OR a JSON `{token}` body (the goodbye page).
 * The query wins; a non-JSON body is never an error on this route.
 */
async function resolveUnsubscribeToken(c: Context<AppEnv>): Promise<string | null> {
  const queryToken = c.req.query('token');
  if (queryToken !== undefined && queryToken !== '') return queryToken;
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = newsletterUnsubscribeBodySchema.safeParse(body);
  return parsed.success ? parsed.data.token : null;
}

/**
 * The newsletter slice's HTTP surface. The public routes are exempt without
 * an `Idempotency-Key`: subscribe converges (`naturally-idempotent` +
 * `byUpsert`), confirm/unsubscribe dedup on the token itself
 * (`token-is-key` + `byUpsert`, identity's verify-email precedent). The
 * `/me` toggle is a convergent upsert like account preferences.
 *
 * The return type is deliberately inferred: annotating it with a bare
 * `Hono<AppEnv>` widens the routes to `BlankSchema` and erases the route
 * schema from `AppType` (the typed client goes blind to this slice).
 */
export function createNewsletterManifest(deps: NewsletterRouteDeps) {
  return defineSliceManifest({
    basePath: '/newsletter',
    routes: new Hono<AppEnv>()
      .post(
        '/subscribe',
        routeClass('public'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', newsletterSubscribeBodySchema, rejectInvalid),
        async (c) => {
          const { email } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              subscribeToNewsletter({
                store: deps.stores(c.var.db),
                emailPort: deps.confirmEmail,
                email,
                consentIp: clientIp(c),
                now: new Date(),
              })
            )
          );
          return result.match(
            () => c.json({ ok: true as const }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .post(
        '/confirm',
        routeClass('public'),
        idempotencyExempt('token-is-key'),
        zValidator('json', newsletterConfirmBodySchema, rejectInvalid),
        async (c) => {
          const { token } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              confirmNewsletterSubscription({
                store: deps.stores(c.var.db),
                token,
                now: new Date(),
              })
            )
          );
          if (result.isErr()) return respondDomainError(c, result.error);
          if (result.value.kind === 'invalid') {
            return c.json(createErrorResponse(ERROR_CODES.NEWSLETTER_CONFIRM_INVALID), 400);
          }
          return c.json({ ok: true as const }, 200);
        }
      )
      .post('/unsubscribe', routeClass('public'), idempotencyExempt('token-is-key'), async (c) => {
        const token = await resolveUnsubscribeToken(c);
        if (token === null) {
          return c.json(createErrorResponse(ERROR_CODES.VALIDATION), 400);
        }
        const result = await runMutation(() =>
          idempotent.byUpsert(() =>
            unsubscribeFromNewsletter({
              store: deps.stores(c.var.db),
              token,
              now: new Date(),
            })
          )
        );
        if (result.isErr()) return respondDomainError(c, result.error);
        if (result.value.kind === 'invalid') {
          return c.json(createErrorResponse(ERROR_CODES.NEWSLETTER_UNSUBSCRIBE_INVALID), 400);
        }
        // RFC 8058: the one-click POST MUST NOT be answered with a redirect.
        return c.json({ ok: true as const }, 200);
      })
      .post(
        '/webhooks/resend',
        routeClass('public'),
        idempotencyExempt('webhook-event-id'),
        async (c) => {
          // A webhook signature covers the raw body, so the body is read and
          // hashed in full before the request can be authorized. No limiter
          // counts this route — its posture is `exempt` — but the app-wide
          // ceiling in `middleware/body-limit.ts` still refuses an oversized
          // body at the edge, ahead of this handler and of the signature check.
          const rawBody = await c.req.text();
          const verified = await deps.webhookVerifier(c.env).verify(
            rawBody,
            {
              svixId: c.req.header('svix-id'),
              svixTimestamp: c.req.header('svix-timestamp'),
              svixSignature: c.req.header('svix-signature'),
            },
            new Date()
          );
          if (verified.isErr()) return respondDomainError(c, verified.error);
          const event = verified.value;
          if (event.type === 'ignored') {
            return c.json({ received: true as const }, 200);
          }
          // The claim is a durable unique insert on the provider's event id,
          // and it never expires: suppression is not self-correcting against a
          // replay, because an address the subscriber has since resubscribed
          // would be suppressed a second time by a delivery of the event that
          // suppressed it the first time. The claim runs the whole application
          // (claim and suppression share one transaction); execute/onDuplicate
          // only pass the recorded application through the byEventId shape.
          const holder: { application: WebhookSuppressionApplication } = {
            application: { claimed: false },
          };
          const result = await runMutation(() =>
            idempotent.byEventId({
              claim: () =>
                applyWebhookSuppression(
                  { db: c.var.db, stores: deps.stores },
                  event,
                  new Date()
                ).map(recordApplication(holder)),
              execute: () =>
                okAsync<WebhookSuppressionApplication, DomainError>(holder.application),
              onDuplicate: () =>
                okAsync<WebhookSuppressionApplication, DomainError>(holder.application),
            })
          );
          // A verified event answers 200 only once its application is durable; a
          // failed claim-and-suppress transaction answers 503, and Resend's retry
          // carries the same event id, so the redelivery re-runs the lost application.
          return result.match(
            () => c.json({ received: true as const }, 200),
            (error) => respondDomainError(c, error)
          );
        }
      )
      .get('/me', routeClass('session'), async (c) => {
        const result = await readNewsletterSettings({
          store: deps.stores(c.var.db),
          users: deps.identityUsers(c.var.db),
          userId: callerUserId(c.var.principal),
        });
        return result.match(
          (settings) => c.json(settings, 200),
          (error) => respondDomainError(c, error)
        );
      })
      .put(
        '/me',
        routeClass('session'),
        idempotencyExempt('naturally-idempotent'),
        zValidator('json', newsletterSettingsBodySchema, rejectInvalid),
        async (c) => {
          const { subscribed } = c.req.valid('json');
          const result = await runMutation(() =>
            idempotent.byUpsert(() =>
              writeNewsletterSettings({
                store: deps.stores(c.var.db),
                users: deps.identityUsers(c.var.db),
                userId: callerUserId(c.var.principal),
                subscribed,
                consentIp: clientIp(c),
                now: new Date(),
              })
            )
          );
          return result.match(
            (settings) => c.json(settings, 200),
            (error) => respondDomainError(c, error)
          );
        }
      ),
  });
}
