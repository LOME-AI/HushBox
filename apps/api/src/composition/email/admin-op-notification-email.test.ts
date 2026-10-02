import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { adminAuditLink } from '@hushbox/shared';
import { HOUR_MS, TEST_DAY_START, testUuidV7 } from '@hushbox/shared/test-time';
import { unavailableError } from '../../lib/errors/index.js';
import { errAsync, okAsync } from '../../lib/result/index.js';
import { createMockEmailSender } from '../../slices/notifications/index.js';
import {
  createAdminOpNotifierAdapter,
  createAppAdminOpNotifier,
  parseAdminNotificationRecipients,
  requireAdminUrl,
} from './admin-op-notification-email.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import type { AdminOpExecutedNotice } from '../../slices/admin/index.js';
import type { AppEnv } from '../../lib/context/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';

const NOW = new Date(TEST_DAY_START + 12 * HOUR_MS);
const ADMIN_URL = 'https://admin.hushbox.ai';

function createLogger(): { logger: Telemetry; warnCodes: string[] } {
  const warnCodes: string[] = [];
  const noop = (): void => undefined;
  return {
    warnCodes,
    logger: {
      debug: noop,
      info: noop,
      warn: (_message, fields) => {
        if (typeof fields?.errorCode === 'string') warnCodes.push(fields.errorCode);
      },
      error: noop,
      captureError: noop,
    },
  };
}

function notice(overrides: Partial<AdminOpExecutedNotice> = {}): AdminOpExecutedNotice {
  return {
    opName: 'wallet.credit',
    actor: 'admin@hushbox.ai',
    reason: 'refund escalation',
    target: { type: 'wallet', id: testUuidV7(1) },
    auditId: testUuidV7(2),
    isUndo: false,
    ...overrides,
  };
}

describe('requireAdminUrl', () => {
  it('returns the configured admin URL', () => {
    expect(requireAdminUrl({ NODE_ENV: 'development', ADMIN_URL })).toBe(ADMIN_URL);
  });

  it('throws when ADMIN_URL is absent', () => {
    expect(() => requireAdminUrl({ NODE_ENV: 'development' })).toThrow(
      'ADMIN_URL is required to build admin audit links'
    );
  });

  it('throws when ADMIN_URL is empty', () => {
    expect(() => requireAdminUrl({ NODE_ENV: 'development', ADMIN_URL: '' })).toThrow(
      'ADMIN_URL is required to build admin audit links'
    );
  });
});

describe('parseAdminNotificationRecipients', () => {
  it('reads the operators out of the role map, trimmed and lowercased', () => {
    expect(
      parseAdminNotificationRecipients(' Admin@hushbox.ai = operator , ops@hushbox.ai=operator,, ')
    ).toEqual(['admin@hushbox.ai', 'ops@hushbox.ai']);
  });

  it('mails one admin once when the role map names them twice', () => {
    expect(
      parseAdminNotificationRecipients('admin@hushbox.ai=operator, ADMIN@hushbox.ai=operator')
    ).toEqual(['admin@hushbox.ai']);
  });

  it('leaves a read-only viewer out of the operational mail entirely', () => {
    expect(
      parseAdminNotificationRecipients('admin@hushbox.ai=operator,viewer@hushbox.ai=growth-viewer')
    ).toEqual(['admin@hushbox.ai']);
  });

  it('fails fast on a missing or empty role map, and on one naming no operator', () => {
    expect(() => parseAdminNotificationRecipients()).toThrow('ADMIN_ROLE_MAP');
    expect(() => parseAdminNotificationRecipients(' , ')).toThrow('ADMIN_ROLE_MAP');
    expect(() => parseAdminNotificationRecipients('viewer@hushbox.ai=growth-viewer')).toThrow(
      'ADMIN_ROLE_MAP'
    );
  });
});

