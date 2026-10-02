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
import { adminDailyDigestEmail } from './admin-daily-digest.js';
import type { AdminDigestAction } from './admin-daily-digest.js';
import type { RenderedEmail } from '../email/render.js';

const ADMIN_URL = 'https://admin.hushbox.ai';
const DAY = isoAt(TEST_DAY_START).slice(0, 10);
/** The audit filter for the test day: that day to the next, as bare dates. */
const DAY_FROM = isoAt(TEST_DAY_START).slice(0, 10);
const DAY_TO = isoAt(TEST_DAY_START + DAY_MS).slice(0, 10);
const SENT_AT = new Date(TEST_DAY_START + 24 * HOUR_MS);
const FIRST_AT = isoAt(TEST_DAY_START + 9 * HOUR_MS + 15 * MINUTE_MS);
const SECOND_AT = isoAt(TEST_DAY_START + 17 * HOUR_MS + 42 * MINUTE_MS);

function action(opName: string, actorEmail = 'admin@hushbox.ai'): AdminDigestAction {
  return {
    opName,
    actorEmail,
    target: { type: 'user', id: testUuidV7(1) },
    occurredAt: FIRST_AT,
  };
}

const lockAndRedriveByOneAdmin: readonly AdminDigestAction[] = [
  {
    opName: 'user.lock',
    actorEmail: 'admin@hushbox.ai',
    target: { type: 'user', id: testUuidV7(1) },
    occurredAt: FIRST_AT,
  },
  {
    opName: 'job.redrive',
    actorEmail: 'admin@hushbox.ai',
    target: { type: 'job', id: testUuidV7(3) },
    occurredAt: SECOND_AT,
  },
];

function render(actions: readonly AdminDigestAction[] = lockAndRedriveByOneAdmin): RenderedEmail {
  return renderEmail(
    adminDailyDigestEmail,
    { day: DAY, actions: [...actions], adminUrl: ADMIN_URL },
    { sentAt: SENT_AT }
  );
}

function preheaderOf(html: string): string {
  return /<div class="email-preheader"[^>]*>([^<]*)<\/div>/.exec(html)?.[1] ?? '';
}

function buttonHrefOf(html: string): string {
  return /<a class="email-button [^"]*" href="([^"]*)"/.exec(html)?.[1] ?? '';
}

describe('adminDailyDigestEmail subject and heading', () => {
  it('names the digest day after the admin brand', () => {
    expect(render().subject).toBe(`HushBox Admin · Daily audit digest for ${DAY}`);
  });

  it('heads the card "Daily admin digest"', () => {
    expect(render().html).toMatch(/<h1 [^>]*>Daily admin digest<\/h1>/);
  });

  it('writes no long dash anywhere', () => {
    const { subject, html, text } = render();
    expect(`${subject}${html}${text}`).not.toMatch(/[—–]|&mdash;|&ndash;/);
  });
});

describe('adminDailyDigestEmail count', () => {
  it('counts one action in the singular', () => {
    expect(render([action('user.lock')]).text).toContain(`1 admin action executed on ${DAY}.`);
  });

  it('counts several actions in the plural', () => {
    expect(render().text).toContain(`2 admin actions executed on ${DAY}.`);
  });
});

describe('adminDailyDigestEmail log', () => {
  it('writes the op over who ran it, on what, and when', () => {
    expect(render().text).toContain(
      [
        'user.lock',
        `by admin@hushbox.ai on user ${testUuidV7(1)} at ${FIRST_AT}`,
        'job.redrive',
        `by admin@hushbox.ai on job ${testUuidV7(3)} at ${SECOND_AT}`,
      ].join('\n')
    );
  });

  it('writes each op as a log title', () => {
    expect(render().html).toMatch(/<span class="email-log-title"[^>]*>user\.lock<\/span>/);
  });

  it('writes each target id in mono', () => {
    expect(render().html).toMatch(
      new RegExp(`on user <span style="font-family:[^"]*">${testUuidV7(1)}</span> at `)
    );
  });

  it('leaves the target clause out for an action without a target', () => {
    const { text } = render([
      { opName: 'model.disable', actorEmail: 'admin@hushbox.ai', occurredAt: FIRST_AT },
    ]);
    expect(text).toContain(`model.disable\nby admin@hushbox.ai at ${FIRST_AT}`);
  });

  it('escapes markup in an action field', () => {
    const { html } = render([action('<img src=x>')]);
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img');
  });
});

describe('adminDailyDigestEmail with no actions', () => {
  it('states that nothing ran that day', () => {
    expect(render([]).text).toContain(`No admin actions executed on ${DAY}.`);
  });

  it('shows no log table', () => {
    // The head's light-scheme rules name every class, so the element is what is absent.
    expect(render([]).html).not.toContain('<span class="email-log-title"');
  });

  it('keeps the audit log button', () => {
    expect(buttonHrefOf(render([]).html)).not.toBe('');
  });

  it('previews "No admin actions."', () => {
    expect(preheaderOf(render([]).html)).toBe('No admin actions.');
  });
});

describe('adminDailyDigestEmail audit link', () => {
  it('opens the audit log filtered to the digest day', () => {
    expect(buttonHrefOf(render().html)).toBe(
      adminAuditLink(ADMIN_URL, { from: DAY_FROM, to: DAY_TO }).replaceAll('&', '&amp;')
    );
  });

  it('labels the button "Open in the audit log"', () => {
    expect(render().html).toMatch(/<a class="email-button [^>]*>Open in the audit log<\/a>/);
  });

  it('gives the audit link as its paste line in the text part', () => {
    expect(render().text).toContain(
      `Open in the audit log\n${adminAuditLink(ADMIN_URL, { from: DAY_FROM, to: DAY_TO })}`
    );
  });
});

describe('adminDailyDigestEmail preview line', () => {
  it.each<[string, readonly AdminDigestAction[], string]>([
    ['one action', [action('user.lock')], 'user.lock by admin@hushbox.ai.'],
    [
      'two actions by one admin',
      lockAndRedriveByOneAdmin,
      'user.lock and job.redrive, both by admin@hushbox.ai.',
    ],
    [
      'three actions by one admin',
      [action('user.lock'), action('job.redrive'), action('wallet.credit')],
      'user.lock, job.redrive and wallet.credit, all by admin@hushbox.ai.',
    ],
    [
      'repeats of one op by one admin',
      [action('user.lock'), action('user.lock')],
      'user.lock, both by admin@hushbox.ai.',
    ],
    [
      'several admins',
      [action('user.lock'), action('job.redrive', 'ops@hushbox.ai')],
      'user.lock and job.redrive by 2 admins.',
    ],
    [
      'more than three distinct ops',
      [
        action('user.lock'),
        action('job.redrive'),
        action('wallet.credit'),
        action('model.disable'),
        action('banner.set', 'ops@hushbox.ai'),
      ],
      'user.lock, job.redrive, wallet.credit and 2 more by 2 admins.',
    ],
  ])('previews %s', (_case, actions, expected) => {
    expect(preheaderOf(render(actions).html)).toBe(expected);
  });
});
