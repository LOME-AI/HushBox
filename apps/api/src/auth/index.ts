import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import * as schema from '@lome-chat/db';
import type { Database } from '@lome-chat/db';
import type { EmailClient } from '../services/email/index.js';
import { verificationEmail } from '../services/email/templates/index.js';

export interface AuthConfig {
  db: Database;
  emailClient: EmailClient;
  baseUrl: string;
  secret: string;
  frontendUrl: string;
}

export function createAuth(config: AuthConfig): ReturnType<typeof betterAuth> {
  return betterAuth({
    baseURL: config.baseUrl,
    secret: config.secret,
    trustedOrigins: [config.frontendUrl],
    database: drizzleAdapter(config.db, {
      provider: 'pg',
      transaction: true,
      schema: {
        user: schema.users,
        session: schema.sessions,
        account: schema.accounts,
        verification: schema.verifications,
      },
    }),
    emailVerification: {
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({
        user,
        url,
      }: {
        user: { email: string; name?: string };
        url: string;
      }) => {
        // Rewrite relative callbackURL to absolute frontend URL
        // Better Auth uses baseURL for redirects, but we need to redirect to the frontend
        const verifyUrl = new URL(url);
        const callbackUrl = verifyUrl.searchParams.get('callbackURL');
        if (callbackUrl && !callbackUrl.startsWith('http')) {
          verifyUrl.searchParams.set('callbackURL', config.frontendUrl + callbackUrl);
        }

        const emailContent = verificationEmail({
          userName: user.name,
          verificationUrl: verifyUrl.toString(),
        });

        await config.emailClient.sendEmail({
          to: user.email,
          subject: 'Verify your email address',
          html: emailContent.html,
          text: emailContent.text,
        });
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
    },
    advanced: {
      crossSubDomainCookies: {
        enabled: true,
        domain: '.lome-chat.com',
      },
      defaultCookieAttributes: {
        sameSite: 'none',
        secure: true,
      },
    },
  });
}
