import { passwordResetEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { PasswordResetEmailPort } from '../../slices/identity/index.js';

/**
 * The composition-root adapter behind identity's PasswordResetEmailPort:
 * composes the notifications slice's password-reset template and sends it
 * through the shared compose-and-send seam. Distinct from the password-changed
 * adapter so a recovery-phrase reset gets honest "reset" copy — never the
 * alarming "changed" notice. Best-effort — the domain ignores a failed Result —
 * so the failure's error code is logged (codes only) and still returned on the
 * error channel.
 */
export function createPasswordResetEmailAdapter(
  resolve: () => EmailSendDeps
): PasswordResetEmailPort {
  return {
    sendPasswordResetEmail(args) {
      return renderAndSendEmail(resolve(), {
        definition: passwordResetEmail,
        params: { userName: args.userName },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('password-reset email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppPasswordResetEmailPort(): PasswordResetEmailPort {
  return createPasswordResetEmailAdapter(resolveEmailSendDeps);
}
