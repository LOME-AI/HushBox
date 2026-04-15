import { z } from 'zod';
import { ref, secret, Destination, Mode, type VariableConfig } from './env-types.js';
import { VALID_PLATFORMS } from './platform.js';

// Re-export everything from env-types for convenience
export * from './env-types.js';

/**
 * Environment configuration with typed values.
 *
 * Each var has:
 * - `to`: Default destinations for this var
 * - Per-mode values: `Mode.Development`, `Mode.CiVitest`, `Mode.E2E`, `Mode.CiE2E`, `Mode.Production`
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
    [Mode.E2E]: ref(Mode.Development), // Backend only (uses default `to`)
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('DATABASE_URL'), // Backend only (uses default `to`)
  },

  // Backend only
  NODE_ENV: {
    to: [Destination.Backend],
    [Mode.Development]: 'development',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'production',
  },

  API_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:8787',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://api.hushbox.ai',
  },

  FRONTEND_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:5173',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://hushbox.ai',
  },

  FRONTEND_PREVIEW_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:4173',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  CI: {
    to: [Destination.Backend],
    [Mode.CiVitest]: 'true',
    [Mode.CiE2E]: 'true',
    // NOT in E2E — local e2e is not CI
  },

  E2E: {
    to: [Destination.Backend],
    [Mode.E2E]: 'true',
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // Redis (Upstash in prod, SRH locally)
  UPSTASH_REDIS_REST_URL: {
    to: [Destination.Backend],
    [Mode.Development]: 'http://localhost:8079',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('UPSTASH_REDIS_REST_URL'),
  },

  UPSTASH_REDIS_REST_TOKEN: {
    to: [Destination.Backend],
    [Mode.Development]: 'local_dev_token',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('UPSTASH_REDIS_REST_TOKEN'),
  },

  // OPAQUE master secret (derives OPRF seed, AKE keypair, TOTP encryption key)
  OPAQUE_MASTER_SECRET: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-opaque-master-secret-32-bytes-minimum',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('OPAQUE_MASTER_SECRET'),
  },

  // iron-session secret for encrypted cookies
  IRON_SESSION_SECRET: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-iron-session-secret-32-bytes-min',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('IRON_SESSION_SECRET'),
  },

  APP_VERSION: {
    to: [Destination.Backend],
    [Mode.Development]: 'dev-local',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('APP_VERSION'),
  },

  RESEND_API_KEY: {
    to: [Destination.Backend],
    [Mode.Production]: secret('RESEND_API_KEY'),
    // NOT in CI - email service uses console client when CI=true
  },

  FCM_PROJECT_ID: {
    to: [Destination.Backend],
    [Mode.Production]: secret('FCM_PROJECT_ID'),
    // NOT in dev/CI - push service uses console client
  },

  FCM_SERVICE_ACCOUNT_JSON: {
    to: [Destination.Backend],
    [Mode.Production]: secret('FCM_SERVICE_ACCOUNT_JSON'),
    // NOT in dev/CI - push service uses console client
  },

  GOOGLE_SERVICES_JSON_BASE64: {
    to: [Destination.Scripts],
    [Mode.Development]:
      'ewogICJwcm9qZWN0X2luZm8iOiB7CiAgICAicHJvamVjdF9udW1iZXIiOiAiMTAwNjQwMjYyNjAzOSIsCiAgICAicHJvamVjdF9pZCI6ICJodXNoYm94LWxvY2FsZGV2IiwKICAgICJzdG9yYWdlX2J1Y2tldCI6ICJodXNoYm94LWxvY2FsZGV2LmZpcmViYXNlc3RvcmFnZS5hcHAiCiAgfSwKICAiY2xpZW50IjogWwogICAgewogICAgICAiY2xpZW50X2luZm8iOiB7CiAgICAgICAgIm1vYmlsZXNka19hcHBfaWQiOiAiMToxMDA2NDAyNjI2MDM5OmFuZHJvaWQ6MjQ1MTRiMmRlMDEyY2MxNWEwY2VmMiIsCiAgICAgICAgImFuZHJvaWRfY2xpZW50X2luZm8iOiB7CiAgICAgICAgICAicGFja2FnZV9uYW1lIjogImFpLmh1c2hib3guYXBwIgogICAgICAgIH0KICAgICAgfSwKICAgICAgIm9hdXRoX2NsaWVudCI6IFtdLAogICAgICAiYXBpX2tleSI6IFsKICAgICAgICB7CiAgICAgICAgICAiY3VycmVudF9rZXkiOiAiQUl6YVN5QzlobVR2Rm95V05GZ0VYdDV3dW51TTlaSkRvSFdsYkVrIgogICAgICAgIH0KICAgICAgXSwKICAgICAgInNlcnZpY2VzIjogewogICAgICAgICJhcHBpbnZpdGVfc2VydmljZSI6IHsKICAgICAgICAgICJvdGhlcl9wbGF0Zm9ybV9vYXV0aF9jbGllbnQiOiBbXQogICAgICAgIH0KICAgICAgfQogICAgfQogIF0sCiAgImNvbmZpZ3VyYXRpb25fdmVyc2lvbiI6ICIxIgp9',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: secret('GOOGLE_SERVICES_JSON_BASE64'),
  },

  HELCIM_API_TOKEN: {
    to: [Destination.Backend],
    [Mode.CiE2E]: secret('HELCIM_API_TOKEN_SANDBOX'),
    [Mode.Production]: secret('HELCIM_API_TOKEN_PRODUCTION'),
    // NOT in ciVitest or e2e - only CI e2e and production need real Helcim
  },

  HELCIM_WEBHOOK_VERIFIER: {
    to: [Destination.Backend],
    [Mode.Development]: 'bW9jay13ZWJob29rLXZlcmlmaWVyLXNlY3JldC0zMmI=', // Mock verifier for local webhook testing
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: secret('HELCIM_WEBHOOK_VERIFIER_SANDBOX'),
    [Mode.Production]: secret('HELCIM_WEBHOOK_VERIFIER_PRODUCTION'),
  },

  // Frontend only
  VITE_API_URL: {
    to: [Destination.Frontend],
    [Mode.Development]: 'http://localhost:8787',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'https://api.hushbox.ai',
  },

  VITE_HELCIM_JS_TOKEN: {
    to: [Destination.Frontend],
    [Mode.CiE2E]: secret('VITE_HELCIM_JS_TOKEN_SANDBOX'),
    [Mode.Production]: secret('VITE_HELCIM_JS_TOKEN_PRODUCTION'),
    // NOT in e2e - only CI e2e and production need real Helcim
  },


  VITE_PLATFORM: {
    to: [Destination.Frontend],
    [Mode.Development]: 'web',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'web', // Mobile builds override via CI env
  },

  VITE_APP_VERSION: {
    to: [Destination.Frontend],
    [Mode.Development]: 'dev-local',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
    [Mode.Production]: 'set-by-ci', // All BUILD_VARIANTS override this; literal documents intent
  },

  VITE_CI: {
    to: [Destination.Frontend],
    [Mode.CiVitest]: 'true',
    [Mode.CiE2E]: 'true',
    // NOT in E2E — local e2e is not CI
  },

  VITE_E2E: {
    to: [Destination.Frontend],
    [Mode.E2E]: 'true',
    [Mode.CiE2E]: ref(Mode.E2E),
  },

  // Scripts only
  MIGRATION_DATABASE_URL: {
    to: [Destination.Scripts],
    [Mode.Development]: 'postgresql://postgres:postgres@localhost:5432/hushbox',
    [Mode.CiVitest]: ref(Mode.Development),
    [Mode.E2E]: ref(Mode.Development),
    [Mode.CiE2E]: ref(Mode.E2E),
  },
} as const satisfies Record<string, VariableConfig>;

export type EnvConfig = typeof envConfig;
export type EnvKey = keyof EnvConfig;

// Zod schemas for validation
export const backendEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']),
  API_URL: z.string().url(),
  FRONTEND_URL: z.string().url(),
  FRONTEND_PREVIEW_URL: z.string().url().optional(),
  DATABASE_URL: z.string().min(1),
  APP_VERSION: z.string().min(1),
  RESEND_API_KEY: z.string().optional(),
  HELCIM_API_TOKEN: z.string().optional(),
  HELCIM_WEBHOOK_VERIFIER: z.string().optional(),
  FCM_PROJECT_ID: z.string().optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
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
  VITE_PLATFORM: z.enum(VALID_PLATFORMS).default('web'),
  VITE_APP_VERSION: z.string().min(1).default('dev-local'),
  VITE_HELCIM_JS_TOKEN: z.string().optional(),
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;
