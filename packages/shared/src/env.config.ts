import { z } from 'zod';

/**
 * Environment configuration - single source of truth for all environment variables.
 *
 * Usage:
 * - Run `pnpm generate:env` to generate .env.development, .dev.vars, and wrangler.toml [vars]
 * - Production secrets are set via GitHub Secrets → wrangler secret put in CI
 */
export const envConfig = {
  // Non-secret variables with values per environment
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

  // Secret variables (no production values in code!)
  secrets: {
    DATABASE_URL: {
      development: 'postgres://postgres:postgres@localhost:4444/lome_chat',
      production: null, // Set via GitHub Secrets → wrangler secret put
    },
    BETTER_AUTH_SECRET: {
      development: 'dev-secret-minimum-32-characters-long',
      production: null, // Set via GitHub Secrets → wrangler secret put
    },
  },

  // Production-only secrets - not written to .env.development or .dev.vars
  // Code handles missing values by using mocks/fallbacks in development
  // Set via GitHub Secrets → wrangler secret put in CI
  prodOnlySecrets: [
    'RESEND_API_KEY', // Empty = use console email client
    'OPENROUTER_API_KEY', // Empty = use mock OpenRouter client
  ],

  // Local-only variables (only in .env.development, not deployed to production)
  localOnly: {
    MIGRATION_DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/lome_chat',
  },

  // Frontend-exposed variables (VITE_ prefix)
  frontend: {
    VITE_API_URL: {
      development: 'http://localhost:8787',
      production: 'https://api.lome-chat.com',
    },
  },

  // Which vars the Worker needs (subset for .dev.vars)
  // Note: prodOnlySecrets are excluded - they're only available in production via wrangler secret
  workerVars: ['NODE_ENV', 'DATABASE_URL', 'BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'FRONTEND_URL'],
} as const;

// Zod schema for runtime validation
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_URL: z.string().url(),
  BETTER_AUTH_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  FRONTEND_URL: z.string().url(),
  VITE_API_URL: z.string().url(),
});

export type Env = z.infer<typeof envSchema>;

// Frontend-only schema (validates only VITE_* vars at runtime in browser)
export const frontendEnvSchema = envSchema.pick({
  VITE_API_URL: true,
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
