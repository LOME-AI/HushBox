import { Hono } from 'hono';
import { afterAll, describe, expect, it } from 'vitest';
import { LOCAL_NEON_DEV_CONFIG, createDb } from '@hushbox/db';
import { TEST_DAY_START, TEST_YEAR_START } from '@hushbox/shared/test-time';
import { createMockEmailSender } from '../../slices/notifications/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import {
  createAppNewsletterConfirmEmailPort,
  createNewsletterConfirmEmailAdapter,
} from './newsletter-confirmation-email.js';
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

describe('createNewsletterConfirmEmailAdapter', () => {
  function harness(
    sender: EmailSender,
    now: () => Date = () => new Date(TEST_DAY_START)
  ): {
    port: ReturnType<typeof createNewsletterConfirmEmailAdapter>;
    warns: RecordedWarn[];
    resolveCount: () => number;
  } {
    const { telemetry, warns } = recordingTelemetry();
    let calls = 0;
    const port = createNewsletterConfirmEmailAdapter(
      (): EmailSendDeps & { readonly marketingUrl: string } => {
        calls += 1;
        return { sender, marketingUrl: 'http://localhost:4321', logger: telemetry, now };
      }
    );
    return { port, warns, resolveCount: () => calls };
  }

  it('sends to the given address', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    const result = await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-1' });
    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]?.to).toBe('reader@example.com');
  });

  it('builds the confirm link from the marketing URL, the confirmed page, and token', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-abc' });
    expect(sender.getSentMessages()[0]?.html).toContain(
      'http://localhost:4321/newsletter/confirmed?token=tok-abc'
    );
  });

  it('carries the link in the plain-text body', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-abc' });
    expect(sender.getSentMessages()[0]?.text).toContain(
      'http://localhost:4321/newsletter/confirmed?token=tok-abc'
    );
  });

  it('uses the fixed confirmation subject', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-1' });
    expect(sender.getSentMessages()[0]?.subject).toBe('Confirm your subscription');
  });

  it('stamps the copyright year from the resolver clock', async () => {
    for (const instant of [TEST_YEAR_START, NEXT_YEAR_START]) {
      const sender = createMockEmailSender();
      const { port } = harness(sender, () => new Date(instant));
      await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-1' });
      const year = String(new Date(instant).getUTCFullYear());
      expect(sender.getSentMessages()[0]?.text).toContain(`© ${year} `);
    }
  });

  it('links the action and its paste line to the confirmed page', async () => {
    const sender = createMockEmailSender();
    const { port } = harness(sender);
    await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-abc' });
    const html = sender.getSentMessages()[0]?.html ?? '';
    const confirmHrefs = [...html.matchAll(/href="([^"]*)"/g)]
      .map((match) => match[1])
      .filter((href) => href !== 'mailto:hello@hushbox.ai');
    expect(confirmHrefs).toEqual([
      'http://localhost:4321/newsletter/confirmed?token=tok-abc',
      'http://localhost:4321/newsletter/confirmed?token=tok-abc',
    ]);
  });

  it('logs the failure error code through the typed logger', async () => {
    const { port, warns } = harness(failingSender());
    await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-1' });
    expect(warns).toEqual([
      { msg: 'newsletter confirmation email send failed', fields: { errorCode: 'unavailable' } },
    ]);
  });

  it('returns the send failure on the error channel', async () => {
    const { port } = harness(failingSender());
    const result = await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-1' });
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });

  it('resolves its dependencies freshly on every send', async () => {
    const { port, resolveCount } = harness(createMockEmailSender());
    await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-1' });
    await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-2' });
    expect(resolveCount()).toBe(2);
  });
});

describe('createAppNewsletterConfirmEmailPort', () => {
  const DATABASE_URL = process.env['DATABASE_URL'];
  if (DATABASE_URL === undefined || DATABASE_URL === '') {
    throw new Error('DATABASE_URL is required for the app newsletter-email port tests');
  }
  const db = grantJobWakes(
    createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG }),
    createJobWakeCollector()
  );

  afterAll(async () => {
    await db.$client.end();
  });

  async function sendWithin(env: Bindings & { MARKETING_URL?: string }): Promise<{
    outcome: 'ok' | 'err' | `threw: ${string}`;
  }> {
    const { telemetry } = recordingTelemetry();
    const app = new Hono<AppEnv>();
    app.use(requestScope());
    app.post('/send', async (c) => {
      bindRequestValue(c, 'db', db);
      bindRequestValue(c, 'logger', telemetry);
      const port = createAppNewsletterConfirmEmailPort();
      try {
        const result = await port.sendConfirmation({ to: 'reader@example.com', token: 'tok-app' });
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
      MARKETING_URL: 'http://localhost:4321',
    });
    expect(outcome).toBe('ok');
  });

  it('fails fast when MARKETING_URL is missing', async () => {
    const { outcome } = await sendWithin({ NODE_ENV: 'development' });
    expect(outcome).toMatch(/^threw: .*MARKETING_URL/);
  });
});
