import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { NEWSLETTER_POSTAL_ADDRESS } from '@hushbox/shared';
import {
  defineEmail,
  defineNewsletterIssue,
  resolveEmail,
  resolveNewsletterIssue,
} from './document.js';
import type { EmailBody } from './document.js';

const schema = z.object({ name: z.string(), code: z.coerce.number() });

function sampleBody(p: { name: string; code: number }): EmailBody {
  return {
    blocks: [{ kind: 'paragraph', content: [`Hello ${p.name}`] }],
    action: { kind: 'link', label: 'Open', href: `https://example.test/${String(p.code)}` },
  };
}

const sample = defineEmail({
  kind: 'standard',
  schema,
  subject: (p) => `Subject for ${p.name}`,
  preheader: (p) => `Preview for ${p.name}`,
  body: sampleBody,
});

describe('defineEmail', () => {
  it('returns the definition it was given', () => {
    const definition = {
      kind: 'standard',
      schema,
      subject: (): string => 'S',
      preheader: (): string => 'P',
      body: (): EmailBody => ({ blocks: [] }),
    } as const;
    expect(defineEmail(definition)).toBe(definition);
  });
});

describe('resolveEmail', () => {
  it('throws when the params fail the schema', () => {
    expect(() => resolveEmail(sample, { name: 'Alice', code: 'not a number' })).toThrow(z.ZodError);
  });

  it('writes nothing from the definition when the params fail the schema', () => {
    const subject = vi.fn((): string => 'S');
    const preheader = vi.fn((): string => 'P');
    const body = vi.fn((): EmailBody => ({ blocks: [] }));
    const spied = defineEmail({ kind: 'standard', schema, subject, preheader, body });

    expect(() => resolveEmail(spied, { name: 'Alice', code: 'not a number' })).toThrow();
    expect(subject).not.toHaveBeenCalled();
    expect(preheader).not.toHaveBeenCalled();
    expect(body).not.toHaveBeenCalled();
  });

  it('resolves the subject from the params', () => {
    expect(resolveEmail(sample, { name: 'Alice', code: 1 }).subject).toBe('Subject for Alice');
  });

  it('defaults the heading to the subject', () => {
    expect(resolveEmail(sample, { name: 'Alice', code: 1 }).heading).toBe('Subject for Alice');
  });

  it('uses the declared heading over the subject', () => {
    const withHeading = defineEmail({
      kind: 'standard',
      schema,
      subject: (p) => `Subject for ${p.name}`,
      heading: (p) => `Heading for ${p.name}`,
      preheader: () => 'P',
      body: () => ({ blocks: [] }),
    });
    expect(resolveEmail(withHeading, { name: 'Alice', code: 1 }).heading).toBe('Heading for Alice');
  });

  it('resolves the preview line from the params', () => {
    expect(resolveEmail(sample, { name: 'Alice', code: 1 }).preheader).toBe('Preview for Alice');
  });

  it('resolves the body from the parsed params', () => {
    expect(resolveEmail(sample, { name: 'Alice', code: '7' }).body).toEqual({
      blocks: [{ kind: 'paragraph', content: ['Hello Alice'] }],
      action: { kind: 'link', label: 'Open', href: 'https://example.test/7' },
    });
  });
});

describe('resolveNewsletterIssue', () => {
  const issue = defineNewsletterIssue({
    kind: 'newsletterIssue',
    schema: z.object({ subject: z.string(), body: z.string() }),
    subject: (p) => p.subject,
    markdown: (p) => p.body,
    foot: () => ({ unsubscribeUrl: 'https://example.test/unsubscribe' }),
  });

  it('takes the subject as the heading', () => {
    const resolved = resolveNewsletterIssue(issue, { subject: 'July', body: 'Hi' });
    expect(resolved.heading).toBe('July');
  });

  it('maps the markdown onto blocks', () => {
    expect(resolveNewsletterIssue(issue, { subject: 'July', body: 'Hi' }).blocks).toEqual([
      { kind: 'paragraph', content: [{ kind: 'text', text: 'Hi' }] },
    ]);
  });

  it('resolves the foot from the params, with the lines every issue closes with', () => {
    expect(resolveNewsletterIssue(issue, { subject: 'July', body: 'Hi' }).foot).toEqual({
      reason: "You're receiving this because you subscribed at hushbox.ai.",
      unsubscribeUrl: 'https://example.test/unsubscribe',
      postalLine: `HushBox · ${NEWSLETTER_POSTAL_ADDRESS}`,
    });
  });

  it('refuses markdown carrying a link the writer would refuse', () => {
    expect(() =>
      resolveNewsletterIssue(issue, { subject: 'July', body: '[x](javascript:alert(1))' })
    ).toThrow(z.ZodError);
  });
});
