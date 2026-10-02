import { describe, it, expect } from 'vitest';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { twoFactorLockedEmail } from './two-factor-locked.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const SUBJECT = 'Your password was used, and the two-factor code was wrong';

const NOT_YOU =
  "If this wasn't you, someone knows your password and only your two-factor code stopped them. Change your password as soon as you can.";

function render(params: { userName?: string; lockoutMinutes?: number } = {}): RenderedEmail {
  return renderEmail(twoFactorLockedEmail, { lockoutMinutes: 15, ...params }, { sentAt: SENT_AT });
}

/** A literal string as a pattern, so its periods match themselves. */
function literal(text: string): string {
  return text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((match) => match[1] ?? '');
}

describe('twoFactorLockedEmail', () => {
  it('says the password was used and the code was wrong in the subject', () => {
    expect(render().subject).toBe(SUBJECT);
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(new RegExp(`<h1 [^>]*>${literal(SUBJECT)}</h1>`));
  });

  it.each([15, 30])('states the %i minute pause in the inbox preview line', (minutes) => {
    expect(render({ lockoutMinutes: minutes }).html).toContain(
      `>Too many wrong two-factor codes. Two-factor sign-in is paused for ${String(minutes)} minutes.</div>`
    );
  });

  it.each([15, 30])(
    'states the password, the codes and the %i minute pause in one paragraph',
    (minutes) => {
      const statement = `Someone signed in to your HushBox account with your password, then entered too many wrong two-factor codes. Two-factor sign-in is paused for ${String(minutes)} minutes.`;
      expect(render({ lockoutMinutes: minutes }).html).toMatch(
        new RegExp(`<p class="email-paragraph" [^>]*>${literal(statement)}</p>`)
      );
    }
  );

  it.each([15, 30])('states %i minutes in the plain-text part', (minutes) => {
    expect(render({ lockoutMinutes: minutes }).text).toContain(
      `Two-factor sign-in is paused for ${String(minutes)} minutes.`
    );
  });

  it('tells the holder what a stranger with the password means', () => {
    expect(render().html).toMatch(
      new RegExp(`<p class="email-paragraph" [^>]*>${literal(escapeHtml(NOT_YOU))}</p>`)
    );
  });

  it('offers the security team as its one action', () => {
    expect(render().text).toContain(`${NOT_YOU}\n\nEmail the security team\nsecurity@hushbox.ai`);
  });

  it('links only to the security and questions addresses', () => {
    expect(new Set(hrefs(render().html))).toEqual(
      new Set(['mailto:security@hushbox.ai', 'mailto:hello@hushbox.ai'])
    );
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
