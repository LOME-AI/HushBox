import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { ROUTES } from '@hushbox/shared';
import { TEST_DAY_START, TEST_YEAR_START } from '@hushbox/shared/test-time';
import { createMockEmailSender } from '../../slices/notifications/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import {
  createAppVerificationEmailPort,
  createVerificationEmailAdapter,
} from './verification-email.js';
import { createJobWakeCollector, grantJobWakes } from '../../lib/jobs/index.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { SafeLogFields } from '../../lib/telemetry/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';
import type { EmailSender } from '../../slices/notifications/index.js';

const FRONTEND_URL = 'http://localhost:5173';

const NEXT_YEAR_START = Date.UTC(new Date(TEST_YEAR_START).getUTCFullYear() + 1, 0, 1);

/** A link lifetime for sends whose test does not turn on it. */
const EXPIRES_IN_HOURS = 24;

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

describe('createVerificationEmailAdapter', () => {
  function harness(
    sender: EmailSender,
    now: () => Date = () => new Date(TEST_DAY_START)
  ): {
    port: ReturnType<typeof createVerificationEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createVerificationEmailAdapter(() => {
      calls += 1;
      return { sender, frontendUrl: FRONTEND_URL, logger: telemetry, now };
    });
    return { port, warns, resolveCount: () => calls };
  }

  it('sends to the given address', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-1',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.to).toBe('user@example.com');
  });

  it('builds the verification link from the frontend URL and token', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-abc',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    expect(sender.getSentMessages()[0]?.html).toContain(
      'http://localhost:5173/verify?token=tok-abc'
    );
  });

  it('carries the link in the plain-text body', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-abc',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    expect(sender.getSentMessages()[0]?.text).toContain(
      'http://localhost:5173/verify?token=tok-abc'
    );
  });

  it('uses the fixed verification subject', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-1',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    expect(sender.getSentMessages()[0]?.subject).toBe('Verify your email address');
  });

  it('builds the link on the verify route of the frontend URL, carrying the token as given', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-abc',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    const expected = new URL(ROUTES.VERIFY, FRONTEND_URL);
    expected.searchParams.set('token', 'tok-abc');
    expect(hrefsOf(sender.getSentMessages()[0]?.html)).toEqual(
      new Set([expected.toString(), 'mailto:hello@hushbox.ai'])
    );
  });

  it('states the link lifetime it is given, in the preview, the body and the plain text', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-1',
      expiresInHours: 48,
    });
    const sent = sender.getSentMessages()[0];
    expect(sent?.html).toContain('The link expires in 48 hours.</div>');
    expect(sent?.html).toContain('>This link expires in 48 hours.</p>');
    expect(sent?.text).toContain('This link expires in 48 hours.');
    expect(`${sent?.html ?? ''}${sent?.text ?? ''}`).not.toContain('24 hours');
  });

  it('stamps the copyright year from the resolver clock', async () => {
    for (const instant of [TEST_YEAR_START, NEXT_YEAR_START]) {
      const sender = createMockEmailSender();
      const { port } = harness(sender, () => new Date(instant));
      await port.sendVerificationEmail({
        to: 'user@example.com',
        token: 'tok-1',
        expiresInHours: EXPIRES_IN_HOURS,
      });
      const year = String(new Date(instant).getUTCFullYear());
      expect(sender.getSentMessages()[0]?.text).toContain(`© ${year} `);
    }
  });

  it('greets by user name when one is provided', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-1',
      userName: 'Sam',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    expect(sender.getSentMessages()[0]?.html).toContain('Hi Sam,');
  });

  it('logs the failure error code through the typed logger', async () => {
    const { port, warns } = harness(failingSender());
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-1',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    expect(warns).toEqual([
      { msg: 'verification email send failed', fields: { errorCode: 'unavailable' } },
    ]);
  });

  it('returns the send failure on the error channel', async () => {
    const { port } = harness(failingSender());
    const result = await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-1',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-1',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    await port.sendVerificationEmail({
      to: 'user@example.com',
      token: 'tok-2',
      expiresInHours: EXPIRES_IN_HOURS,
    });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppVerificationEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app verification-email port tests');
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
   * same shape the real composition root provides (the adapter reads
   * env/db/logger from the current request's scope, holding no context).
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
      const port = createAppVerificationEmailPort();
      try {
        const result = await port.sendVerificationEmail({
          to: 'user@example.com',
          token: 'tok-app',
          expiresInHours: EXPIRES_IN_HOURS,
        });
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
    const { outcome } = await sendWithin({
      NODE_ENV: 'development',
      FRONTEND_URL: 'http://localhost:5173',
    });
    expect(outcome).toBe('ok');
  });

  it('fails fast when FRONTEND_URL is missing', async () => {
    const { outcome } = await sendWithin({ NODE_ENV: 'development' });
    expect(outcome).toMatch(/^threw: .*FRONTEND_URL/);
  });

  it('fails fast when FRONTEND_URL is blank', async () => {
    const { outcome } = await sendWithin({ NODE_ENV: 'development', FRONTEND_URL: '' });
    expect(outcome).toMatch(/^threw: .*FRONTEND_URL/);
  });
});
