import { describe, it, expect } from 'vitest';
import { adminAuditLink } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  TEST_DAY_START,
  isoAt,
  testUuidV7,
} from '@hushbox/shared/test-time';
import { renderEmail } from '../email/render.js';
import { adminOpNotificationEmail } from './admin-op-notification.js';
import type { RenderedEmail } from '../email/render.js';
import type { z } from 'zod';

type Params = z.input<typeof adminOpNotificationEmail.schema>;

const ADMIN_URL = 'https://admin.hushbox.ai';
const OCCURRED_AT = isoAt(TEST_DAY_START + 14 * HOUR_MS + 30 * MINUTE_MS);
/** The audit filter for the test day: that day to the next, as bare dates. */
const DAY_FROM = isoAt(TEST_DAY_START).slice(0, 10);
const DAY_TO = isoAt(TEST_DAY_START + DAY_MS).slice(0, 10);

const targetlessParams: Params = {
  opName: 'user.lock',
  actorEmail: 'admin@hushbox.ai',
  reason: 'Chargeback dispute on payment pay_1234',
  occurredAt: OCCURRED_AT,
  isUndo: false,
  auditId: testUuidV7(2),
  adminUrl: ADMIN_URL,
};

const baseParams: Params = { ...targetlessParams, target: { type: 'user', id: testUuidV7(1) } };

function render(overrides: Partial<Params> = {}): RenderedEmail {
  return renderEmail(
    adminOpNotificationEmail,
    { ...baseParams, ...overrides },
    { sentAt: new Date(OCCURRED_AT) }
  );
}

function preheaderOf(html: string): string {
  return /<div class="email-preheader"[^>]*>([^<]*)<\/div>/.exec(html)?.[1] ?? '';
}

function buttonHrefOf(html: string): string {
  return /<a class="email-button [^"]*" href="([^"]*)"/.exec(html)?.[1] ?? '';
}

/** The text part's facts rows, in order. */
function factLabels(text: string): string[] {
  return text
    .split('\n')
    .map((line) => /^(Actor|Target|Reason|At|Audit record): /.exec(line)?.[1])
    .filter((label): label is string => label !== undefined);
}

describe('adminOpNotificationEmail subject', () => {
  it('names a forward operation after the admin brand', () => {
    expect(render().subject).toBe('HushBox Admin · Operation executed: user.lock');
  });

  it('names an undo as an undo', () => {
    expect(render({ isUndo: true }).subject).toBe('HushBox Admin · Undo executed: user.lock');
  });
});

describe('adminOpNotificationEmail heading', () => {
  it('reads as an executed operation', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Admin operation executed<\/h1>/);
  });

  it('reads as an executed undo for an undo', () => {
    expect(render({ isUndo: true }).html).toMatch(/<h1 [^>]*>Admin undo executed<\/h1>/);
  });

  it('follows the heading with the op name in mono', () => {
    expect(render().html).toMatch(/<\/h1><p class="email-op-line"[^>]*>user\.lock<\/p>/);
  });
});

describe('adminOpNotificationEmail facts', () => {
  it('lists actor, target, reason, instant and audit record in that order', () => {
    expect(factLabels(render().text)).toEqual(['Actor', 'Target', 'Reason', 'At', 'Audit record']);
  });

  it('states every fact in the text part', () => {
    expect(render().text).toContain(
      [
        'Actor: admin@hushbox.ai',
        `Target: user ${testUuidV7(1)}`,
        'Reason: Chargeback dispute on payment pay_1234',
        `At: ${OCCURRED_AT}`,
        `Audit record: ${testUuidV7(2)}`,
      ].join('\n')
    );
  });

  it('writes the target id in mono', () => {
    expect(render().html).toMatch(
      new RegExp(`>user <span style="font-family:[^"]*">${testUuidV7(1)}</span></td>`)
    );
  });

  it('writes the audit record id in mono', () => {
    expect(render().html).toMatch(
      new RegExp(`><span style="font-family:[^"]*">${testUuidV7(2)}</span></td>`)
    );
  });

  it('keeps the full instant, not just the day', () => {
    expect(render().html).toContain(`>${OCCURRED_AT}</td>`);
  });

  it('shows no target row for an operation without a target', () => {
    expect(
      factLabels(
        renderEmail(adminOpNotificationEmail, targetlessParams, {
          sentAt: new Date(OCCURRED_AT),
        }).text
      )
    ).toEqual(['Actor', 'Reason', 'At', 'Audit record']);
  });
});

describe('adminOpNotificationEmail audit link', () => {
  it('opens the audit log filtered to the target', () => {
    expect(buttonHrefOf(render().html)).toBe(
      adminAuditLink(ADMIN_URL, { targetId: testUuidV7(1) }).replaceAll('&', '&amp;')
    );
  });

  it('labels the button "Open in the audit log"', () => {
    expect(render().html).toMatch(/<a class="email-button [^>]*>Open in the audit log<\/a>/);
  });

  it('gives the audit link as its paste line in the text part', () => {
    expect(render().text).toContain(
      `Open in the audit log\n${adminAuditLink(ADMIN_URL, { targetId: testUuidV7(1) })}`
    );
  });

  it('filters by the op name over its UTC day when the operation has no target', () => {
    const { text } = renderEmail(adminOpNotificationEmail, targetlessParams, {
      sentAt: new Date(OCCURRED_AT),
    });
    expect(text).toContain(
      adminAuditLink(ADMIN_URL, { action: 'user.lock', from: DAY_FROM, to: DAY_TO })
    );
  });

  it('refuses an admin origin that is not a URL', () => {
    expect(() => render({ adminUrl: 'admin' })).toThrow();
  });
});

describe('adminOpNotificationEmail preview line', () => {
  it('reads "<actor> ran <op>. Reason: <reason>."', () => {
    expect(preheaderOf(render().html)).toBe(
      'admin@hushbox.ai ran user.lock. Reason: Chargeback dispute on payment pay_1234.'
    );
  });

  it('adds no second full stop to a reason that ends with one', () => {
    expect(preheaderOf(render({ reason: 'Refund approved.' }).html)).toBe(
      'admin@hushbox.ai ran user.lock. Reason: Refund approved.'
    );
  });
});

describe('adminOpNotificationEmail escaping', () => {
  it('escapes markup in the admin-authored reason', () => {
    const { html } = render({ reason: '<script>alert(1)</script>' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('writes no long dash anywhere', () => {
    const { subject, html, text } = render();
    expect(`${subject}${html}${text}`).not.toMatch(/[—–]|&mdash;|&ndash;/);
  });
});
