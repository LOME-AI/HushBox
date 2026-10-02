import { twoFactorLockedEmail } from '../../slices/notifications/index.js';
import { renderAndSendEmail, resolveEmailSendDeps } from './send-email.js';
import type { EmailSendDeps } from './send-email.js';
import type { TwoFactorLockedEmailPort } from '../../slices/identity/index.js';

/**
 * The composition-root adapter behind identity's TwoFactorLockedEmailPort:
 * composes the notifications slice's `twoFactorLockedEmail` template and sends
 * it through the shared compose-and-send seam. Best-effort — the login 2FA flow
 * ignores a failed Result — so the failure's error code is logged (codes only)
 * and still returned on the error channel.
 */
export function createTwoFactorLockedEmailAdapter(
  resolve: () => EmailSendDeps
): TwoFactorLockedEmailPort {
  return {
    sendTwoFactorLockedEmail(args) {
      return renderAndSendEmail(resolve(), {
        definition: twoFactorLockedEmail,
        params: { lockoutMinutes: args.lockoutMinutes, userName: args.userName },
        to: args.to,
        logFailure: (logger, errorCode) => {
          logger.warn('two-factor-locked email send failed', { errorCode });
        },
      });
    },
  };
}

/** The production binding: resolves the env sender + request logger per send. */
export function createAppTwoFactorLockedEmailPort(): TwoFactorLockedEmailPort {
  return createTwoFactorLockedEmailAdapter(resolveEmailSendDeps);
}
