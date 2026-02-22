import { z } from 'zod';
import { ref, secret, Destination, Mode, type VariableConfig } from './env-types.js';

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
 * - `Destination.Backend`  → .dev.vars (local) / wrangler.toml + secrets (prod)
 * - `Destination.Frontend` → .env.development (Vite, VITE_* vars only)
 * - `Destination.Scripts`  → .env.scripts (migrations, seed, etc.)
 */
export const envConfig = {
  // Backend + Scripts in dev (seed.ts needs it), Backend only in CI/prod
  DATABASE_URL: {
    to: [Destination.Backend],
    [Mode.Development]: {
      value: 'postgres://postgres:postgres@localhost:4444/hushbox',
      to: [Destination.Backend, Destination.Scripts],
    },
    [Mode.CiVitest]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.CiE2E]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.Production]: secret('DATABASE_URL'), // Backend only (uses default `to`)
  },

  // Backend only
  NODE_ENV: {
    to: [Destination.Backend],
    [Mode.Development]: 'development',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: 'production',
  },

  API_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:8787',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: 'https://api.hushbox.ai',
  },

  FRONTEND_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:5173',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: 'https://hushbox.ai',
  },

  CI: {
    to: [Destination.Backend],
    [Mode.CiVitest]: 'true',
    [Mode.CiE2E]: ref(Mode.CiVitest),
  },

  E2E: {
    to: [Destination.Backend],
    [Mode.CiE2E]: 'true',
  },

  // Redis (Upstash in prod, SRH locally)
  UPSTASH_REDIS_REST_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:8079',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: secret('UPSTASH_REDIS_REST_URL'),
  },

  UPSTASH_REDIS_REST_TOKEN: {
    to: [Destination.Backend],
    [Mode.Development]: 'local_dev_token',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: secret('UPSTASH_REDIS_REST_TOKEN'),
  },

  // OPAQUE master secret (derives OPRF seed, AKE keypair, TOTP encryption key)
  OPAQUE_MASTER_SECRET: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-opaque-master-secret-32-bytes-minimum',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: secret('OPAQUE_MASTER_SECRET'),
  },

  // iron-session secret for encrypted cookies
  IRON_SESSION_SECRET: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-iron-session-secret-32-bytes-min',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: secret('IRON_SESSION_SECRET'),
  },

  RESEND_API_KEY: {
    to: [Destination.Backend],
    [Mode.Production]: secret('RESEND_API_KEY'),
    // NOT in CI - email service uses console client when CI=true
  },

  OPENROUTER_API_KEY: {
    to: [Destination.Backend],
    [Mode.CiVitest]: secret('OPENROUTER_API_KEY_RESTRICTED'),
    [Mode.Production]: secret('OPENROUTER_API_KEY_PRODUCTION'),
    // NOT in ciE2E - E2E tests don't need OpenRouter
  },

  HELCIM_API_TOKEN: {
    to: [Destination.Backend],
    [Mode.CiE2E]: secret('HELCIM_API_TOKEN_SANDBOX'),
    [Mode.Production]: secret('HELCIM_API_TOKEN_PRODUCTION'),
    // NOT in ciVitest - unit tests don't need Helcim
  },

  HELCIM_WEBHOOK_VERIFIER: {
    to: [Destination.Backend],
    [Mode.Development]: 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=', // Mock verifier for local webhook testing
    [Mode.CiE2E]: secret('HELCIM_WEBHOOK_VERIFIER_SANDBOX'),
    [Mode.Production]: secret('HELCIM_WEBHOOK_VERIFIER_PRODUCTION'),
  },

  // Frontend only
  VITE_API_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://localhost:8787',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
    [Mode.Production]: 'https://api.hushbox.ai',
  },

  VITE_HELCIM_JS_TOKEN: {
    to: [Destination.Frontend],
    [Mode.CiE2E]: secret('VITE_HELCIM_JS_TOKEN_SANDBOX'),
    [Mode.Production]: secret('VITE_HELCIM_JS_TOKEN_PRODUCTION'),
  },

  VITE_CI: {
    to: [Destination.Frontend],
    [Mode.CiVitest]: 'true',
    [Mode.CiE2E]: ref(Mode.CiVitest),
  },

  VITE_E2E: {
    to: [Destination.Frontend],
    [Mode.CiE2E]: 'true',
  },

  // Scripts only
  MIGRATION_DATABASE_URL: {
    to: [Destination.Scripts],
    [Mode.Development]: 'postgresql://postgres:postgres@localhost:5432/hushbox',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.Development),
  },
} as const satisfies Record<string, VariableConfig>;

export type EnvConfig = typeof envConfig;
export type EnvKey = keyof EnvConfig;

// Zod schemas for validation
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  API_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  DATABASE_URL: z.string().min(1),
  RESEND_API_KEY: z.string().optional(),
  OPENROUTER_API_KEY: z.string().optional(),
  HELCIM_API_TOKEN: z.string().optional(),
  HELCIM_WEBHOOK_VERIFIER: z.string().optional(),
  // Redis
  UPSTASH_REDIS_REST_URL: z.string().url(),
  UPSTASH_REDIS_REST_TOKEN: z.string().min(1),
  // Auth secrets
  OPAQUE_MASTER_SECRET: z.string().min(32),
  IRON_SESSION_SECRET: z.string().min(32),
});

export type BackendEnv = z.infer<typeof backendEnvSchema>;

export const frontendEnvSchema = z.object({
  VITE_API_URL: z.string().url(),
  VITE_HELCIM_JS_TOKEN: z.string().optional(),
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
