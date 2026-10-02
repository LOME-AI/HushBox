import { ROUTES } from '@hushbox/shared';
import { newsletterConfirmationEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import { requestEnv } from '../../lib/context/index.js';
import type { EmailSendDeps } from './send-email.js';
import type { NewsletterConfirmEmailPort } from '../../slices/newsletter/index.js';
import type { EnvContext } from '@hushbox/shared';

/** The shared send deps plus the marketing base URL this port owns. */
interface NewsletterConfirmEmailSendDeps extends EmailSendDeps {
  readonly marketingUrl: string;
}

/**
 * The composition-root adapter behind the newsletter slice's
 * NewsletterConfirmEmailPort: composes the notifications slice's
 * double-opt-in template, owns the frontend-link construction (the domain
 * passes a bare token), and sends it through the shared compose-and-send
 * seam. Best-effort — the domain ignores a failed Result — so the failure's
 * error code is logged (codes only) and still returned on the error channel.
 */
export function createNewsletterConfirmEmailAdapter(
  resolve: () => NewsletterConfirmEmailSendDeps
): NewsletterConfirmEmailPort {
  return {
    sendConfirmation(args) {
      const deps = resolve();
      const link = new URL(ROUTES.NEWSLETTER_CONFIRMED, deps.marketingUrl);
      link.searchParams.set('token', args.token);
      return renderAndSendEmail(deps, {
        definition: newsletterConfirmationEmail,
        params: { confirmUrl: link.toString() },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('newsletter confirmation email send failed', { errorCode });
        },
      });
    },
  };
}

/**
 * Extends EnvContext (the `EmailSenderEnv` pattern): a weak all-optional shape
 * would fail assignability from `Bindings`, which declares neither var.
 */
interface MarketingUrlEnv extends EnvContext {
  readonly MARKETING_URL?: string;
}

function requireMarketingUrl(env: MarketingUrlEnv): string {
  if (env.MARKETING_URL === undefined || env.MARKETING_URL === '') {
    throw new Error('MARKETING_URL is required to build newsletter links');
  }
  return env.MARKETING_URL;
}

/**
 * The current request's marketing origin, which newsletter links point at. Missing
 * MARKETING_URL is a deployment misconfiguration, so it throws rather than returning
 * a value that would build a broken link.
 */
export function requestMarketingUrl(): string {
  return requireMarketingUrl(requestEnv());
}

/**
 * The production binding: resolves the env sender + request logger per send
 * (single-sourced) and adds the marketing base URL — the confirm link points at
 * the marketing confirmed page, not the API verb route. Missing MARKETING_URL is
 * a deployment misconfiguration: a fail-fast defect, never a silently unsent
 * email.
 */
export function createAppNewsletterConfirmEmailPort(): NewsletterConfirmEmailPort {
  return createNewsletterConfirmEmailAdapter(() => {
    return { ...resolveEmailSendDeps(), marketingUrl: requestMarketingUrl() };
  });
}
