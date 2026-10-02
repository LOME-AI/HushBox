import { ROUTES } from '@hushbox/shared';
import { welcomeEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import { requireFrontendUrl } from './frontend-url.js';
import { requestEnv } from '../../lib/context/index.js';
import type { EmailSendDeps } from './send-email.js';
import type { WelcomeEmailPort } from '../../slices/billing/index.js';

/** The shared send deps plus the frontend base URL the Billing page and app links are built on. */
interface WelcomeEmailSendDeps extends EmailSendDeps {
  readonly frontendUrl: string;
}

/**
 * The composition-root adapter behind billing's WelcomeEmailPort: composes the
 * notifications slice's welcome template and sends it through the shared
 * compose-and-send seam. Best-effort — billing ignores a failed Result — so the
 * failure's error code is logged (codes only, never the address or content) and
 * still returned on the error channel.
 */
export function createWelcomeEmailAdapter(resolve: () => WelcomeEmailSendDeps): WelcomeEmailPort {
  return {
    sendWelcomeEmail(args) {
      const deps = resolve();
      return renderAndSendEmail(deps, {
        definition: welcomeEmail,
        params: {
          userName: args.userName,
          billingUrl: new URL(ROUTES.BILLING, deps.frontendUrl).toString(),
          appUrl: new URL(ROUTES.CHAT, deps.frontendUrl).toString(),
        },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('welcome email send failed', { errorCode });
        },
      });
    },
  };
}

/**
 * The production binding: resolves the env sender + request logger per send and
 * adds the frontend base URL. A missing FRONTEND_URL is a deployment
 * misconfiguration: a fail-fast defect, never a silently unsent email.
 */
export function createAppWelcomeEmailPort(): WelcomeEmailPort {
  return createWelcomeEmailAdapter(() => {
    return { ...resolveEmailSendDeps(), frontendUrl: requireFrontendUrl(requestEnv()) };
  });
}
