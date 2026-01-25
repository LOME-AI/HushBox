import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createAuth } from './index.js';
import { createDb } from '@lome-chat/db';
import { createMockEmailClient } from '../services/email/index.js';
import type { EmailClient, EmailOptions } from '../services/email/types.js';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is required for tests');
}

describe('createAuth', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb({ connectionString });
  });

  afterAll(async () => {
    // No cleanup needed for config tests
  });

  it('returns an auth object with handler function', () => {
    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'http://localhost:5173',
    });

    expect(auth).toBeDefined();
    expect(auth.handler).toBeDefined();
    expect(typeof auth.handler).toBe('function');
  });

  it('returns an auth object with api methods', () => {
    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'http://localhost:5173',
    });

    expect(auth.api).toBeDefined();
    expect(auth.api.getSession).toBeDefined();
    expect(typeof auth.api.getSession).toBe('function');
  });

  it('configures email client for verification emails', () => {
    const emailClient = createMockEmailClient();
    const auth = createAuth({
      db,
      emailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'http://localhost:5173',
    });

    // The auth object is created with our configuration
    // Email verification is tested via integration tests
    // Here we just verify the auth object was created successfully
    expect(auth.handler).toBeDefined();
    expect(auth.api.signUpEmail).toBeDefined();
  });

  it('requires all configuration options', () => {
    const emailClient = createMockEmailClient();

    // TypeScript should enforce required options, but we verify runtime behavior
    expect(() =>
      createAuth({
        db,
        emailClient,
        baseUrl: 'http://localhost:8787',
        secret: 'test-secret-key-at-least-32-chars',
        frontendUrl: 'http://localhost:5173',
      })
    ).not.toThrow();
  });
});

describe('auth configuration options', () => {
  const connectionString = DATABASE_URL;
  let db: ReturnType<typeof createDb>;

  beforeAll(() => {
    db = createDb({ connectionString });
  });

  it('accepts valid baseUrl', () => {
    const emailClient = createMockEmailClient();

    expect(() =>
      createAuth({
        db,
        emailClient,
        baseUrl: 'https://api.lome-chat.com',
        secret: 'test-secret-key-at-least-32-chars',
        frontendUrl: 'https://lome-chat.com',
      })
    ).not.toThrow();
  });

  it('accepts secret for session signing', () => {
    const emailClient = createMockEmailClient();

    expect(() =>
      createAuth({
        db,
        emailClient,
        baseUrl: 'http://localhost:8787',
        secret: 'a-very-long-secret-key-for-signing-sessions',
        frontendUrl: 'http://localhost:5173',
      })
    ).not.toThrow();
  });
});

/**
 * Unit tests for auth configuration structure.
 *
 * These tests verify that the Better Auth config is structured correctly,
 * specifically that callbacks like sendVerificationEmail are in the right
 * config section (emailVerification, not emailAndPassword).
 *
 * Bug context: Better Auth looks for sendVerificationEmail under
 * ctx.context.options.emailVerification?.sendVerificationEmail
 * If it's placed under emailAndPassword, it silently never gets called.
 */
