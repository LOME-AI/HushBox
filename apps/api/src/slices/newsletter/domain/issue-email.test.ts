import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ROUTES } from '@hushbox/shared';
import { TEST_YEAR_START } from '@hushbox/shared/test-time';
import { createMockEmailSender } from '../../notifications/index.js';
import { renderIssueEmail, renderIssuePreview, sendIssueTest } from './issue-email.js';

const URLS = { apiUrl: 'https://api.hushbox.ai', marketingUrl: 'https://hushbox.ai' };

const SENT_AT = new Date(TEST_YEAR_START);

const NEXT_YEAR_START = Date.UTC(SENT_AT.getUTCFullYear() + 1, 0, 1);

/** The target of the one anchor whose visible text is `label`. */
function hrefOf(html: string, label: string): URL {
  const anchors = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
  const matching = anchors.filter((anchor) => anchor[2] === label);
  const href = matching[0]?.[1];
  if (matching.length !== 1 || href === undefined) {
    throw new Error(`expected one "${label}" link, found ${String(matching.length)}`);
  }
  return new URL(href.replaceAll('&amp;', '&'));
}

describe('renderIssueEmail', () => {
  const rendered = renderIssueEmail({
    subject: 'July release notes',
    bodyMarkdown: 'Hello **subscriber**',
    unsubscribeToken: 'tok-123',
    urls: URLS,
    sentAt: SENT_AT,
  });

  it('renders the markdown body into the issue template', () => {
    expect(rendered.subject).toBe('July release notes');
    expect(rendered.html).toMatch(/<strong[^>]*>subscriber<\/strong>/);
  });

  it('links the visible unsubscribe to the marketing goodbye page with the recipient token', () => {
    expect(rendered.html).toContain('https://hushbox.ai/newsletter/unsubscribed?token=tok-123');
  });

  it('keeps the RFC 8058 one-click header on the API unsubscribe route, not the page', () => {
    expect(rendered.headers).toEqual({
      'List-Unsubscribe': '<https://api.hushbox.ai/newsletter/unsubscribe?token=tok-123>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
  });

  it('includes the marketing unsubscribe link in the text alternative', () => {
    expect(rendered.text).toContain('https://hushbox.ai/newsletter/unsubscribed?token=tok-123');
  });

  it('stamps the copyright year from the send date it is given', () => {
    for (const instant of [TEST_YEAR_START, NEXT_YEAR_START]) {
      const { html, text } = renderIssueEmail({
        subject: 'July release notes',
        bodyMarkdown: 'Hello',
        unsubscribeToken: 'tok-123',
        urls: URLS,
        sentAt: new Date(instant),
      });
      const year = String(new Date(instant).getUTCFullYear());
      expect(html).toContain(`&copy; ${year} `);
      expect(text).toContain(`© ${year} `);
    }
  });
});

describe('renderIssuePreview', () => {
  const preview = renderIssuePreview({
    subject: 'Draft preview',
    bodyMarkdown: 'A *draft*',
    marketingUrl: URLS.marketingUrl,
    sentAt: SENT_AT,
  });

  it('renders the subject and the markdown body', () => {
    expect(preview.subject).toBe('Draft preview');
    expect(preview.html).toMatch(/<em[^>]*>draft<\/em>/);
  });

  it('links its unsubscribe to the marketing goodbye page, never to a bare fragment', () => {
    const link = hrefOf(preview.html, 'Unsubscribe');

    expect(preview.html).not.toContain('href="#"');
    expect(link.origin).toBe(URLS.marketingUrl);
    expect(link.pathname).toBe(ROUTES.NEWSLETTER_UNSUBSCRIBED);
  });

  it('carries a token no subscriber holds, since every subscriber token is a UUID', () => {
    const token = hrefOf(preview.html, 'Unsubscribe').searchParams.get('token');

    expect(token).not.toBeNull();
    expect(z.uuid().safeParse(token).success).toBe(false);
  });

  it('stamps the copyright year from the send date it is given', () => {
    const year = String(SENT_AT.getUTCFullYear());

    expect(preview.text).toContain(`© ${year} `);
  });
});

describe('sendIssueTest', () => {
  it('sends a single rendered email to the given address', async () => {
    const sender = createMockEmailSender();

    const result = await sendIssueTest({
      sender,
      subject: 'Draft preview',
      bodyMarkdown: 'A *draft*',
      to: 'admin@hushbox.ai',
      marketingUrl: URLS.marketingUrl,
      sentAt: SENT_AT,
    });

    expect(result.isOk()).toBe(true);
    const [sent] = sender.getSentMessages();
    expect(sent?.to).toBe('admin@hushbox.ai');
    expect(sent?.subject).toBe('Draft preview');
    expect(sent?.html).toMatch(/<em[^>]*>draft<\/em>/);
  });

  it('sends the preview render with no one-click headers', async () => {
    const sender = createMockEmailSender();
    const params = {
      subject: 'Draft preview',
      bodyMarkdown: 'body',
      marketingUrl: URLS.marketingUrl,
      sentAt: SENT_AT,
    };

    const result = await sendIssueTest({ ...params, sender, to: 'admin@hushbox.ai' });

    expect(result.isOk()).toBe(true);
    const [sent] = sender.getSentMessages();
    expect(sent?.html).toBe(renderIssuePreview(params).html);
    expect(sent?.html).not.toContain('href="#"');
    expect(sent?.headers).toBeUndefined();
  });
});
