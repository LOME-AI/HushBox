import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  MINUTE_MS,
  TEST_DAY_START,
  TEST_YEAR_START,
  freezeClock,
  setClock,
} from '@hushbox/shared/test-time';
import { createMockEmailSender, defineEmail } from '../../slices/notifications/index.js';
import { errAsync } from '../../lib/result/index.js';
import { unavailableError } from '../../lib/errors/index.js';
import { bindRequestValue, requestScope } from '../../lib/context/index.js';
import { renderAndSendEmail, resolveEmailSendDeps, sendComposedEmail } from './send-email.js';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { EmailSendDeps } from './send-email.js';
import type { EmailBody, EmailContent } from '../../slices/notifications/index.js';
import type { EmailSender } from '../../slices/notifications/index.js';
import type { Telemetry } from '../../lib/telemetry/index.js';

const CONTENT: EmailContent = { html: '<p>hi</p>', text: 'hi' };

function noopTelemetry(): Telemetry {
  const noop = (): void => undefined;
  return { debug: noop, info: noop, warn: noop, error: noop, captureError: noop };
}

describe('sendComposedEmail', () => {
  it('sends the composed content to the recipient with the given subject', async () => {
    const sender = createMockEmailSender();
    const result = await sendComposedEmail(
      { sender, logger: noopTelemetry() },
      { to: 'user@example.com', subject: 'Hello', content: CONTENT, logFailure: vi.fn() }
    );

    expect(result.isOk()).toBe(true);
    const sent = sender.getSentMessages()[0];
    expect(sent).toMatchObject({
      to: 'user@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
      text: 'hi',
    });
  });

  it('logs the failure error code and returns it on the error channel', async () => {
    const failingSender: EmailSender = { send: () => errAsync(unavailableError('sender down')) };
    const logFailure = vi.fn();

    const result = await sendComposedEmail(
      { sender: failingSender, logger: noopTelemetry() },
      { to: 'user@example.com', subject: 'Hello', content: CONTENT, logFailure }
    );

    expect(logFailure).toHaveBeenCalledWith(expect.anything(), 'unavailable');
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });
});

const sampleEmail = defineEmail({
  kind: 'standard',
  schema: z.object({ name: z.string() }),
  subject: (p) => `Hello ${p.name}`,
  preheader: () => 'A sample preview',
  body: (p): EmailBody => ({ blocks: [{ kind: 'paragraph', content: [`Hi ${p.name},`] }] }),
});

const NEXT_YEAR_START = Date.UTC(new Date(TEST_YEAR_START).getUTCFullYear() + 1, 0, 1);

describe('renderAndSendEmail', () => {
  function depsWith(sender: EmailSender, instant: number): EmailSendDeps {
    return { sender, logger: noopTelemetry(), now: () => new Date(instant) };
  }

  it('sends to the recipient with the subject the definition renders', async () => {
    const sender = createMockEmailSender();
    const result = await renderAndSendEmail(depsWith(sender, TEST_YEAR_START), {
      definition: sampleEmail,
      params: { name: 'Alice' },
      to: 'user@example.com',
      logFailure: vi.fn(),
    });

    expect(result.isOk()).toBe(true);
    expect(sender.getSentMessages()[0]).toMatchObject({
      to: 'user@example.com',
      subject: 'Hello Alice',
    });
  });

  it('renders both parts from the definition and its params', async () => {
    const sender = createMockEmailSender();
    const result = await renderAndSendEmail(depsWith(sender, TEST_YEAR_START), {
      definition: sampleEmail,
      params: { name: 'Alice' },
      to: 'user@example.com',
      logFailure: vi.fn(),
    });

    expect(result.isOk()).toBe(true);
    const sent = sender.getSentMessages()[0];
    expect(sent?.html).toContain('>Hi Alice,</p>');
    expect(sent?.text).toContain('Hi Alice,');
  });

  it('stamps the send date from the deps clock', async () => {
    for (const instant of [TEST_YEAR_START, NEXT_YEAR_START]) {
      const sender = createMockEmailSender();
      const result = await renderAndSendEmail(depsWith(sender, instant), {
        definition: sampleEmail,
        params: { name: 'Alice' },
        to: 'user@example.com',
        logFailure: vi.fn(),
      });
      expect(result.isOk()).toBe(true);
      const year = String(new Date(instant).getUTCFullYear());
      expect(sender.getSentMessages()[0]?.text).toContain(`© ${year} `);
    }
  });

  it('logs the failure error code and returns it on the error channel', async () => {
    const failingSender: EmailSender = { send: () => errAsync(unavailableError('sender down')) };
    const logFailure = vi.fn();

    const result = await renderAndSendEmail(depsWith(failingSender, TEST_YEAR_START), {
      definition: sampleEmail,
      params: { name: 'Alice' },
      to: 'user@example.com',
      logFailure,
    });

    expect(logFailure).toHaveBeenCalledWith(expect.anything(), 'unavailable');
    expect(result.isErr() && result.error.code).toBe('unavailable');
  });
});

describe('resolveEmailSendDeps', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Resolves the deps inside a request scope, as the composition root's ports do. */
  async function resolveWithin(read: (deps: EmailSendDeps) => number[]): Promise<number[]> {
    const app = new Hono<AppEnv>();
    app.use(requestScope());
    app.get('/resolve', (c) => {
      bindRequestValue(c, 'logger', noopTelemetry());
      return c.json(read(resolveEmailSendDeps()));
    });
    const env: Bindings = { NODE_ENV: 'development' };
    const res = await app.request('/resolve', {}, env);
    return await res.json();
  }

  it('returns a clock that reads the current time', async () => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    const readings = await resolveWithin((deps) => [deps.now().getTime()]);
    expect(readings).toEqual([TEST_DAY_START]);
  });

  it('reads the clock on every call rather than at resolution', async () => {
    freezeClock(TEST_DAY_START, { toFake: ['Date'] });
    const readings = await resolveWithin((deps) => {
      const first = deps.now().getTime();
      setClock(TEST_DAY_START + MINUTE_MS);
      return [first, deps.now().getTime()];
    });
    expect(readings).toEqual([TEST_DAY_START, TEST_DAY_START + MINUTE_MS]);
  });
});
