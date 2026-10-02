import { accountDeletedEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { AccountDeletedEmailPort } from '../../slices/identity/index.js';

/**
 * The composition-root adapter behind identity's AccountDeletedEmailPort:
 * composes the notifications slice's account-deleted template and sends it
 * through the shared compose-and-send seam. The recipient is the email the
 * deletion transaction captured — the user record is gone by send time, so the
 * template takes no personalization. Best-effort — the domain ignores a failed
 * Result — so the failure's error code is logged (codes only) and still
 * returned on the error channel.
 */
export function createAccountDeletedEmailAdapter(
  resolve: () => EmailSendDeps
): AccountDeletedEmailPort {
  return {
    sendAccountDeletedEmail(args) {
      return renderAndSendEmail(resolve(), {
        definition: accountDeletedEmail,
        params: {},
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('account-deleted email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppAccountDeletedEmailPort(): AccountDeletedEmailPort {
  return createAccountDeletedEmailAdapter(resolveEmailSendDeps);
}
