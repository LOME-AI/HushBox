import { accountLockedEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { AccountLockedEmailPort } from '../../slices/identity/index.js';

/**
 * The composition-root adapter behind identity's AccountLockedEmailPort:
 * composes the notifications slice's failed-sign-in `accountLockedEmail`
 * template (distinct from billing's chargeback-lock notification) and sends it
 * through the shared compose-and-send seam. Best-effort — the login flow
 * ignores a failed Result — so the failure's error code is logged (codes only)
 * and still returned on the error channel.
 */
export function createLoginLockoutEmailAdapter(
  resolve: () => EmailSendDeps
): AccountLockedEmailPort {
  return {
    sendAccountLockedEmail(args) {
      return renderAndSendEmail(resolve(), {
        definition: accountLockedEmail,
        params: { lockoutMinutes: args.lockoutMinutes, userName: args.userName },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('login-lockout email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppLoginLockoutEmailPort(): AccountLockedEmailPort {
  return createLoginLockoutEmailAdapter(resolveEmailSendDeps);
}
