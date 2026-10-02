import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { TEST_DAY_START, TEST_YEAR_START } from '@hushbox/shared/test-time';
import { createMockEmailSender } from '../../slices/notifications/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import {
  createAppTwoFactorEnabledEmailPort,
  createTwoFactorEnabledEmailAdapter,
} from './two-factor-enabled-email.js';
import { createJobWakeCollector, grantJobWakes } from '../../lib/jobs/index.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { SafeLogFields, Telemetry } from '../../lib/telemetry/index.js';
import type { EmailSender } from '../../slices/notifications/index.js';

const NEXT_YEAR_START = Date.UTC(new Date(TEST_YEAR_START).getUTCFullYear() + 1, 0, 1);

function hrefsOf(html: string | undefined): Set<string | undefined> {
  return new Set([...(html ?? '').matchAll(/href="([^"]*)"/g)].map((match) => match[1]));
}

interface RecordedWarn {
  readonly msg: string;
  readonly fields: SafeLogFields | undefined;
}

function recordingTelemetry(): { telemetry: Telemetry; warns: RecordedWarn[] } {
  const warns: RecordedWarn[] = [];
  const noop = (): void => undefined;
  const telemetry: Telemetry = {
    debug: noop,
    info: noop,
    warn: (msg, fields) => {
      warns.push({ msg, fields });
    },
    error: noop,
    captureError: noop,
  };
  return { telemetry, warns };
}

function failingSender(): EmailSender {
  return { send: () => errAsync(unavailableError('sender down')) };
}

describe('createTwoFactorEnabledEmailAdapter', () => {
  function harness(
    sender: EmailSender,
    now: () => Date = () => new Date(TEST_DAY_START)
  ): {
    port: ReturnType<typeof createTwoFactorEnabledEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createTwoFactorEnabledEmailAdapter(() => {
      calls += 1;
      return { sender, logger: telemetry, now };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends the 2FA-enabled notice with the fixed subject', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendTwoFactorEnabledEmail({ to: 'user@example.com' });
    expect(result.isOk()).toBe(true);
    const sent = sender.getSentMessages()[0];
    expect(sent?.to).toBe('user@example.com');
    expect(sent?.subject).toBe('Two-factor authentication enabled');
    expect(sent?.html).toContain('enabled');
    expect(sent?.text).toContain('enabled');
  });

  it('stamps the copyright year from the resolver clock', async () => {
    for (const instant of [TEST_YEAR_START, NEXT_YEAR_START]) {
      const sender = createMockEmailSender();
      const { port } = harness(sender, () => new Date(instant));
      await port.sendTwoFactorEnabledEmail({ to: 'user@example.com' });
      const year = String(new Date(instant).getUTCFullYear());
      expect(sender.getSentMessages()[0]?.text).toContain(`© ${year} `);
    }
  });

  it('links only to the security address and the questions address', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendTwoFactorEnabledEmail({ to: 'user@example.com' });
    expect(hrefsOf(sender.getSentMessages()[0]?.html)).toEqual(
      new Set(['mailto:security@hushbox.ai', 'mailto:hello@hushbox.ai'])
    );
  });

  it('greets by name when a userName is given', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendTwoFactorEnabledEmail({ to: 'user@example.com', userName: 'Ada' });
    expect(sender.getSentMessages()[0]?.html).toContain('Ada');
  });

  it('logs the failure code and returns it on the error channel', async () => {
    const { port, warns } = harness(failingSender());
    const result = await port.sendTwoFactorEnabledEmail({ to: 'user@example.com' });
    expect(warns).toEqual([
      { msg: '2fa-enabled email send failed', fields: { errorCode: 'unavailable' } },
    ]);
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendTwoFactorEnabledEmail({ to: 'a@example.com' });
    await port.sendTwoFactorEnabledEmail({ to: 'b@example.com' });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppTwoFactorEnabledEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app 2FA-enabled email port tests');
  }
  const db = grantJobWakes(
    createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
    createJobWakeCollector()
  );

  afterAll(async () => {
    await db.$client.end();
  });

  it('sends through the env-selected sender inside a request context', async () => {
    const { telemetry } = recordingTelemetry();
    const app = new Hono<AppEnv>();
    app.use(requestScope());
    app.post('/send', async (c) => {
      bindRequestValue(c, 'db', db);
      bindRequestValue(c, 'logger', telemetry);
      const port = createAppTwoFactorEnabledEmailPort();
      const result = await port.sendTwoFactorEnabledEmail({ to: 'user@example.com' });
      return c.json({ outcome: result.isOk() ? 'ok' : 'err' });
    });
    const env: Bindings = { NODE_ENV: 'development' };
    const res = await app.request('/send', { method: 'POST' }, env);
    expect(await res.json()).toEqual({ outcome: 'ok' });
  });
});
