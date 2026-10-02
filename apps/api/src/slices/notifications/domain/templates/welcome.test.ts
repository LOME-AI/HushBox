import { describe, it, expect } from 'vitest';
import {
  FEE_CATEGORIES,
  formatFeePercent,
  PRODUCT_TAGLINE,
  PRODUCT_TAGLINE_SENTENCES,
  ROUTES,
  TOTAL_FEE_RATE,
} from '@hushbox/shared';
import { MANAGE_BALANCE_ONLINE_LABEL } from '@hushbox/shared/billing-portal';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmail } from '../email/render.js';
import { escapeHtml } from '../email/escape.js';
import { welcomeEmail } from './welcome.js';
import type { RenderedEmail } from '../email/render.js';

const SENT_AT = new Date(TEST_YEAR_START);

const FRONTEND_URL = 'https://app.example.test';

const BILLING_URL = new URL(ROUTES.BILLING, FRONTEND_URL).toString();

const APP_URL = new URL(ROUTES.CHAT, FRONTEND_URL).toString();

const CREDITS_TAIL = ` with any card. In the mobile app, tap “${MANAGE_BALANCE_ONLINE_LABEL}” to add them on our website and skip in-app processing fees.`;

function render(params: { userName?: string } = {}): RenderedEmail {
  return renderEmail(
    welcomeEmail,
    { ...params, billingUrl: BILLING_URL, appUrl: APP_URL },
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

describe('welcomeEmail', () => {
  it('keeps the subject', () => {
    expect(render().subject).toBe('Welcome to HushBox');
  });

  it('writes the subject as its heading', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Welcome to HushBox<\/h1>/);
  });

  it('shows its inbox preview line', () => {
    expect(render().html).toContain('>Pay as you go, and your credits never expire.</div>');
  });

  it('writes the product tagline as one paragraph', () => {
    expect(PRODUCT_TAGLINE).toBe(PRODUCT_TAGLINE_SENTENCES.join(' '));
    expect(render().html).toMatch(
      new RegExp(`<p class="email-paragraph" [^>]*>${literal(PRODUCT_TAGLINE)}</p>`)
    );
  });

  it('has one section, How billing works', () => {
    const headings = [...render().html.matchAll(/<h2 [^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);
    expect(headings).toEqual(['How billing works']);
  });

  it('explains pay-as-you-go with a semicolon, not a dash', () => {
    expect(render().html).toContain(
      '>HushBox is pay-as-you-go. No subscriptions, no recurring charges. Add credits when you need them; they never expire.</p>'
    );
  });

  it('states the total fee', () => {
    expect(render().html).toContain(
      `>We charge a ${formatFeePercent(TOTAL_FEE_RATE)} fee on AI model usage:</p>`
    );
  });

  it('writes a figures row for every fee category with its percent', () => {
    const { html } = render();
    for (const category of FEE_CATEGORIES) {
      expect(html).toMatch(
        new RegExp(
          `<tr><td class="email-table-label [^"]*" [^>]*>${literal(escapeHtml(category.shortLabel))}</td><td class="email-table-value [^"]*" [^>]*>${literal(formatFeePercent(category.rate))}</td></tr>`
        )
      );
    }
    expect(html.match(/<td class="email-table-label /g)).toHaveLength(FEE_CATEGORIES.length);
  });

  it('writes every fee category in the plain-text part', () => {
    const { text } = render();
    for (const category of FEE_CATEGORIES) {
      expect(text).toContain(`${category.shortLabel}: ${formatFeePercent(category.rate)}`);
    }
  });

  it('links the Billing page and names the Manage Balance Online button in curly quotes', () => {
    expect(render().html).toMatch(
      new RegExp(
        `>Add credits on the <a class="email-link" href="${literal(BILLING_URL)}"[^>]*>Billing page</a>${literal(CREDITS_TAIL)}</p>`
      )
    );
  });

  it('offers one action, Open HushBox, to the app', () => {
    const { html } = render();
    expect(html.match(/class="email-button /g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(`<a class="email-button [^"]*" href="${literal(APP_URL)}"[^>]*>Open HushBox</a>`)
    );
  });

  it('follows the action with the paste link, whose text is its href', () => {
    expect(render().html).toMatch(
      new RegExp(
        `>Or paste this link into your browser:<br><a [^>]*href="${literal(APP_URL)}"[^>]*>${literal(APP_URL)}</a></p>`
      )
    );
  });

  it('links only to the Billing page, the app and the questions address', () => {
    expect(new Set(hrefs(render().html))).toEqual(
      new Set([BILLING_URL, APP_URL, 'mailto:hello@hushbox.ai'])
    );
  });

  it('carries the billing link and the action in the plain-text part', () => {
    const { text } = render();
    expect(text).toContain(`Add credits on the Billing page (${BILLING_URL})${CREDITS_TAIL}`);
    expect(text).toContain(`Open HushBox\n${APP_URL}`);
  });

  it('drops "transparent"', () => {
    const { html, text } = render();
    expect(`${html}${text}`).not.toContain('transparent');
  });

  it('writes no long dash in either part', () => {
    const { html, text } = render();
    expect(`${html}${text}`).not.toMatch(/[–—]|&mdash;|&ndash;|&#821[12];|&#x201[34];/i);
  });

  it('refuses params without the app links', () => {
    expect(() =>
      // @ts-expect-error -- the params omit the required app links on purpose
      renderEmail(welcomeEmail, {}, { sentAt: SENT_AT })
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
});
