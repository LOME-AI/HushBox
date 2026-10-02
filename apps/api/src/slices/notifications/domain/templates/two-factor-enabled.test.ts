import { describe, it, expect } from 'vitest';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { twoFactorEnabledEmail } from './two-factor-enabled.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const NOT_YOU = "If you didn't enable this, contact us immediately.";

function render(params: { userName?: string } = {}): RenderedEmail {
  return renderEmail(twoFactorEnabledEmail, params, { sentAt: SENT_AT });
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('twoFactorEnabledEmail', () => {
  it('keeps the subject', () => {
    expect(render().subject).toBe('Two-factor authentication enabled');
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Two-factor authentication enabled<\/h1>/);
  });

  it('shows its inbox preview line', () => {
    expect(render().html).toContain(
      `>${escapeHtml("You'll need your authenticator app to sign in from now on.")}</div>`
    );
  });

  it('says two-factor authentication was enabled', () => {
    expect(render().text).toContain(
      "Two-factor authentication has been enabled on your account. You'll need your authenticator app to sign in from now on."
    );
  });

  it('writes the not-you line at body size', () => {
    expect(render().html).toMatch(
      new RegExp(`<p class="email-paragraph" [^>]*>${escapeHtml(NOT_YOU)}</p>`)
    );
  });

  it('offers one action, to the security team', () => {
    const { html } = render();
    expect(html.match(/class="email-button /g)).toHaveLength(1);
    expect(html).toContain('>Email the security team</a>');
  });

  it('follows the action with its write-to line', () => {
    expect(render().html).toMatch(/>Or write to <a [^>]*>security@hushbox\.ai<\/a><\/p>/);
  });

  it('links only to the security address and the questions address', () => {
    expect(new Set(hrefs(render().html))).toEqual(
      new Set(['mailto:security@hushbox.ai', 'mailto:hello@hushbox.ai'])
    );
  });

  it('carries the action in the plain-text part', () => {
    expect(render().text).toContain(`${NOT_YOU}\n\nEmail the security team\nsecurity@hushbox.ai`);
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
});
