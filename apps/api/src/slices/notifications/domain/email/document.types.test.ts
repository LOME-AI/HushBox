import { describe, it } from 'vitest';
import { z } from 'zod';
import { expectCompileTimeProof } from '@hushbox/shared/test-assertions';
import { defineEmail, defineNewsletterIssue } from './document.js';
import type { EmailAction } from './document.js';

/**
 * Compile-time assertions: each `@ts-expect-error` claims the marked definition
 * does not compile, so a model that goes slack leaves the directive unused and
 * fails the typecheck gate. The runtime half only proves each witness exists.
 */
const schema = z.object({});
const action: EmailAction = { kind: 'link', label: 'Open', href: 'https://example.test/' };

describe('the email definition type', () => {
  it('refuses a second action', () => {
    const twoActions = (): unknown =>
      defineEmail({
        kind: 'standard',
        schema,
        subject: () => 'S',
        preheader: () => 'P',
        body: () => ({
          blocks: [],
          // @ts-expect-error — a body holds at most one action, so no field takes a list of them
          action: [action, action],
        }),
      });
    expectCompileTimeProof(twoActions);
  });

  it('refuses a definition without a preview line', () => {
    const noPreview = (): unknown =>
      // @ts-expect-error — a standard email must declare its preview line
      defineEmail({
        kind: 'standard',
        schema,
        subject: () => 'S',
        body: () => ({ blocks: [] }),
      });
    expectCompileTimeProof(noPreview);
  });

  it('refuses a block kind outside the closed set', () => {
    const unknownBlock = (): unknown =>
      defineEmail({
        kind: 'standard',
        schema,
        subject: () => 'S',
        preheader: () => 'P',
        body: () => ({
          // @ts-expect-error — 'image' is not an email block kind
          blocks: [{ kind: 'image', src: 'https://example.test/a.png' }],
        }),
      });
    expectCompileTimeProof(unknownBlock);
  });

  it('refuses a field carrying markup', () => {
    const markupField = (): unknown =>
      defineEmail({
        kind: 'standard',
        schema,
        subject: () => 'S',
        preheader: () => 'P',
        body: () => ({ blocks: [] }),
        // @ts-expect-error — a definition carries no markup; the renderer writes every tag
        html: '<p>Hand-written</p>',
      });
    expectCompileTimeProof(markupField);
  });

  it('admits a newsletter issue that declares markdown and a foot', () => {
    const issue = (): unknown =>
      defineNewsletterIssue({
        kind: 'newsletterIssue',
        schema,
        subject: () => 'S',
        markdown: () => '## Section',
        foot: () => ({ unsubscribeUrl: 'https://example.test/unsubscribe' }),
      });
    expectCompileTimeProof(issue);
  });

  it('refuses a newsletter issue with a preview line', () => {
    const issueWithPreview = (): unknown =>
      defineNewsletterIssue({
        kind: 'newsletterIssue',
        schema,
        subject: () => 'S',
        // @ts-expect-error — a newsletter issue has no preview line; the inbox shows its first text
        preheader: () => 'P',
        markdown: () => '## Section',
        foot: () => ({ unsubscribeUrl: 'https://example.test/unsubscribe' }),
      });
    expectCompileTimeProof(issueWithPreview);
  });

  it('refuses a newsletter issue without a foot', () => {
    const issueWithoutFoot = (): unknown =>
      // @ts-expect-error — every newsletter issue carries its foot and unsubscribe link
      defineNewsletterIssue({
        kind: 'newsletterIssue',
        schema,
        subject: () => 'S',
        markdown: () => '## Section',
      });
    expectCompileTimeProof(issueWithoutFoot);
  });
});
