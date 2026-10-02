import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { NEWSLETTER_POSTAL_ADDRESS } from '@hushbox/shared';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { defineEmail, defineNewsletterIssue } from './document.js';
import { renderEmail } from './render.js';
import type { EmailBody, EmailDefinition } from './document.js';

const SENT_AT = new Date(TEST_YEAR_START);
const REFERENCE_YEAR = SENT_AT.getUTCFullYear();

const schema = z.object({ name: z.string().min(1) });

const sample: EmailDefinition<typeof schema> = defineEmail({
  kind: 'standard',
  schema,
  subject: (p) => `Hello ${p.name}`,
  preheader: (p) => `A preview for ${p.name}`,
  body: (p): EmailBody => ({ blocks: [{ kind: 'paragraph', content: [`Hi ${p.name},`] }] }),
});

function bodyOf(html: string): string {
  const match = /<body\b[^>]*>([\s\S]*)<\/body>/.exec(html);
  if (match?.[1] === undefined) throw new Error('no body');
  return match[1];
}

describe('renderEmail', () => {
  it('returns the subject', () => {
    expect(renderEmail(sample, { name: 'Alice' }, { sentAt: SENT_AT }).subject).toBe('Hello Alice');
  });

  it('titles the HTML document with the subject', () => {
    const { html } = renderEmail(sample, { name: 'Alice' }, { sentAt: SENT_AT });
    expect(html).toContain('<title>Hello Alice</title>');
  });

  it('writes the subject as the h1 when the definition declares no heading', () => {
    const { html } = renderEmail(sample, { name: 'Alice' }, { sentAt: SENT_AT });
    expect(html).toMatch(/<h1 [^>]*>Hello Alice<\/h1>/);
  });

  it('writes the declared heading as the h1 when the definition has one', () => {
    const withHeading = defineEmail({ ...sample, heading: (p) => `Welcome, ${p.name}` });
    const { html } = renderEmail(withHeading, { name: 'Alice' }, { sentAt: SENT_AT });
    expect(html).toMatch(/<h1 [^>]*>Welcome, Alice<\/h1>/);
  });

  it('writes the preview line first in the body, hidden', () => {
    const { html } = renderEmail(sample, { name: 'Alice' }, { sentAt: SENT_AT });
    expect(bodyOf(html).trimStart()).toMatch(
      /^<div class="email-preheader" style="display:none;[^"]*">A preview for Alice<\/div>/
    );
  });

  it('writes the plain-text part from the same definition', () => {
    const { text } = renderEmail(sample, { name: 'Alice' }, { sentAt: SENT_AT });
    expect(text.split('\n\n').slice(0, 3)).toEqual(['HushBox', 'Hello Alice', 'Hi Alice,']);
  });

  it('writes the same send-date year in both parts', () => {
    const aYearLater = new Date(TEST_YEAR_START);
    aYearLater.setUTCFullYear(REFERENCE_YEAR + 1);
    const { html, text } = renderEmail(sample, { name: 'Alice' }, { sentAt: aYearLater });
    const year = String(REFERENCE_YEAR + 1);
    expect(html).toContain(`&copy; ${year} LOME-AI LLC`);
    expect(text).toContain(`© ${year} LOME-AI LLC`);
  });

  it('throws before writing anything when the params fail the schema', () => {
    const subject = vi.fn((): string => 'S');
    const preheader = vi.fn((): string => 'P');
    const body = vi.fn((): EmailBody => ({ blocks: [] }));
    const spied = defineEmail({ kind: 'standard', schema, subject, preheader, body });

    expect(() => renderEmail(spied, { name: '' }, { sentAt: SENT_AT })).toThrow(z.ZodError);
    expect(subject).not.toHaveBeenCalled();
    expect(preheader).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });
});

describe('renderEmail for a newsletter issue', () => {
  const UNSUBSCRIBE = 'https://hushbox.ai/newsletter/unsubscribed?token=t';
  const MARKDOWN = '## New this month\n\nWe shipped **groups**.';
  const issue = defineNewsletterIssue({
    kind: 'newsletterIssue',
    schema: z.object({ subject: z.string().min(1), body: z.string() }),
    subject: (p) => p.subject,
    markdown: (p) => p.body,
    foot: () => ({ unsubscribeUrl: UNSUBSCRIBE }),
  });
  const rendered = renderEmail(
    issue,
    { subject: 'What <shipped>', body: MARKDOWN },
    { sentAt: SENT_AT }
  );

  it('returns the subject', () => {
    expect(rendered.subject).toBe('What <shipped>');
  });

  it('writes the subject as the h1 and the title', () => {
    expect(rendered.html).toMatch(/<h1 [^>]*>What &lt;shipped&gt;<\/h1>/);
    expect(rendered.html).toContain('<title>What &lt;shipped&gt;</title>');
  });

  it('writes no preview element', () => {
    expect(rendered.html).not.toContain('email-preheader');
  });

  it('writes the body after the h1', () => {
    expect(rendered.html.indexOf('New this month')).toBeGreaterThan(rendered.html.indexOf('</h1>'));
  });

  it('closes the card with why the reader got it, then the postal address', () => {
    const body = bodyOf(rendered.html);
    const why = body.indexOf('You&#39;re receiving this because you subscribed at hushbox.ai.');
    const postal = body.indexOf(`HushBox · ${NEWSLETTER_POSTAL_ADDRESS}`);
    expect(why).toBeGreaterThan(body.indexOf('We shipped'));
    expect(postal).toBeGreaterThan(why);
    expect(postal).toBeLessThan(body.indexOf('LOME-AI LLC'));
  });

  it("links Unsubscribe in the accent to the foot's address", () => {
    expect(rendered.html).toMatch(
      /<a class="email-foot-link" href="https:\/\/hushbox\.ai\/newsletter\/unsubscribed\?token=t" style="color:#[0-9a-f]{6};text-decoration:none;">Unsubscribe<\/a>/
    );
  });

  it('writes the markdown as a reader sees it, then the foot and the bottom lines, as the text part', () => {
    expect(rendered.text).toBe(
      [
        'HushBox',
        '',
        'What <shipped>',
        '',
        MARKDOWN,
        '',
        "You're receiving this because you subscribed at hushbox.ai.",
        `Unsubscribe: ${UNSUBSCRIBE}`,
        `HushBox · ${NEWSLETTER_POSTAL_ADDRESS}`,
        '',
        '---',
        `© ${String(REFERENCE_YEAR)} LOME-AI LLC`,
        'Questions? hello@hushbox.ai',
        '',
      ].join('\n')
    );
  });

  it('writes the send-date year in both parts', () => {
    const year = String(REFERENCE_YEAR);
    expect(rendered.html).toContain(`&copy; ${year} LOME-AI LLC`);
    expect(rendered.text).toContain(`© ${year} LOME-AI LLC`);
  });

  it('throws before writing anything when the params fail the schema', () => {
    const markdown = vi.fn((): string => 'M');
    const spied = defineNewsletterIssue({ ...issue, markdown });
    expect(() => renderEmail(spied, { subject: '', body: 'x' }, { sentAt: SENT_AT })).toThrow(
      z.ZodError
    );
    expect(markdown).not.toHaveBeenCalled();
  });
});
