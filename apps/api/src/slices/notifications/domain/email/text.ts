import { EMAIL_LEGAL_OWNER, QUESTIONS_CONTACT_EMAIL } from './common.js';
import type {
  EmailAction,
  EmailBlock,
  Inline,
  ResolvedEmail,
  ResolvedNewsletterIssue,
} from './document.js';

function inlineText(content: readonly Inline[]): string {
  return content
    .map((run) => {
      if (typeof run === 'string') return run;
      if (run.kind === 'link') return `${run.text} (${run.href})`;
      return run.text;
    })
    .join('');
}

function blockText(block: EmailBlock): string {
  switch (block.kind) {
    case 'heading': {
      return block.text;
    }
    case 'paragraph':
    case 'finePrint': {
      return inlineText(block.content);
    }
    case 'table': {
      if (block.layout === 'log') {
        return block.rows.map((row) => `${row.title}\n${inlineText(row.meta)}`).join('\n');
      }
      return block.rows.map(([label, value]) => `${label}: ${inlineText(value)}`).join('\n');
    }
  }
}

function actionText(action: EmailAction): string {
  const target = action.kind === 'link' ? action.href : action.address;
  return `${action.label}\n${target}`;
}

/**
 * The plain-text part, written from the same resolved email as the HTML part and
 * never escaped. The copyright year is the send date's UTC year.
 */
export function renderEmailText(email: ResolvedEmail, options: { readonly sentAt: Date }): string {
  const { body } = email;
  const sections = [
    'HushBox',
    email.heading,
    ...body.blocks.map((block) => blockText(block)),
    ...(body.action === undefined
      ? []
      : [actionText(body.action), ...(body.afterAction ?? []).map((block) => blockText(block))]),
  ];
  return withFooter(sections, options.sentAt);
}

function withFooter(sections: readonly string[], sentAt: Date): string {
  const footer = [
    '---',
    `© ${String(sentAt.getUTCFullYear())} ${EMAIL_LEGAL_OWNER}`,
    `Questions? ${QUESTIONS_CONTACT_EMAIL}`,
  ];
  return `${sections.join('\n\n')}\n\n${footer.join('\n')}\n`;
}

/** A newsletter issue's text part: its markdown source as the HTML part shows it, then its foot. */
export function renderIssueText(
  issue: ResolvedNewsletterIssue,
  options: { readonly sentAt: Date }
): string {
  const foot = [
    issue.foot.reason,
    `Unsubscribe: ${issue.foot.unsubscribeUrl}`,
    issue.foot.postalLine,
  ];
  return withFooter(
    ['HushBox', issue.heading, issue.readableMarkdown, foot.join('\n')],
    options.sentAt
  );
}
