import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { EmailOptions } from './types.js';
import { createConsoleEmailClient } from './console.js';
import * as childProcess from 'child_process';

// Mock child_process.exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

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
    vi.mocked(childProcess.exec).mockClear();
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

  it('auto-opens verification links in browser', async () => {
    const client = createConsoleEmailClient();
    const verificationEmail: EmailOptions = {
      to: 'user@example.com',
      subject: 'Verify your email',
      html: '<a href="http://localhost:8787/api/auth/verify-email?token=abc123">Verify</a>',
    };

    await client.sendEmail(verificationEmail);

    expect(childProcess.exec).toHaveBeenCalledTimes(1);
    const execCall = vi.mocked(childProcess.exec).mock.calls[0]?.[0];
    expect(execCall).toContain('http://localhost:8787/api/auth/verify-email?token=abc123');
  });

  it('does not auto-open for non-verification emails', async () => {
    const client = createConsoleEmailClient();

    await client.sendEmail(testEmail);

    expect(childProcess.exec).not.toHaveBeenCalled();
  });
});
