import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { TEST_DAY_START, TEST_YEAR_START } from '@hushbox/shared/test-time';
import { createMockEmailSender } from '../../slices/notifications/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import {
  createAppTwoFactorLockedEmailPort,
  createTwoFactorLockedEmailAdapter,
} from './two-factor-locked-email.js';
import { createJobWakeCollector, grantJobWakes } from '../../lib/jobs/index.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { SafeLogFields, Telemetry } from '../../lib/telemetry/index.js';
import type { EmailSender } from '../../slices/notifications/index.js';
import type { EmailSendDeps } from './send-email.js';

const NEXT_YEAR_START = Date.UTC(new Date(TEST_YEAR_START).getUTCFullYear() + 1, 0, 1);

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

describe('createTwoFactorLockedEmailAdapter', () => {
  function harness(
    sender: EmailSender,
    now: () => Date = () => new Date(TEST_DAY_START)
  ): {
    port: ReturnType<typeof createTwoFactorLockedEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createTwoFactorLockedEmailAdapter((): EmailSendDeps => {
      calls += 1;
      return { sender, logger: telemetry, now };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends the two-factor-locked copy with the pause in minutes', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendTwoFactorLockedEmail({
      to: 'victim@example.com',
      lockoutMinutes: 15,
    });
    expect(result.isOk()).toBe(true);
    const sent = sender.getSentMessages()[0];
    expect(sent?.to).toBe('victim@example.com');
    expect(sent?.subject).toBe('Your password was used, and the two-factor code was wrong');
    expect(sent?.html).toContain('15 minutes');
    expect(sent?.text).toContain('15 minutes');
  });

  it('states the pause it is given in the preview, the body and the plain text', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendTwoFactorLockedEmail({
      to: 'victim@example.com',
      lockoutMinutes: 30,
    });
    expect(result.isOk()).toBe(true);
    const sent = sender.getSentMessages()[0];
    expect(sent?.html).toContain(
      '>Too many wrong two-factor codes. Two-factor sign-in is paused for 30 minutes.</div>'
    );
    expect(sent?.html).toContain('Two-factor sign-in is paused for 30 minutes.</p>');
    expect(sent?.text).toContain('Two-factor sign-in is paused for 30 minutes.');
    expect(`${sent?.html ?? ''}${sent?.text ?? ''}`).not.toContain('15 minutes');
  });

  it('stamps the copyright year from the resolver clock', async () => {
    for (const instant of [TEST_YEAR_START, NEXT_YEAR_START]) {
      const sender = createMockEmailSender();
      const { port } = harness(sender, () => new Date(instant));
      const result = await port.sendTwoFactorLockedEmail({
        to: 'victim@example.com',
        lockoutMinutes: 15,
      });
      expect(result.isOk()).toBe(true);
      const year = String(new Date(instant).getUTCFullYear());
      expect(sender.getSentMessages()[0]?.text).toContain(`© ${year} `);
    }
  });

  it('greets by name when a userName is given', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendTwoFactorLockedEmail({
      to: 'victim@example.com',
      userName: 'Ada',
      lockoutMinutes: 15,
    });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.html).toContain('Ada');
  });

  it('logs the failure code and returns it on the error channel', async () => {
    const { port, warns } = harness(failingSender());
    const result = await port.sendTwoFactorLockedEmail({
      to: 'victim@example.com',
      lockoutMinutes: 15,
    });
    expect(warns).toEqual([
      { msg: 'two-factor-locked email send failed', fields: { errorCode: 'unavailable' } },
    ]);
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    const results = [
      await port.sendTwoFactorLockedEmail({ to: 'a@example.com', lockoutMinutes: 15 }),
      await port.sendTwoFactorLockedEmail({ to: 'b@example.com', lockoutMinutes: 15 }),
    ];
    expect(results.map((result) => result.isOk())).toEqual([true, true]);
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppTwoFactorLockedEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app two-factor-locked email port tests');
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
      const port = createAppTwoFactorLockedEmailPort();
      const result = await port.sendTwoFactorLockedEmail({
        to: 'victim@example.com',
        lockoutMinutes: 15,
      });
      return c.json({ outcome: result.isOk() ? 'ok' : 'err' });
    });
    const env: Bindings = { NODE_ENV: 'development' };
    const res = await app.request('/send', { method: 'POST' }, env);
    expect(await res.json()).toEqual({ outcome: 'ok' });
  });
});
