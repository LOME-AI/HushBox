import { z } from 'zod';
import { ref, secret, Dest, Mode, type VarConfig } from './env-types.js';

// Re-export everything from env-types for convenience
export * from './env-types.js';

/**
 * Environment configuration with typed values.
 *
 * Each var has:
 * - `to`: Default destinations for this var
 * - Per-mode values: `Mode.Development`, `Mode.CiVitest`, `Mode.CiE2E`, `Mode.Production`
 *
 * Value types:
 * - `'literal'`                    - Use this exact string
 * - `ref(Mode.X)`                  - Use same value as another mode
 * - `secret('NAME')`               - Read from GitHub secret at runtime
 * - `{ value: ..., to: [...] }`    - Override destinations for this mode
 *
 * Destinations:
 * - `Dest.Backend`  → .dev.vars (local) / wrangler.toml + secrets (prod)
 * - `Dest.Frontend` → .env.development (Vite, VITE_* vars only)
 * - `Dest.Scripts`  → .env.scripts (migrations, seed, etc.)
 */
export const envConfig = {
  // Backend + Scripts in dev (seed.ts needs it), Backend only in CI/prod
  DATABASE_URL: {
    to: [Dest.Backend],
    [Mode.Development]: {
      value: 'postgres://postgres:postgres@localhost:4444/lome_chat',
      to: [Dest.Backend, Dest.Scripts],
    },
    [Mode.CiVitest]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.CiE2E]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.Production]: secret('DATABASE_URL'), // Backend only (uses default `to`)
  },

  // Backend only
  NODE_ENV: {
    to: [Dest.Backend],
    [Mode.Development]: 'development',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: 'production',
  },

  BETTER_AUTH_URL: {
    to: [Dest.Backend],
    [Mode.Development]: 'http://localhost:8787',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: 'https://api.lome-chat.com',
  },

  FRONTEND_URL: {
    to: [Dest.Backend],
    [Mode.Development]: 'http://localhost:5173',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: 'https://lome-chat.com',
  },

  CI: {
    to: [Dest.Backend],
    [Mode.CiVitest]: 'true',
    [Mode.CiE2E]: ref(Mode.CiVitest),
  },

  E2E: {
    to: [Dest.Backend],
    [Mode.CiE2E]: 'true',
  },

  BETTER_AUTH_SECRET: {
    to: [Dest.Backend],
    [Mode.Development]: 'dev-secret-minimum-32-characters-long',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: secret('BETTER_AUTH_SECRET'),
  },

  RESEND_API_KEY: {
    to: [Dest.Backend],
    [Mode.Production]: secret('RESEND_API_KEY'),
    // NOT in CI - email service uses console client when CI=true
  },

  OPENROUTER_API_KEY: {
    to: [Dest.Backend],
    [Mode.CiVitest]: secret('OPENROUTER_API_KEY'),
    [Mode.Production]: ref(Mode.CiVitest),
    // NOT in ciE2E - E2E tests don't need OpenRouter
  },

  HELCIM_API_TOKEN: {
    to: [Dest.Backend],
    [Mode.CiE2E]: secret('HELCIM_API_TOKEN_SANDBOX'),
    [Mode.Production]: secret('HELCIM_API_TOKEN_PRODUCTION'),
    // NOT in ciVitest - unit tests don't need Helcim
  },

  HELCIM_WEBHOOK_VERIFIER: {
    to: [Dest.Backend],
    [Mode.Development]: 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=', // Mock verifier for local webhook testing
    [Mode.CiE2E]: secret('HELCIM_WEBHOOK_VERIFIER_SANDBOX'),
    [Mode.Production]: secret('HELCIM_WEBHOOK_VERIFIER_PRODUCTION'),
  },

  // Frontend only
  VITE_API_URL: {
    to: [Dest.Frontend],
    [Mode.Development]: 'http://localhost:8787',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: 'https://api.lome-chat.com',
  },

  VITE_HELCIM_JS_TOKEN: {
    to: [Dest.Frontend],
    [Mode.CiE2E]: secret('VITE_HELCIM_JS_TOKEN_SANDBOX'),
    [Mode.Production]: secret('VITE_HELCIM_JS_TOKEN_PRODUCTION'),
  },

  VITE_CI: {
    to: [Dest.Frontend],
    [Mode.CiVitest]: 'true',
    [Mode.CiE2E]: ref(Mode.CiVitest),
  },

  VITE_E2E: {
    to: [Dest.Frontend],
    [Mode.CiE2E]: 'true',
  },

  // Scripts only
  MIGRATION_DATABASE_URL: {
    to: [Dest.Scripts],
    [Mode.Development]: 'postgresql://postgres:postgres@localhost:5432/lome_chat',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
  },
} as const satisfies Record<string, VarConfig>;

export type EnvConfig = typeof envConfig;
export type EnvKey = keyof EnvConfig;

// Zod schemas for validation
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  BETTER_AUTH_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  RESEND_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  HELCIM_API_TOKEN: z.string().optional(),
  HELCIM_WEBHOOK_VERIFIER: z.string().optional(),
});

export type BackendEnv = z.infer<typeof backendEnvSchema>;

export const frontendEnvSchema = z.object({
  VITE_API_URL: z.string().url(),
  VITE_HELCIM_JS_TOKEN: z.string().optional(),
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
