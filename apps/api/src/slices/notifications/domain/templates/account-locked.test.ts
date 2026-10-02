import { describe, it, expect } from 'vitest';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { accountLockedEmail } from './account-locked.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const NOT_YOU =
  "If this wasn't you, someone may be trying to access your account. We recommend changing your password when the lockout expires.";

function render(params: { userName?: string; lockoutMinutes?: number } = {}): RenderedEmail {
  return renderEmail(accountLockedEmail, { lockoutMinutes: 15, ...params }, { sentAt: SENT_AT });
}

/** A literal string as a pattern, so its periods match themselves. */
function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('accountLockedEmail', () => {
  it('keeps the subject', () => {
    expect(render().subject).toBe('Your account has been temporarily locked');
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Your account has been temporarily locked<\/h1>/);
  });

  it.each([15, 30])('states %i minutes in the inbox preview line', (minutes) => {
    expect(render({ lockoutMinutes: minutes }).html).toContain(
      `>Too many failed sign-in attempts. You can try again in ${String(minutes)} minutes.</div>`
    );
  });

  it.each([15, 30])('states the lock and the %i minute retry in one body paragraph', (minutes) => {
    const statement = `Your HushBox account has been temporarily locked due to multiple failed sign-in attempts. You can try again in ${String(minutes)} minutes.`;
    expect(render({ lockoutMinutes: minutes }).html).toMatch(
      new RegExp(`<p class="email-paragraph" [^>]*>${literal(statement)}</p>`)
    );
  });

  it.each([15, 30])('states %i minutes in the plain-text part', (minutes) => {
    expect(render({ lockoutMinutes: minutes }).text).toContain(
      `due to multiple failed sign-in attempts. You can try again in ${String(minutes)} minutes.`
    );
  });

  it('writes the not-you line at body size', () => {
    expect(render().html).toMatch(
      new RegExp(`<p class="email-paragraph" [^>]*>${literal(escapeHtml(NOT_YOU))}</p>`)
    );
  });

  it('offers no action', () => {
    const { html } = render();
    expect(html).not.toContain('class="email-button ');
    expect(html).not.toContain('Or write to');
    expect(html).not.toContain('Or paste this link');
  });

  it('links only to the questions address', () => {
    expect(hrefs(render().html)).toEqual(['mailto:hello@hushbox.ai']);
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
