import { passwordChangedEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { PasswordChangedEmailPort } from '../../slices/identity/index.js';

/**
 * The composition-root adapter behind identity's PasswordChangedEmailPort:
 * composes the notifications slice's password-changed template and sends it
 * through the shared compose-and-send seam. Best-effort — the domain ignores a
 * failed Result — so the failure's error code is logged (codes only) and still
 * returned on the error channel.
 */
export function createPasswordChangedEmailAdapter(
  resolve: () => EmailSendDeps
): PasswordChangedEmailPort {
  return {
    sendPasswordChangedEmail(args) {
      return renderAndSendEmail(resolve(), {
        definition: passwordChangedEmail,
        params: { userName: args.userName },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('password-changed email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppPasswordChangedEmailPort(): PasswordChangedEmailPort {
  return createPasswordChangedEmailAdapter(resolveEmailSendDeps);
}
