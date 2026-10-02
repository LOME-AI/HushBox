import { describe, expect, it } from 'vitest';
import { ROUTES } from '@hushbox/shared';
import { EMAIL_TEMPLATE_PREVIEWS } from './email-previews.js';

function previewHtml(name: string): string {
  const preview = EMAIL_TEMPLATE_PREVIEWS.find((entry) => entry.name === name);
  if (preview === undefined) throw new Error(`no email preview named ${name}`);
  return preview.render();
}

/** The target of the one anchor whose visible text is `label`. */
function hrefOf(html: string, label: string): URL {
  const anchors = [...html.matchAll(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([^<]*)<\/a>/g)];
  const matching = anchors.filter((anchor) => anchor[2]?.trim() === label);
  const href = matching[0]?.[1];
  if (matching.length !== 1 || href === undefined) {
    throw new Error(`expected one "${label}" link, found ${String(matching.length)}`);
  }
  return new URL(href.replaceAll('&amp;', '&'));
}

describe('newsletter email previews', () => {
  it('links the confirmation preview to the page production links to', () => {
    const link = hrefOf(previewHtml('newsletter-confirmation'), 'Confirm subscription');

    expect(link.pathname).toBe(ROUTES.NEWSLETTER_CONFIRMED);
  });

  it('links the issue preview to the unsubscribe page production links to', () => {
    const link = hrefOf(previewHtml('newsletter-issue'), 'Unsubscribe');

    expect(link.pathname).toBe(ROUTES.NEWSLETTER_UNSUBSCRIBED);
  });
});
