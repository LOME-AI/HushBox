import { describe, it, expect } from 'vitest';
import { NEWSLETTER_POSTAL_ADDRESS } from '@hushbox/shared';
import { EMAIL_PALETTE } from '@hushbox/shared/design-tokens';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { newsletterIssueEmail } from './newsletter-issue.js';
import type { NewsletterIssueParams } from './newsletter-issue.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const REASON_LINE = "You're receiving this because you subscribed at hushbox.ai.";

const POSTAL_LINE = `HushBox · ${NEWSLETTER_POSTAL_ADDRESS}`;

describe('newsletterIssueEmail', () => {
  const params = {
    subject: 'July at HushBox',
    bodyMarkdown:
      '## What shipped\n\nSomething **big** landed. [Read more](https://hushbox.ai/blog).',
    unsubscribeUrl: 'https://hushbox.ai/newsletter/unsubscribed?token=xyz789',
  };

  function newsletterIssue(issue: NewsletterIssueParams): RenderedEmail {
    return renderEmail(newsletterIssueEmail, issue, { sentAt: SENT_AT });
  }

  it('renders markdown headings into the html', () => {
    const result = newsletterIssue(params);

    expect(result.html).toMatch(/<h2[^>]*>What shipped<\/h2>/);
  });

  it('renders markdown bold into the html', () => {
    const result = newsletterIssue(params);

    expect(result.html).toMatch(/<strong[^>]*>big<\/strong>/);
  });

  it('renders markdown links into the html', () => {
    const result = newsletterIssue(params);

    expect(result.html).toContain('href="https://hushbox.ai/blog"');
  });

  it('escapes html in the subject while markdown-rendered tags survive', () => {
    const result = newsletterIssue({
      ...params,
      subject: 'Fun <script>alert(1)</script>',
    });

    expect(result.html).toContain('Fun &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(result.html).not.toContain('<script>');
    expect(result.html).toMatch(/<h2[^>]*>What shipped<\/h2>/);
  });

  it('keeps the subject', () => {
    expect(newsletterIssue(params).subject).toBe('July at HushBox');
  });

  it('writes the subject as its heading and its document title', () => {
    const { html } = newsletterIssue(params);

    expect(html).toMatch(/<h1 [^>]*>July at HushBox<\/h1>/);
    expect(html).toContain('<title>July at HushBox</title>');
  });

  it('has no inbox preview line', () => {
    expect(newsletterIssue(params).html).not.toContain('email-preheader');
  });

  it('closes the card with the reason, the Unsubscribe link, then the postal line', () => {
    const { html } = newsletterIssue(params);
    const reason = html.indexOf(escapeHtml(REASON_LINE));
    const unsubscribe = html.indexOf('>Unsubscribe</a>');
    const postal = html.indexOf(escapeHtml(POSTAL_LINE));
    expect(reason).toBeGreaterThan(html.indexOf('>What shipped</h2>'));
    expect(unsubscribe).toBeGreaterThan(reason);
    expect(postal).toBeGreaterThan(unsubscribe);
  });

  it('writes the Unsubscribe link in the accent colour, to the unsubscribe url', () => {
    const { html } = newsletterIssue(params);
    const anchors = [...html.matchAll(/<a [^>]*>Unsubscribe<\/a>/g)].map((match) => match[0]);

    expect(anchors).toHaveLength(1);
    expect(anchors[0]).toContain(`href="${escapeHtml(params.unsubscribeUrl)}"`);
    expect(anchors[0]).toContain(`color:${EMAIL_PALETTE.dark.accent};`);
  });

  it('renders the text variant with the raw markdown body', () => {
    const result = newsletterIssue(params);

    expect(result.text).toContain('## What shipped');
    expect(result.text).toContain('Something **big** landed.');
  });

  it('renders the text variant foot in reading order with the unsubscribe url', () => {
    expect(newsletterIssue(params).text).toContain(
      `${REASON_LINE}\nUnsubscribe: ${params.unsubscribeUrl}\n${POSTAL_LINE}`
    );
  });

  it('stamps the copyright year from the send date', () => {
    const year = String(SENT_AT.getUTCFullYear());
    const { html, text } = newsletterIssue(params);

    expect(html).toContain(`&copy; ${year} `);
    expect(text).toContain(`© ${year} `);
  });

  it('rejects missing params', () => {
    expect(() =>
      // @ts-expect-error -- the params omit the required body and unsubscribe url on purpose
      renderEmail(newsletterIssueEmail, { subject: 'x' }, { sentAt: SENT_AT })
    ).toThrow();
  });
});
