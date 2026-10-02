import { describe, it, expect } from 'vitest';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { accountDeletedEmail } from './account-deleted.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const DELETED_LINE =
  'Every conversation you own, group chats included, has been permanently deleted from our servers, with its messages and media.';

const RETENTION_LINE =
  'Financial records (payments, wallet ledger entries, usage history) are retained for audit and tax purposes, with your account identifier removed.';

function render(): RenderedEmail {
  return renderEmail(accountDeletedEmail, {}, { sentAt: SENT_AT });
}

/** A literal string as a pattern, so its parentheses and periods match themselves. */
function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('accountDeletedEmail', () => {
  it('keeps the subject', () => {
    expect(render().subject).toBe('Your HushBox account has been deleted');
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Your HushBox account has been deleted<\/h1>/);
  });

  it('shows its inbox preview line', () => {
    expect(render().html).toContain('>Every conversation you own is gone from our servers.</div>');
  });

  it('opens with every conversation the reader owns, group chats included', () => {
    expect(render().html).toMatch(
      new RegExp(
        `<h1 [^>]*>[^<]*</h1>.*?<p class="email-paragraph" [^>]*>${literal(escapeHtml(DELETED_LINE))}</p>`,
        's'
      )
    );
  });

  it('says group chats are included in what is deleted', () => {
    expect(render().text).toContain('group chats included');
  });

  it('claims neither projects nor all messages', () => {
    const { html, text } = render();
    expect(`${html}${text}`).not.toContain('projects');
    expect(`${html}${text}`).not.toContain('All conversations, messages');
  });

  it('keeps the financial-record retention line', () => {
    expect(render().html).toMatch(
      new RegExp(`<p class="email-paragraph" [^>]*>${literal(escapeHtml(RETENTION_LINE))}</p>`)
    );
  });

  it('writes the not-you line at body size with the security address inline', () => {
    const lead = escapeHtml(
      "If this wasn't you, your account may have been compromised. Contact us immediately at "
    );
    const address = literal('security@hushbox.ai');
    expect(render().html).toMatch(
      new RegExp(
        `<p class="email-paragraph" [^>]*>${literal(lead)}<a [^>]*href="mailto:${address}"[^>]*>${address}</a>${literal('.')}</p>`
      )
    );
  });

  it('carries the security address in the plain-text part', () => {
    expect(render().text).toContain(
      "If this wasn't you, your account may have been compromised. Contact us immediately at security@hushbox.ai"
    );
  });

  it('greets no one, since the account is gone when it sends', () => {
    const { html, text } = render();
    expect(`${html}${text}`).not.toMatch(/\bHi\b/);
  });

  it('offers no action', () => {
    const { html } = render();
    expect(html).not.toContain('class="email-button ');
    expect(html).not.toContain('Or write to');
    expect(html).not.toContain('Or paste this link');
  });

  it('links only to the security address and the questions address', () => {
    expect(hrefs(render().html)).toEqual(['mailto:security@hushbox.ai', 'mailto:hello@hushbox.ai']);
  });
});
