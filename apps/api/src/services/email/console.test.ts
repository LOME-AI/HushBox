import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { EmailOptions } from './types.js';
import { createConsoleEmailClient } from './console.js';

describe('createConsoleEmailClient', () => {
  const testEmail: EmailOptions = {
    to: 'user@example.com',
    subject: 'Test Subject',
    html: '<p>Test body</p>',
  };

  let consoleSpy: Mock<(message?: unknown, ...optionalParams: unknown[]) => void>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined) as Mock<
      (message?: unknown, ...optionalParams: unknown[]) => void
    >;
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('returns an EmailClient', () => {
    const client = createConsoleEmailClient();

    expect(typeof client.sendEmail === 'function').toBe(true);
  });

  it('logs email details to console', async () => {
    const client = createConsoleEmailClient();

    await client.sendEmail(testEmail);

    expect(consoleSpy).toHaveBeenCalled();
    const logOutput = (consoleSpy.mock.calls as unknown[][]).flat().join(' ');
    expect(logOutput).toContain('user@example.com');
    expect(logOutput).toContain('Test Subject');
  });

  it('logs the HTML content', async () => {
    const client = createConsoleEmailClient();

    await client.sendEmail(testEmail);

    const logOutput = (consoleSpy.mock.calls as unknown[][]).flat().join(' ');
    expect(logOutput).toContain('<p>Test body</p>');
  });
});
