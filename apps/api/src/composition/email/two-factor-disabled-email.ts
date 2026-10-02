import { ROUTES } from '@hushbox/shared';
import { twoFactorDisabledEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import { requireFrontendUrl } from './frontend-url.js';
import { requestEnv } from '../../lib/context/index.js';
import type { EmailSendDeps } from './send-email.js';
import type { TwoFactorDisabledEmailPort } from '../../slices/identity/index.js';

/** The shared send deps plus the frontend base URL the Settings link is built on. */
interface TwoFactorDisabledEmailSendDeps extends EmailSendDeps {
  readonly frontendUrl: string;
}

/**
 * The composition-root adapter behind identity's TwoFactorDisabledEmailPort:
 * composes the notifications slice's 2FA-disabled template and sends it through
 * the shared compose-and-send seam. Best-effort — the disable flow ignores a
 * failed Result — so the failure's error code is logged (codes only) and still
 * returned on the error channel.
 */
export function createTwoFactorDisabledEmailAdapter(
  resolve: () => TwoFactorDisabledEmailSendDeps
): TwoFactorDisabledEmailPort {
  return {
    sendTwoFactorDisabledEmail(args) {
      const deps = resolve();
      return renderAndSendEmail(deps, {
        definition: twoFactorDisabledEmail,
        params: {
          userName: args.userName,
          settingsUrl: new URL(ROUTES.SETTINGS, deps.frontendUrl).toString(),
        },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('2fa-disabled email send failed', { errorCode });
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
export function createAppTwoFactorDisabledEmailPort(): TwoFactorDisabledEmailPort {
  return createTwoFactorDisabledEmailAdapter(() => {
    return { ...resolveEmailSendDeps(), frontendUrl: requireFrontendUrl(requestEnv()) };
  });
}
