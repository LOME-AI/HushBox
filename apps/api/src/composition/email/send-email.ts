import { createEmailSenderFromEnv, renderEmail } from '../../slices/notifications/index.js';
import { requestEnv, requestLogger } from '../../lib/context/index.js';
import type {
  EmailContent,
  EmailDefinition,
  EmailSender,
} from '../../slices/notifications/index.js';
import type { DomainError } from '../../lib/errors/index.js';
import type { ResultAsync } from '../../lib/result/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';
import type { z } from 'zod';

/** What one send needs; resolved fresh per send so per-request infra is never retained. */
export interface EmailSendDeps {
  readonly sender: EmailSender;
  readonly logger: Telemetry;
  /** The send clock an email stamps its date from. */
  readonly now: () => Date;
}

/**
 * The single compose-and-send seam behind every composition-root email port.
 * Each port builds its own template content (subject + html + text) and passes
 * a `logFailure` callback carrying its own compile-time-literal warn message —
 * the msg-literal lint requires the literal at the `.warn` call site, so the
 * message stays with the caller while the send + error-map boilerplate is
 * single-sourced here. Best-effort by port doctrine: the failure is logged
 * (codes only, never the address or content) and still returned on the error
 * channel for callers that do look.
 */
export function sendComposedEmail(
  deps: Pick<EmailSendDeps, 'sender' | 'logger'>,
  args: {
    readonly to: string;
    readonly subject: string;
    readonly content: EmailContent;
    readonly logFailure: (logger: Telemetry, errorCode: string) => void;
  }
): ResultAsync<void, DomainError> {
  return deps.sender
    .send({ to: args.to, subject: args.subject, html: args.content.html, text: args.content.text })
    .mapErr((error) => {
      args.logFailure(deps.logger, error.code);
      return error;
    });
}

/**
 * Renders an email definition and sends it through {@link sendComposedEmail}: the send
 * date is the deps' clock, and the subject is the one the definition renders.
 */
export function renderAndSendEmail<S extends z.ZodType>(
  deps: EmailSendDeps,
  args: {
    readonly definition: EmailDefinition<S>;
    readonly params: z.input<S>;
    readonly to: string;
    readonly logFailure: (logger: Telemetry, errorCode: string) => void;
  }
): ResultAsync<void, DomainError> {
  const email = renderEmail(args.definition, args.params, { sentAt: deps.now() });
  return sendComposedEmail(deps, {
    to: args.to,
    subject: email.subject,
    content: email,
    logFailure: args.logFailure,
  });
}

/**
 * The single per-request dep resolver every `createApp*EmailPort` binds to:
 * billing/identity route deps take ONE static port object, but the sender
 * selection (env) and the request logger only exist per invocation on Workers —
 * so each send resolves them from the ambient request scope through
 * {@link requestEnv} and {@link requestLogger}. Sender construction is
 * single-sourced here.
 */
export function resolveEmailSendDeps(): EmailSendDeps {
  return {
    sender: createEmailSenderFromEnv(requestEnv()),
    logger: requestLogger(),
    now: () => new Date(),
  };
}
