import { describe, it, expect } from 'vitest';
import { ROUTES } from '@hushbox/shared';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { twoFactorDisabledEmail } from './two-factor-disabled.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const FRONTEND_URL = 'https://app.example.test';

const SETTINGS_URL = new URL(ROUTES.SETTINGS, FRONTEND_URL).toString();

const NOT_YOU = "If you didn't disable this, contact us immediately.";

function render(params: { userName?: string } = {}): RenderedEmail {
  return renderEmail(
    twoFactorDisabledEmail,
    { ...params, settingsUrl: SETTINGS_URL },
    { sentAt: SENT_AT }
  );
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('twoFactorDisabledEmail', () => {
  it('keeps the subject', () => {
    expect(render().subject).toBe('Two-factor authentication disabled');
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Two-factor authentication disabled<\/h1>/);
  });

  it('shows its inbox preview line', () => {
    expect(render().html).toContain('>Your account is now protected by your password only.</div>');
  });

  it('says two-factor authentication was removed', () => {
    expect(render().text).toContain(
      'Two-factor authentication has been removed from your account. Your account is now protected by password only.'
    );
  });

  it('recommends re-enabling 2FA in Settings, linked to the settings page', () => {
    expect(render().html).toMatch(
      new RegExp(
        `>We recommend re-enabling 2FA in <a class="email-link" href="${SETTINGS_URL}"[^>]*>Settings</a>.</p>`
      )
    );
  });

  it('drops "for maximum security"', () => {
    const { html, text } = render();
    expect(`${html}${text}`).not.toContain('for maximum security');
  });

  it('writes the settings URL after its link text in the plain-text part', () => {
    expect(render().text).toContain(`We recommend re-enabling 2FA in Settings (${SETTINGS_URL}).`);
  });

  it('refuses params without a settings URL', () => {
    expect(() =>
      // @ts-expect-error -- the params omit the required settings URL on purpose
      renderEmail(twoFactorDisabledEmail, {}, { sentAt: SENT_AT })
    ).toThrow();
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

  it('links only to the settings page, the security address and the questions address', () => {
    expect(new Set(hrefs(render().html))).toEqual(
      new Set([SETTINGS_URL, 'mailto:security@hushbox.ai', 'mailto:hello@hushbox.ai'])
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
