import { ROUTES } from '@hushbox/shared';
import { newsletterIssueEmail, renderEmail } from '../../notifications/index.js';
import type { ResultAsync } from '../../../lib/result/index.js';
import type { DomainError } from '../../../lib/errors/index.js';
import type { EmailSender, RenderedEmail } from '../../notifications/index.js';

/** The API POST route the one-click `List-Unsubscribe` header targets. */
const API_UNSUBSCRIBE_PATH = '/newsletter/unsubscribe';

/** The two public origins an issue email links against. */
export interface IssueEmailUrls {
  /** The API's own public origin (`API_URL`) — the one-click POST target. */
  readonly apiUrl: string;
  /** The marketing origin (`MARKETING_URL`) — the human goodbye page. */
  readonly marketingUrl: string;
}

interface RenderIssueEmailParams {
  readonly subject: string;
  readonly bodyMarkdown: string;
  readonly unsubscribeToken: string;
  readonly urls: IssueEmailUrls;
  /** The date the issue goes out under; its year is the one the email states. */
  readonly sentAt: Date;
}

interface RenderedIssueEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly headers: Record<string, string>;
}

function unsubscribeUrl(origin: string, path: string, token: string): string {
  const url = new URL(path, origin);
  url.searchParams.set('token', token);
  return url.toString();
}

/** The issue email whose visible unsubscribe link carries `token` to the goodbye page. */
function renderIssue(
  issue: { readonly subject: string; readonly bodyMarkdown: string; readonly sentAt: Date },
  marketingUrl: string,
  token: string
): RenderedEmail {
  return renderEmail(
    newsletterIssueEmail,
    {
      subject: issue.subject,
      bodyMarkdown: issue.bodyMarkdown,
      unsubscribeUrl: unsubscribeUrl(marketingUrl, ROUTES.NEWSLETTER_UNSUBSCRIBED, token),
    },
    { sentAt: issue.sentAt }
  );
}

/**
 * The unsubscribe token a preview links with. Every subscriber's token is a random UUID,
 * so this one matches no row, and a click lands on the goodbye page's invalid-link state.
 */
const PREVIEW_UNSUBSCRIBE_TOKEN = 'preview';

/**
 * One recipient's issue email: the notifications template over the shared
 * markdown body, personalized only by the unsubscribe token. The visible link
 * targets the marketing goodbye page (a browser GET on the marketing origin);
 * the RFC 8058 one-click header targets the API POST route directly — mail
 * clients POST `List-Unsubscribe=One-Click` there, which the unsubscribe route
 * accepts via its query-string token. The two must not converge: a human
 * clicking the page URL lands on a real page, a client POSTing the header hits
 * the API verb.
 */
export function renderIssueEmail(params: RenderIssueEmailParams): RenderedIssueEmail {
  const email = renderIssue(params, params.urls.marketingUrl, params.unsubscribeToken);
  return {
    subject: email.subject,
    html: email.html,
    text: email.text,
    headers: {
      'List-Unsubscribe': `<${unsubscribeUrl(params.urls.apiUrl, API_UNSUBSCRIBE_PATH, params.unsubscribeToken)}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  };
}

interface IssuePreviewParams {
  readonly subject: string;
  readonly bodyMarkdown: string;
  /** The marketing origin (`MARKETING_URL`) the goodbye page lives on. */
  readonly marketingUrl: string;
  readonly sentAt: Date;
}

/**
 * An issue as a subscriber would receive it, for a reader who is not one: the admin
 * compose preview and the test-send. Its unsubscribe link reaches the real goodbye page
 * through the same builder a dispatch uses, carrying a token no subscriber holds.
 */
export function renderIssuePreview(params: IssuePreviewParams): RenderedEmail {
  return renderIssue(params, params.marketingUrl, PREVIEW_UNSUBSCRIBE_TOKEN);
}

interface SendIssueTestParams extends IssuePreviewParams {
  readonly sender: EmailSender;
  readonly to: string;
}

/**
 * The admin test-send: the preview render of {@link renderIssuePreview} to a chosen
 * address, with no one-click headers. No issue row, no delivery rows.
 */
export function sendIssueTest(params: SendIssueTestParams): ResultAsync<void, DomainError> {
  const email = renderIssuePreview(params);
  return params.sender.send({
    to: params.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });
}
