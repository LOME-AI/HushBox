import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { TEST_DAY_START, TEST_YEAR_START } from '@hushbox/shared/test-time';
import { createMockEmailSender } from '../../slices/notifications/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import {
  createChargebackLockEmailAdapter,
  createAppChargebackLockEmailPort,
} from './chargeback-lock-email.js';
import { createJobWakeCollector, grantJobWakes } from '../../lib/jobs/index.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { SafeLogFields } from '../../lib/telemetry/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';
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
  return {
    send: () => errAsync(unavailableError('sender down')),
  };
}

describe('createChargebackLockEmailAdapter', () => {
  function harness(
    sender: EmailSender,
    now: () => Date = () => new Date(TEST_DAY_START)
  ): {
    port: ReturnType<typeof createChargebackLockEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createChargebackLockEmailAdapter((): EmailSendDeps => {
      calls += 1;
      return { sender, logger: telemetry, now };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends to the given address', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.to).toBe('member@hushbox.ai');
  });

  it('uses the chargeback-lock subject', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
    expect(sender.getSentMessages()[0]?.subject).toBe('Your account was locked');
  });

  it('stamps the copyright year from the resolver clock', async () => {
    for (const instant of [TEST_YEAR_START, NEXT_YEAR_START]) {
      const sender = createMockEmailSender();
      const { port } = harness(sender, () => new Date(instant));
      await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
      const year = String(new Date(instant).getUTCFullYear());
      expect(sender.getSentMessages()[0]?.text).toContain(`© ${year} `);
    }
  });

  it('carries the lock notice in both bodies', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
    expect(sender.getSentMessages()[0]?.html).toContain('locked');
    expect(sender.getSentMessages()[0]?.text).toContain('locked');
  });

  it('sends the chargeback-lock copy, not the sign-in-lockout copy', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
    const sent = sender.getSentMessages()[0];
    expect(sent?.html).toContain('dispute');
    expect(sent?.html).toContain('>Email the billing team</a>');
    expect(sent?.text).not.toContain('minutes');
  });

  it('greets the recipient by name', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendChargebackLockEmail({ to: 'member@hushbox.ai', userName: 'Alice' });
    expect(sender.getSentMessages()[0]?.html).toContain('>Hi Alice,</p>');
    expect(sender.getSentMessages()[0]?.text).toContain('Hi Alice,');
  });

  it('greets without a name when none is given', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
    expect(sender.getSentMessages()[0]?.html).toContain('>Hi,</p>');
  });

  it('logs the failure error code through the typed logger', async () => {
    const { port, warns } = harness(failingSender());
    await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
    expect(warns).toEqual([
      { msg: 'chargeback-lock email send failed', fields: { errorCode: 'unavailable' } },
    ]);
  });

  it('returns the send failure on the error channel', async () => {
    const { port } = harness(failingSender());
    const result = await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendChargebackLockEmail({ to: 'a@hushbox.ai' });
    await port.sendChargebackLockEmail({ to: 'b@hushbox.ai' });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppChargebackLockEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app chargeback-lock email port tests');
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
      const port = createAppChargebackLockEmailPort();
      const result = await port.sendChargebackLockEmail({ to: 'member@hushbox.ai' });
      return c.json({ outcome: result.isOk() ? 'ok' : 'err' });
    });
    const env: Bindings = { NODE_ENV: 'development' };
    const res = await app.request('/send', { method: 'POST' }, env);
    expect(await res.json()).toEqual({ outcome: 'ok' });
  });
});
