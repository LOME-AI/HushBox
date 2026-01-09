import { z } from 'zod';

/**
 * Environment configuration - single source of truth for all environment variables.
 *
 * Usage:
 * - Run `pnpm generate:env` to generate .env.development, .dev.vars, and wrangler.toml [vars]
 * - Production secrets are set via GitHub Secrets → wrangler secret put in CI
 */
export const envConfig = {
  vars: {
    NODE_ENV: {
      development: 'development',
      production: 'production',
    },
    BETTER_AUTH_URL: {
      development: 'http://localhost:8787',
      production: 'https://api.lome-chat.com',
    },
    FRONTEND_URL: {
      development: 'http://localhost:5173',
      production: 'https://lome-chat.com',
    },
  },

  secrets: {
    DATABASE_URL: {
      development: 'postgres://postgres:postgres@localhost:4444/lome_chat',
      production: null, // Set via GitHub Secrets → wrangler secret put
    },
    BETTER_AUTH_SECRET: {
      development: 'dev-secret-minimum-32-characters-long',
      production: null,
    },
  },

  prodOnlySecrets: [
    'RESEND_API_KEY',
    'OPENROUTER_API_KEY',
    'HELCIM_API_TOKEN',
    'HELCIM_WEBHOOK_VERIFIER',
  ],

  localOnly: {
    MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/lome_chat',
  },

  frontend: {
    VITE_API_URL: {
      development: 'http://localhost:8787',
      production: 'https://api.lome-chat.com',
    },
    VITE_HELCIM_JS_TOKEN: {
      development: 'dev-mock',
      production: 'SET_AT_BUILD',
    },
  },

  workerVars: ['NODE_ENV', 'DATABASE_URL', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'FRONTEND_URL'],
} as const;

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  HELCIM_API_TOKEN: z.string().optional(),
  HELCIM_WEBHOOK_VERIFIER: z.string().optional(),
  FRONTEND_URL: z.string().url(),
  VITE_API_URL: z.string().url(),
  VITE_HELCIM_JS_TOKEN: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

export const frontendEnvSchema = envSchema.pick({
  VITE_API_URL: true,
  VITE_HELCIM_JS_TOKEN: true,
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
