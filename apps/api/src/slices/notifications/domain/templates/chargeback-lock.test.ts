import { describe, it, expect } from 'vitest';
import { BILLING_CONTACT_EMAIL } from '@hushbox/shared';
import { TEST_YEAR_START } from '@hushbox/shared/test-time';
import { renderEmail } from '../email/render.js';
import { chargebackLockEmail } from './chargeback-lock.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const DISPUTE_LINE =
  'Your HushBox account has been locked because of a payment dispute on a recent charge.';

const RESOLVE_LINE =
  'The lock stays in place until the dispute is resolved. Contact us to resolve it.';

function render(params: { userName?: string } = {}): RenderedEmail {
  return renderEmail(chargebackLockEmail, params, { sentAt: SENT_AT });
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('chargebackLockEmail', () => {
  it('keeps the subject', () => {
    expect(render().subject).toBe('Your account was locked');
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Your account was locked<\/h1>/);
  });

  it('shows its inbox preview line', () => {
    expect(render().html).toContain(
      '>A recent charge was disputed. The lock stays until the dispute is resolved.</div>'
    );
  });

  it('names the payment dispute as the cause', () => {
    expect(render().html).toContain(`>${DISPUTE_LINE}</p>`);
  });

  it('ends its copy by asking the reader to contact us', () => {
    expect(render().html).toMatch(/<p class="email-paragraph" [^>]*>The lock stays[^<]*<\/p>/);
    expect(render().html).toContain(`>${RESOLVE_LINE}</p>`);
  });

  it('offers one action, to the billing team', () => {
    const { html } = render();
    expect(html.match(/class="email-button /g)).toHaveLength(1);
    expect(html).toContain('>Email the billing team</a>');
  });

  it('follows the action with its write-to line', () => {
    expect(render().html).toMatch(/>Or write to <a [^>]*>billing@hushbox\.ai<\/a><\/p>/);
  });

  it('mails the billing contact address', () => {
    expect(BILLING_CONTACT_EMAIL).toBe('billing@hushbox.ai');
    expect(hrefs(render().html)).toContain(`mailto:${BILLING_CONTACT_EMAIL}`);
  });

  it('links only to the billing address and the questions address', () => {
    expect(new Set(hrefs(render().html))).toEqual(
      new Set(['mailto:billing@hushbox.ai', 'mailto:hello@hushbox.ai'])
    );
  });

  it('names no legal address in either part', () => {
    const { html, text } = render();
    expect(html).not.toContain('legal@hushbox.ai');
    expect(text).not.toContain('legal@hushbox.ai');
  });

  it('carries the action in the plain-text part', () => {
    expect(render().text).toContain(
      `${RESOLVE_LINE}\n\nEmail the billing team\nbilling@hushbox.ai`
    );
  });

  it('carries no lockout-duration copy', () => {
    const { html, text } = render();
    expect(html).not.toContain('minutes');
    expect(text).not.toContain('minutes');
  });

  it('greets the user by name when provided', () => {
    expect(render({ userName: 'Alice' }).html).toContain('>Hi Alice,</p>');
  });

  it('uses a generic greeting when no user name is provided', () => {
    expect(render().html).toContain('>Hi,</p>');
  });

  it('never writes undefined for a missing name', () => {
    const { html, text } = render();
    expect(`${html}${text}`).not.toContain('undefined');
  });

  it('escapes a name that carries markup', () => {
    expect(render({ userName: '<b>Al</b>' }).html).toContain('>Hi &lt;b&gt;Al&lt;/b&gt;,</p>');
  });
});
