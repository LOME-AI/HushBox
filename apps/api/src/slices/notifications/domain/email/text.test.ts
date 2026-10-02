import { afterEach, describe, it, expect, vi } from 'vitest';
import { TEST_YEAR_START } from '@hushbox/shared/test-instants';
import { renderEmailText } from './text.js';
import type { EmailBody } from './document.js';
import type { ResolvedEmail } from './document.js';

const SENT_AT = new Date(TEST_YEAR_START);
const REFERENCE_YEAR = new Date(TEST_YEAR_START).getUTCFullYear();

function emailWith(body: EmailBody, heading = 'The heading'): ResolvedEmail {
  return { subject: 'The subject', heading, preheader: 'The preview', body };
}

function sectionsOf(text: string): string[] {
  return text.split('\n\n');
}

describe('renderEmailText', () => {
  it('opens with the wordmark and then the heading', () => {
    const text = renderEmailText(emailWith({ blocks: [] }), { sentAt: SENT_AT });
    expect(sectionsOf(text).slice(0, 2)).toEqual(['HushBox', 'The heading']);
  });

  it('writes the blocks in order, one section each', () => {
    const text = renderEmailText(
      emailWith({
        blocks: [
          { kind: 'paragraph', content: ['First'] },
          { kind: 'heading', text: 'Second' },
          { kind: 'finePrint', content: ['Third'] },
        ],
      }),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text).slice(2, 5)).toEqual(['First', 'Second', 'Third']);
  });

  it('joins a paragraph’s inline runs into one line', () => {
    const text = renderEmailText(
      emailWith({
        blocks: [
          {
            kind: 'paragraph',
            content: [
              'Plain, ',
              { kind: 'strong', text: 'strong' },
              ' and ',
              { kind: 'mono', text: 'mono' },
            ],
          },
        ],
      }),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text)[2]).toBe('Plain, strong and mono');
  });

  it('writes a link’s URL after its text', () => {
    const text = renderEmailText(
      emailWith({
        blocks: [
          {
            kind: 'paragraph',
            content: [
              'Add credits on the ',
              { kind: 'link', text: 'Billing page', href: 'https://example.test/billing' },
              ' with any card.',
            ],
          },
        ],
      }),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text)[2]).toBe(
      'Add credits on the Billing page (https://example.test/billing) with any card.'
    );
  });

  it('writes a figures or facts table as one label and value line per row', () => {
    const text = renderEmailText(
      emailWith({
        blocks: [
          {
            kind: 'table',
            layout: 'facts',
            rows: [
              ['Actor', ['admin@example.test']],
              ['Target', ['user ', { kind: 'mono', text: 'u-1' }]],
            ],
          },
        ],
      }),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text)[2]).toBe('Actor: admin@example.test\nTarget: user u-1');
  });

  it('writes a log table as a title line over its meta line per row', () => {
    const text = renderEmailText(
      emailWith({
        blocks: [
          {
            kind: 'table',
            layout: 'log',
            rows: [
              { title: 'user.lock', meta: ['by admin@example.test'] },
              { title: 'job.redrive', meta: ['by ops@example.test'] },
            ],
          },
        ],
      }),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text)[2]).toBe(
      'user.lock\nby admin@example.test\njob.redrive\nby ops@example.test'
    );
  });

  it('writes a link action as its label over its URL', () => {
    const text = renderEmailText(
      emailWith({
        blocks: [],
        action: { kind: 'link', label: 'Verify Email', href: 'https://example.test/verify?t=1' },
      }),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text)[2]).toBe('Verify Email\nhttps://example.test/verify?t=1');
  });

  it('writes a mail action as its label over its address', () => {
    const text = renderEmailText(
      emailWith({
        blocks: [],
        action: { kind: 'mail', label: 'Email the security team', address: 'security@hushbox.ai' },
      }),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text)[2]).toBe('Email the security team\nsecurity@hushbox.ai');
  });

  it('writes the blocks after the action after it', () => {
    const text = renderEmailText(
      emailWith({
        blocks: [{ kind: 'paragraph', content: ['Before'] }],
        action: { kind: 'link', label: 'Go', href: 'https://example.test/' },
        afterAction: [{ kind: 'finePrint', content: ['After'] }],
      }),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text).slice(2, 5)).toEqual(['Before', 'Go\nhttps://example.test/', 'After']);
  });

  it('closes with the rule, the copyright line and the questions line', () => {
    const text = renderEmailText(emailWith({ blocks: [] }), { sentAt: SENT_AT });
    expect(
      text.endsWith(
        `\n\n---\n© ${String(REFERENCE_YEAR)} LOME-AI LLC\nQuestions? hello@hushbox.ai\n`
      )
    ).toBe(true);
  });

  it('takes the copyright year from the send date', () => {
    const aYearLater = new Date(TEST_YEAR_START);
    aYearLater.setUTCFullYear(REFERENCE_YEAR + 1);
    const text = renderEmailText(emailWith({ blocks: [] }), { sentAt: aYearLater });
    expect(text).toContain(`© ${String(REFERENCE_YEAR + 1)} LOME-AI LLC`);
  });

  describe('in a timezone ahead of UTC', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('takes the copyright year in UTC, not local time', () => {
      vi.stubEnv('TZ', 'Asia/Tokyo');
      const lastMillisecondOfPriorYear = new Date(TEST_YEAR_START - 1);
      expect(lastMillisecondOfPriorYear.getFullYear()).toBe(REFERENCE_YEAR);
      const text = renderEmailText(emailWith({ blocks: [] }), {
        sentAt: lastMillisecondOfPriorYear,
      });
      expect(text).toContain(`© ${String(REFERENCE_YEAR - 1)} LOME-AI LLC`);
    });
  });

  it('writes the preview line nowhere in the text', () => {
    const text = renderEmailText(emailWith({ blocks: [] }), { sentAt: SENT_AT });
    expect(text).not.toContain('The preview');
  });

  it('writes user text without HTML escaping', () => {
    const text = renderEmailText(
      emailWith({ blocks: [{ kind: 'paragraph', content: [`Tom & "Jerry" <it's>`] }] }, 'A & B'),
      { sentAt: SENT_AT }
    );
    expect(sectionsOf(text).slice(1, 3)).toEqual(['A & B', `Tom & "Jerry" <it's>`]);
  });
});
