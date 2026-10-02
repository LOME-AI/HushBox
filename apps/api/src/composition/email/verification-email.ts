import { ROUTES } from '@hushbox/shared';
import { verificationEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import { requireFrontendUrl } from './frontend-url.js';
import { requestEnv } from '../../lib/context/index.js';
import type { EmailSendDeps } from './send-email.js';
import type { VerificationEmailPort } from '../../slices/identity/index.js';

/** The shared send deps plus the frontend base URL this port owns. */
interface VerificationEmailSendDeps extends EmailSendDeps {
  readonly frontendUrl: string;
}

/**
 * The composition-root adapter behind identity's VerificationEmailPort:
 * composes the notifications slice's verification template, owns the
 * frontend-link construction (the domain passes a bare token), and sends it
 * through the shared compose-and-send seam. Best-effort — the domain ignores a
 * failed Result — so the failure's error code is logged (codes only) and still
 * returned on the error channel.
 */
export function createVerificationEmailAdapter(
  resolve: () => VerificationEmailSendDeps
): VerificationEmailPort {
  return {
    sendVerificationEmail(args) {
      const deps = resolve();
      const link = new URL(ROUTES.VERIFY, deps.frontendUrl);
      link.searchParams.set('token', args.token);
      return renderAndSendEmail(deps, {
        definition: verificationEmail,
        params: {
          userName: args.userName,
          verificationUrl: link.toString(),
          expiresInHours: args.expiresInHours,
        },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('verification email send failed', { errorCode });
        },
      });
    },
  };
}

/**
 * The production binding: resolves the env sender + request logger per send
 * (single-sourced) and adds the frontend base URL. Missing FRONTEND_URL is a
 * deployment misconfiguration: a fail-fast defect, never a silently unsent
 * email.
 */
export function createAppVerificationEmailPort(): VerificationEmailPort {
  return createVerificationEmailAdapter(() => {
    return { ...resolveEmailSendDeps(), frontendUrl: requireFrontendUrl(requestEnv()) };
  });
}
