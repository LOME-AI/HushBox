import { adminOpNotificationEmail, renderEmail } from '../../slices/notifications/index.js';
import { resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import { adminOperatorEmails, parseAdminRoleMap, requestEnv } from '../../lib/context/index.js';
import type { EmailSendDeps } from './send-email.js';
import type { EnvContext } from '@hushbox/shared';
import type { AdminOpExecutedNotice } from '../../slices/admin/index.js';

/** What one notification fan-out needs; resolved fresh per notice. */
interface AdminOpNotifyDeps extends EmailSendDeps {
  readonly adminEmails: readonly string[];
  /** The admin SPA's origin the email's audit-log link points at. */
  readonly adminUrl: string;
}

/**
 * Extends EnvContext (the `FrontendUrlEnv` pattern) so `Bindings`, which does
 * not declare the var, stays assignable.
 */
interface AdminUrlEnv extends EnvContext {
  readonly ADMIN_URL?: string;
}

/**
 * The admin SPA origin both operator emails link the audit log on. A missing
 * value is a deployment misconfiguration: a fail-fast defect, never an email
 * whose link goes nowhere.
 */
export function requireAdminUrl(env: AdminUrlEnv): string {
  if (env.ADMIN_URL === undefined || env.ADMIN_URL === '') {
    throw new Error('ADMIN_URL is required to build admin audit links');
  }
  return env.ADMIN_URL;
}

/**
 * The engine's `onExecuted` notifier: composes the admin op-notification
 * template and fans it out to every allowlisted admin. Best-effort by
 * doctrine (telemetry, never a control): a failed send is logged per
 * recipient (codes only) and never throws — the engine additionally guards
 * with its own capture, so a defect here can never fail a committed op.
 */
export function createAdminOpNotifierAdapter(
  resolve: () => AdminOpNotifyDeps
): (notice: AdminOpExecutedNotice) => Promise<void> {
  return async (notice: AdminOpExecutedNotice): Promise<void> => {
    const deps = resolve();
    const sentAt = deps.now();
    const email = renderEmail(
      adminOpNotificationEmail,
      {
        opName: notice.opName,
        actorEmail: notice.actor,
        ...(notice.target === undefined ? {} : { target: notice.target }),
        reason: notice.reason,
        occurredAt: sentAt.toISOString(),
        isUndo: notice.isUndo,
        auditId: notice.auditId,
        adminUrl: deps.adminUrl,
      },
      { sentAt }
    );
    for (const to of deps.adminEmails) {
      // Best-effort: the failure is logged by `logFailure`; the error value
      // itself is deliberately discarded so one recipient never blocks the rest.
      await sendComposedEmail(
        { sender: deps.sender, logger: deps.logger },
        {
          to,
          subject: email.subject,
          content: email,
          logFailure: (logger, errorCode) => {
            logger.warn('admin op notification email send failed', { errorCode });
          },
        }
      ).unwrapOr(null);
    }
  };
}

/**
 * The operational audience, read out of `ADMIN_ROLE_MAP`: every OPERATOR sees
 * every mutation (the tripwire against a compromised-but-valid session), and
 * nobody else does. Derived from the role map rather than the actor allowlist
 * because the allowlist now also carries read-only roles, who neither run
 * mutations nor need to be told about them. Missing config fails fast; the
 * engine's notifier guard captures it.
 *
 * The same derivation serves the daily audit digest, so the two recipient
 * lists move together. The Access-log auditor does NOT: its expected-actor set
 * is every actor the wall admits — `adminAdmittedActors` in
 * `apps/api/src/lib/context/admin-allowlist.ts`, the intersection of the two
 * bindings — because it alerts on an authentication
 * the wall would have refused, which is not a question about who receives
 * mail.
 */
export function parseAdminNotificationRecipients(raw?: string): readonly string[] {
  const recipients = adminOperatorEmails(parseAdminRoleMap(raw));
  if (recipients.length === 0) {
    throw new Error(
      'admin op notification: ADMIN_ROLE_MAP is missing or names no operator recipient'
    );
  }
  return recipients;
}

/** The production binding: resolves env sender, clock, recipients and admin origin per notice. */
export function createAppAdminOpNotifier(): (notice: AdminOpExecutedNotice) => Promise<void> {
  return createAdminOpNotifierAdapter(() => {
    const env = requestEnv();
    return {
      ...resolveEmailSendDeps(),
      adminEmails: parseAdminNotificationRecipients(env.ADMIN_ROLE_MAP),
      adminUrl: requireAdminUrl(env),
    };
  });
}
