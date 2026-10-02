import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { ROUTES } from '@hushbox/shared';
import { TEST_DAY_START, TEST_YEAR_START } from '@hushbox/shared/test-time';
import { createMockEmailSender } from '../../slices/notifications/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { createAppWelcomeEmailPort, createWelcomeEmailAdapter } from './welcome-email.js';
import { createJobWakeCollector, grantJobWakes } from '../../lib/jobs/index.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { SafeLogFields } from '../../lib/telemetry/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';
import type { EmailSender } from '../../slices/notifications/index.js';

const FRONTEND_URL = 'https://app.example.test';

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
  return {
    send: () => errAsync(unavailableError('sender down')),
  };
}

describe('createWelcomeEmailAdapter', () => {
  function harness(
    sender: EmailSender,
    now: () => Date = () => new Date(TEST_DAY_START)
  ): {
    port: ReturnType<typeof createWelcomeEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createWelcomeEmailAdapter(() => {
      calls += 1;
      return { sender, frontendUrl: FRONTEND_URL, logger: telemetry, now };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends to the given address with the fixed welcome subject', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.to).toBe('new@example.com');
    expect(sender.getSentMessages()[0]?.subject).toBe('Welcome to HushBox');
  });

  it('greets by user name when one is provided', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendWelcomeEmail({ to: 'new@example.com', userName: 'Sam' });
    expect(sender.getSentMessages()[0]?.html).toContain('Hi Sam,');
  });

  it('carries the billing explainer in the plain-text body', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(sender.getSentMessages()[0]?.text).toContain('How billing works');
  });

  it('links the Billing page and Open HushBox to their routes on the frontend URL', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(hrefsOf(sender.getSentMessages()[0]?.html)).toEqual(
      new Set([
        new URL(ROUTES.BILLING, FRONTEND_URL).toString(),
        new URL(ROUTES.CHAT, FRONTEND_URL).toString(),
        'mailto:hello@hushbox.ai',
      ])
    );
  });

  it('stamps the copyright year from the resolver clock', async () => {
    for (const instant of [TEST_YEAR_START, NEXT_YEAR_START]) {
      const sender = createMockEmailSender();
      const { port } = harness(sender, () => new Date(instant));
      await port.sendWelcomeEmail({ to: 'new@example.com' });
      const year = String(new Date(instant).getUTCFullYear());
      expect(sender.getSentMessages()[0]?.text).toContain(`© ${year} `);
    }
  });

  it('logs the failure error code through the typed logger', async () => {
    const { port, warns } = harness(failingSender());
    await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(warns).toEqual([
      { msg: 'welcome email send failed', fields: { errorCode: 'unavailable' } },
    ]);
  });

  it('returns the send failure on the error channel', async () => {
    const { port } = harness(failingSender());
    const result = await port.sendWelcomeEmail({ to: 'new@example.com' });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendWelcomeEmail({ to: 'a@example.com' });
    await port.sendWelcomeEmail({ to: 'b@example.com' });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppWelcomeEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app welcome email port tests');
  }
  const db = grantJobWakes(
    createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
    createJobWakeCollector()
  );

  afterAll(async () => {
    await db.$client.end();
  });

  /**
   * Runs one send through an app that enters the ambient request scope, the
   * same shape the real composition root provides.
   */
  async function sendWithin(env: Bindings & { FRONTEND_URL?: string }): Promise<{
    outcome: 'ok' | 'err' | `threw: ${string}`;
  }> {
    const { telemetry } = recordingTelemetry();
    const app = new Hono<AppEnv>();
    app.use(requestScope());
    app.post('/send', async (c) => {
      bindRequestValue(c, 'db', db);
      bindRequestValue(c, 'logger', telemetry);
      const port = createAppWelcomeEmailPort();
      try {
        const result = await port.sendWelcomeEmail({ to: 'new@example.com' });
        return c.json({ outcome: result.isOk() ? 'ok' : 'err' });
        // eslint-disable-next-line catch-swallow/no-silent-catch -- the throw IS the outcome under test: it becomes the `threw:` response the assertions read
      } catch (error) {
        return c.json({ outcome: `threw: ${error instanceof Error ? error.message : '?'}` });
      }
    });
    const res = await app.request('/send', { method: 'POST' }, env);
    return await res.json();
  }

  it('sends through the env-selected sender inside a request context', async () => {
    const { outcome } = await sendWithin({ NODE_ENV: 'development', FRONTEND_URL });
    expect(outcome).toBe('ok');
  });

  it('fails fast when FRONTEND_URL is missing', async () => {
    const { outcome } = await sendWithin({ NODE_ENV: 'development' });
    expect(outcome).toMatch(/^threw: .*FRONTEND_URL/);
  });
});
