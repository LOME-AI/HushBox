import { resolveEmail, resolveNewsletterIssue } from './document.js';
import { renderEmailHtml, renderIssueHtml } from './html.js';
import { renderEmailText, renderIssueText } from './text.js';
import type { EmailDefinition } from './document.js';
import type { z } from 'zod';

declare const emailHtmlBrand: unique symbol;

/** Sendable email HTML; only {@link renderEmail} mints one. */
export type EmailHtml = string & { readonly [emailHtmlBrand]: true };

export interface RenderedEmail {
  readonly subject: string;
  readonly html: EmailHtml;
  readonly text: string;
}

interface WrittenParts {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

function writeParts<S extends z.ZodType>(
  definition: EmailDefinition<S>,
  params: z.input<S>,
  options: { readonly sentAt: Date }
): WrittenParts {
  if (definition.kind === 'newsletterIssue') {
    const issue = resolveNewsletterIssue(definition, params);
    return {
      subject: issue.subject,
      html: renderIssueHtml(issue, options),
      text: renderIssueText(issue, options),
    };
  }
  const email = resolveEmail(definition, params);
  return {
    subject: email.subject,
    html: renderEmailHtml(email, options),
    text: renderEmailText(email, options),
  };
}

/**
 * Validates the params once, then writes both parts from the one resolved email. The
 * send date is an input, never the clock, so a replayed batch renders the same bytes.
 */
export function renderEmail<S extends z.ZodType>(
  definition: EmailDefinition<S>,
  params: z.input<S>,
  options: { readonly sentAt: Date }
): RenderedEmail {
  const parts = writeParts(definition, params, options);
  return {
    subject: parts.subject,
    // The one place the brand is minted: this function is the renderer's only exit.
    html: parts.html as EmailHtml,
    text: parts.text,
  };
}
