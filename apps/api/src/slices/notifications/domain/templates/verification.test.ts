import { describe, it, expect } from 'vitest';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { verificationEmail } from './verification.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const VERIFICATION_URL = 'https://app.example.test/verify?token=tok-abc123';

const IGNORE_LINE =
  "If you didn't create an account with HushBox, you can safely ignore this email.";

function render(params: { userName?: string; expiresInHours?: number } = {}): RenderedEmail {
  return renderEmail(
    verificationEmail,
    { expiresInHours: 24, ...params, verificationUrl: VERIFICATION_URL },
    { sentAt: SENT_AT }
  );
}

/** A literal string as a pattern, so a URL's `?` and `.` match themselves. */
function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('verificationEmail', () => {
  it('keeps the subject', () => {
    expect(render().subject).toBe('Verify your email address');
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Verify your email address<\/h1>/);
  });

  it('no longer repeats the welcome heading', () => {
    expect(render().html).not.toContain('Welcome to HushBox');
  });

  it('shows its inbox preview line with the link lifetime', () => {
    expect(render({ expiresInHours: 48 }).html).toContain(
      '>Finish setting up your HushBox account. The link expires in 48 hours.</div>'
    );
  });

  it('asks the reader to verify their address', () => {
    expect(render().html).toMatch(
      /<p class="email-paragraph" [^>]*>Please verify your email address to get started\.<\/p>/
    );
  });

  it('offers one action, Verify Email, to the verification link', () => {
    const { html } = render();
    expect(html.match(/class="email-button /g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(
        `<a class="email-button [^"]*" href="${literal(escapeHtml(VERIFICATION_URL))}"[^>]*>Verify Email</a>`
      )
    );
  });

  it('follows the action with the paste link, whose text is its href', () => {
    const escaped = literal(escapeHtml(VERIFICATION_URL));
    expect(render().html).toMatch(
      new RegExp(
        `>Or paste this link into your browser:<br><a [^>]*href="${escaped}"[^>]*>${escaped}</a></p>`
      )
    );
  });

  it('writes the expiry line as fine print with the link lifetime', () => {
    expect(render({ expiresInHours: 48 }).html).toMatch(
      /<p class="email-fine-print" [^>]*>This link expires in 48 hours\.<\/p>/
    );
  });

  it('writes the ignore line as fine print', () => {
    expect(render().html).toMatch(
      new RegExp(`<p class="email-fine-print" [^>]*>${literal(escapeHtml(IGNORE_LINE))}</p>`)
    );
  });

  it('places the expiry and ignore lines after the action, in that order', () => {
    const { html } = render();
    const action = html.indexOf('>Verify Email</a>');
    const expiry = html.indexOf('This link expires in');
    const ignore = html.indexOf(escapeHtml(IGNORE_LINE));
    expect(action).toBeGreaterThan(-1);
    expect(expiry).toBeGreaterThan(action);
    expect(ignore).toBeGreaterThan(expiry);
  });

  it('never writes a lifetime other than the one it is given', () => {
    const { html, text } = render({ expiresInHours: 48 });
    expect(`${html}${text}`).not.toContain('24 hours');
  });

  it('carries the action, the link and the expiry in the plain-text part', () => {
    expect(render().text).toContain(
      `Verify Email\n${VERIFICATION_URL}\n\nThis link expires in 24 hours.\n\n${IGNORE_LINE}`
    );
  });

  it('links only to the verification link and the questions address', () => {
    expect(new Set(hrefs(render().html))).toEqual(
      new Set([escapeHtml(VERIFICATION_URL), 'mailto:hello@hushbox.ai'])
    );
  });

  it('refuses params without a link lifetime', () => {
    expect(() =>
      // @ts-expect-error -- the params omit the required link lifetime on purpose
      renderEmail(verificationEmail, { verificationUrl: VERIFICATION_URL }, { sentAt: SENT_AT })
    ).toThrow();
  });

  it('refuses params without a verification URL', () => {
    expect(() =>
      // @ts-expect-error -- the params omit the required verification URL on purpose
      renderEmail(verificationEmail, { expiresInHours: 24 }, { sentAt: SENT_AT })
    ).toThrow();
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

  it('escapes html in the user name', () => {
    const { html } = render({ userName: '<b>Eve</b>' });
    expect(html).toContain('&lt;b&gt;Eve&lt;/b&gt;');
    expect(html).not.toContain('<b>Eve</b>');
  });
});
