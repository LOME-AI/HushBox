import { twoFactorEnabledEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { TwoFactorEnabledEmailPort } from '../../slices/identity/index.js';

/**
 * The composition-root adapter behind identity's TwoFactorEnabledEmailPort:
 * composes the notifications slice's 2FA-enabled template and sends it through
 * the shared compose-and-send seam. Best-effort — the enrollment flow ignores a
 * failed Result — so the failure's error code is logged (codes only) and still
 * returned on the error channel.
 */
export function createTwoFactorEnabledEmailAdapter(
  resolve: () => EmailSendDeps
): TwoFactorEnabledEmailPort {
  return {
    sendTwoFactorEnabledEmail(args) {
      return renderAndSendEmail(resolve(), {
        definition: twoFactorEnabledEmail,
        params: { userName: args.userName },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('2fa-enabled email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppTwoFactorEnabledEmailPort(): TwoFactorEnabledEmailPort {
  return createTwoFactorEnabledEmailAdapter(resolveEmailSendDeps);
}
