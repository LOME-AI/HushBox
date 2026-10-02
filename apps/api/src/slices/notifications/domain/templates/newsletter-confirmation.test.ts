import { describe, it, expect } from 'vitest';
import { NEWSLETTER_CONFIRM_TTL_MS, NEWSLETTER_POSTAL_ADDRESS } from '@hushbox/shared';
import { HOUR_MS } from '@hushbox/shared/durations';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { newsletterConfirmationEmail } from './newsletter-confirmation.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const CONFIRM_URL = 'https://hushbox.ai/newsletter/confirmed?token=abc123&source=email';

const EXPIRES_IN_HOURS = NEWSLETTER_CONFIRM_TTL_MS / HOUR_MS;

const SCOUNDREL_LINE =
  'You (or some scoundrel with your email address) asked to join the HushBox mailing list. Either way, nothing happens until you confirm.';

const NOT_YOU_LINE = "Not you? Ignore this email and we'll never write again.";

function render(): RenderedEmail {
  return renderEmail(newsletterConfirmationEmail, { confirmUrl: CONFIRM_URL }, { sentAt: SENT_AT });
}

/** A literal string as a pattern, so a URL's `?` and `.` match themselves. */
function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('newsletterConfirmationEmail', () => {
  it('keeps the subject', () => {
    expect(render().subject).toBe('Confirm your subscription');
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Confirm your subscription<\/h1>/);
  });

  it('shows its inbox preview line with the link lifetime', () => {
    expect(render().html).toContain(
      `>Nothing happens until you confirm. The link expires in ${String(EXPIRES_IN_HOURS)} hours.</div>`
    );
  });

  it('keeps the scoundrel line as a body paragraph', () => {
    expect(render().html).toMatch(
      new RegExp(`<p class="email-paragraph" [^>]*>${literal(escapeHtml(SCOUNDREL_LINE))}</p>`)
    );
  });

  it('offers one action, Confirm subscription, to the confirm link', () => {
    const { html } = render();
    expect(html.match(/class="email-button /g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(
        `<a class="email-button [^"]*" href="${literal(escapeHtml(CONFIRM_URL))}"[^>]*>Confirm subscription</a>`
      )
    );
  });

  it('follows the action with the paste link to the confirm link, whose text is its href', () => {
    const escaped = literal(escapeHtml(CONFIRM_URL));
    expect(render().html).toMatch(
      new RegExp(
        `>Or paste this link into your browser:<br><a [^>]*href="${escaped}"[^>]*>${escaped}</a></p>`
      )
    );
  });

  it('writes the expiry line as fine print with the token lifetime', () => {
    expect(render().html).toMatch(
      new RegExp(
        String.raw`<p class="email-fine-print" [^>]*>This link expires in ${String(EXPIRES_IN_HOURS)} hours\.</p>`
      )
    );
  });

  it('writes the not-you line as fine print', () => {
    expect(render().html).toMatch(
      new RegExp(`<p class="email-fine-print" [^>]*>${literal(escapeHtml(NOT_YOU_LINE))}</p>`)
    );
  });

  it('places the expiry and not-you lines after the action, in that order', () => {
    const { html } = render();
    const action = html.indexOf('>Confirm subscription</a>');
    const expiry = html.indexOf('This link expires in');
    const notYou = html.indexOf(escapeHtml(NOT_YOU_LINE));
    expect(action).toBeGreaterThan(-1);
    expect(expiry).toBeGreaterThan(action);
    expect(notYou).toBeGreaterThan(expiry);
  });

  it('carries the action, the link, the expiry and the not-you line in the plain-text part', () => {
    expect(render().text).toContain(
      `Confirm subscription\n${CONFIRM_URL}\n\nThis link expires in ${String(EXPIRES_IN_HOURS)} hours.\n\n${NOT_YOU_LINE}`
    );
  });

  it('links only to the confirm link and the questions address', () => {
    expect(new Set(hrefs(render().html))).toEqual(
      new Set([escapeHtml(CONFIRM_URL), 'mailto:hello@hushbox.ai'])
    );
  });

  it('has no postal address', () => {
    const { html, text } = render();

    expect(html).not.toContain(NEWSLETTER_POSTAL_ADDRESS);
    expect(text).not.toContain(NEWSLETTER_POSTAL_ADDRESS);
  });

  it('has no unsubscribe link', () => {
    const { html, text } = render();

    expect(html.toLowerCase()).not.toContain('unsubscribe');
    expect(text.toLowerCase()).not.toContain('unsubscribe');
  });

  it('refuses params without a confirm URL', () => {
    expect(() =>
      // @ts-expect-error -- the params omit the required confirm URL on purpose
      renderEmail(newsletterConfirmationEmail, {}, { sentAt: SENT_AT })
    ).toThrow();
  });
});