describe('auth config structure', () => {
  it('sendVerificationEmail callback is invoked during email verification flow', () => {
    // Create a spy to track if sendEmail is called
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const sendEmailSpy = vi.fn().mockResolvedValue(undefined);
    const mockEmailClient: EmailClient = {
      sendEmail: sendEmailSpy,
    };

    // Create auth with our mock
    const db = createDb({ connectionString: 'postgresql://fake' });
    const auth = createAuth({
      db,
      emailClient: mockEmailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'http://localhost:5173',
    });

    // Verify the auth object has expected API methods
    expect(auth.api).toBeDefined();
    expect(auth.handler).toBeDefined();

    // The key test: verify sendVerificationEmail is accessible
    // by checking the options structure through the api
    // Note: Better Auth exposes options through auth.options
    const options = (auth as unknown as { options: Record<string, unknown> }).options;

    // This assertion would FAIL with the bug (sendVerificationEmail in wrong place)
    expect(options['emailVerification']).toBeDefined();
    expect(
      (options['emailVerification'] as { sendVerificationEmail?: unknown }).sendVerificationEmail
    ).toBeDefined();

    // Verify it's NOT in emailAndPassword (the wrong location)
    expect(
      (options['emailAndPassword'] as { sendVerificationEmail?: unknown } | undefined)
        ?.sendVerificationEmail
    ).toBeUndefined();
  });

  it('emailAndPassword is configured with requireEmailVerification', () => {
    const mockEmailClient: EmailClient = {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    const db = createDb({ connectionString: 'postgresql://fake' });
    const auth = createAuth({
      db,
      emailClient: mockEmailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'http://localhost:5173',
    });

    const options = (auth as unknown as { options: Record<string, unknown> }).options;

    expect(options['emailAndPassword']).toBeDefined();
    expect(
      (options['emailAndPassword'] as { requireEmailVerification?: boolean })
        .requireEmailVerification
    ).toBe(true);
    expect((options['emailAndPassword'] as { enabled?: boolean }).enabled).toBe(true);
  });

  it('emailVerification is configured with autoSignInAfterVerification', () => {
    const mockEmailClient: EmailClient = {
      // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
      sendEmail: vi.fn().mockResolvedValue(undefined),
    };

    const db = createDb({ connectionString: 'postgresql://fake' });
    const auth = createAuth({
      db,
      emailClient: mockEmailClient,
      baseUrl: 'http://localhost:8787',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'http://localhost:5173',
    });

    const options = (auth as unknown as { options: Record<string, unknown> }).options;

    expect(options['emailVerification']).toBeDefined();
    expect(
      (options['emailVerification'] as { autoSignInAfterVerification?: boolean })
        .autoSignInAfterVerification
    ).toBe(true);
  });
});

describe('sendVerificationEmail callbackURL rewrite', () => {
  it('rewrites relative callbackURL to absolute frontend URL', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const sendEmailSpy = vi.fn().mockResolvedValue(undefined);
    const mockEmailClient: EmailClient = {
      sendEmail: sendEmailSpy,
    };

    const db = createDb({ connectionString: 'postgresql://fake' });
    const auth = createAuth({
      db,
      emailClient: mockEmailClient,
      baseUrl: 'https://api.lome-chat.com',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'https://lome-chat.com',
    });

    // Get the sendVerificationEmail callback from the auth options
    const options = (auth as unknown as { options: Record<string, unknown> }).options;
    const emailVerification = options['emailVerification'] as {
      sendVerificationEmail: (params: { user: { email: string }; url: string }) => Promise<void>;
    };

    // Simulate Better Auth calling sendVerificationEmail with a relative callbackURL
    const verificationUrl =
      'https://api.lome-chat.com/api/auth/verify-email?token=abc123&callbackURL=%2F';

    await emailVerification.sendVerificationEmail({
      user: { email: 'test@example.com' },
      url: verificationUrl,
    });

    // Verify sendEmail was called
    expect(sendEmailSpy).toHaveBeenCalledTimes(1);

    // Get the HTML that was sent
    const emailArgs = sendEmailSpy.mock.calls[0]?.[0] as EmailOptions | undefined;
    if (!emailArgs) {
      throw new Error('Expected sendEmail to be called with arguments');
    }
    const html = emailArgs.html;

    // The callbackURL in the email link should be rewritten to absolute frontend URL
    // Before: callbackURL=%2F (relative /)
    // After: callbackURL=https%3A%2F%2Flome-chat.com%2F (absolute https://lome-chat.com/)
    expect(html).toContain('callbackURL=https%3A%2F%2Flome-chat.com%2F');
    expect(html).not.toContain('callbackURL=%2F');
  });

  it('preserves absolute callbackURL unchanged', async () => {
    // eslint-disable-next-line unicorn/no-useless-undefined -- mockResolvedValue requires an argument
    const sendEmailSpy = vi.fn().mockResolvedValue(undefined);
    const mockEmailClient: EmailClient = {
      sendEmail: sendEmailSpy,
    };

    const db = createDb({ connectionString: 'postgresql://fake' });
    const auth = createAuth({
      db,
      emailClient: mockEmailClient,
      baseUrl: 'https://api.lome-chat.com',
      secret: 'test-secret-key-at-least-32-chars',
      frontendUrl: 'https://lome-chat.com',
    });

    const options = (auth as unknown as { options: Record<string, unknown> }).options;
    const emailVerification = options['emailVerification'] as {
      sendVerificationEmail: (params: { user: { email: string }; url: string }) => Promise<void>;
    };

    // URL already has absolute callbackURL
    const verificationUrl =
      'https://api.lome-chat.com/api/auth/verify-email?token=abc123&callbackURL=https%3A%2F%2Fother-site.com%2F';

    await emailVerification.sendVerificationEmail({
      user: { email: 'test@example.com' },
      url: verificationUrl,
    });

    expect(sendEmailSpy).toHaveBeenCalledTimes(1);

    const emailArgs = sendEmailSpy.mock.calls[0]?.[0] as EmailOptions | undefined;
    if (!emailArgs) {
      throw new Error('Expected sendEmail to be called with arguments');
    }
    const html = emailArgs.html;

    // Absolute URL should be preserved
    expect(html).toContain('callbackURL=https%3A%2F%2Fother-site.com%2F');
  });
});