describe('createAdminOpNotifierAdapter', () => {
  it('sends one op-notification email to every admin recipient', async () => {
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const notify = createAdminOpNotifierAdapter(() => ({
      sender,
      logger,
      adminEmails: ['admin@hushbox.ai', 'ops@hushbox.ai'],
      adminUrl: ADMIN_URL,
      now: () => NOW,
    }));
    await notify(notice());
    const sent = sender.getSentMessages();
    expect(sent.map((message) => message.to)).toEqual(['admin@hushbox.ai', 'ops@hushbox.ai']);
    expect(sent[0]?.subject).toContain('wallet.credit');
    expect(sent[0]?.html).toContain('refund escalation');
    expect(sent[0]?.html).toContain(testUuidV7(2));
    expect(sent[0]?.html).toContain(NOW.toISOString());
  });

  it('renders an undo notice with the undo subject', async () => {
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const notify = createAdminOpNotifierAdapter(() => ({
      sender,
      logger,
      adminEmails: ['admin@hushbox.ai'],
      adminUrl: ADMIN_URL,
      now: () => NOW,
    }));
    await notify(notice({ isUndo: true }));
    expect(sender.getSentMessages()[0]?.subject).toContain('Undo executed');
  });

  it('renders a targetless notice without failing template validation', async () => {
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const notify = createAdminOpNotifierAdapter(() => ({
      sender,
      logger,
      adminEmails: ['admin@hushbox.ai'],
      adminUrl: ADMIN_URL,
      now: () => NOW,
    }));
    const withoutTarget: AdminOpExecutedNotice = {
      opName: 'jobs.redriveAll',
      actor: 'admin@hushbox.ai',
      reason: 'queue recovery',
      auditId: testUuidV7(3),
      isUndo: false,
    };
    await notify(withoutTarget);
    const sent = sender.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).not.toContain('Target:');
  });

  it('links the audit log on the resolved admin URL, filtered to the target', async () => {
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const notify = createAdminOpNotifierAdapter(() => ({
      sender,
      logger,
      adminEmails: ['admin@hushbox.ai'],
      adminUrl: ADMIN_URL,
      now: () => NOW,
    }));
    await notify(notice());
    expect(sender.getSentMessages()[0]?.text).toContain(
      adminAuditLink(ADMIN_URL, { targetId: testUuidV7(1) })
    );
  });

  it('stamps the instant and the copyright year from the resolved clock', async () => {
    const sender = createMockEmailSender();
    const { logger } = createLogger();
    const notify = createAdminOpNotifierAdapter(() => ({
      sender,
      logger,
      adminEmails: ['admin@hushbox.ai'],
      adminUrl: ADMIN_URL,
      now: () => NOW,
    }));
    await notify(notice());
    const text = sender.getSentMessages()[0]?.text ?? '';
    expect(text).toContain(`At: ${NOW.toISOString()}`);
    expect(text).toContain(`© ${String(NOW.getUTCFullYear())} `);
  });

  it('binds the production notifier from the request context (dev mock sender)', async () => {
    const app = new Hono<AppEnv>();
    app.use(requestScope());
    app.use(async (c, next) => {
      bindRequestValue(c, 'logger', createLogger().logger);
      await next();
    });
    app.get('/notify', async (c) => {
      await createAppAdminOpNotifier()(notice());
      return c.text('ok');
    });
    const response = await app.request(
      '/notify',
      {},
      { NODE_ENV: 'development', ADMIN_ROLE_MAP: 'admin@hushbox.ai=operator', ADMIN_URL }
    );
    expect(response.status).toBe(200);
  });

  it('fails the production notifier on a missing ADMIN_URL', async () => {
    const app = new Hono<AppEnv>();
    app.use(requestScope());
    app.use(async (c, next) => {
      bindRequestValue(c, 'logger', createLogger().logger);
      await next();
    });
    let failure: unknown;
    app.get('/notify', async (c) => {
      await createAppAdminOpNotifier()(notice()).catch((error: unknown) => {
        failure = error;
      });
      return c.text('ok');
    });
    await app.request(
      '/notify',
      {},
      { NODE_ENV: 'development', ADMIN_ROLE_MAP: 'admin@hushbox.ai=operator' }
    );
    expect(failure).toEqual(new Error('ADMIN_URL is required to build admin audit links'));
  });

  it('logs a failed send per recipient and keeps sending to the rest', async () => {
    const { logger, warnCodes } = createLogger();
    const delivered: string[] = [];
    const notify = createAdminOpNotifierAdapter(() => ({
      sender: {
        send: (message) => {
          if (message.to === 'admin@hushbox.ai') {
            return errAsync(unavailableError('send failed'));
          }
          delivered.push(message.to);
          return okAsync();
        },
      },
      logger,
      adminEmails: ['admin@hushbox.ai', 'ops@hushbox.ai'],
      adminUrl: ADMIN_URL,
      now: () => NOW,
    }));
    await notify(notice());
    expect(delivered).toEqual(['ops@hushbox.ai']);
    expect(warnCodes).toHaveLength(1);
  });
});
