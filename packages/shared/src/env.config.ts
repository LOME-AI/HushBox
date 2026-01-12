import { z } from 'zod';

/**
 * Section-based env config. Section name determines destination:
 * - worker: .dev.vars + wrangler.toml [vars] only (NOT .env.development)
 * - workerSecrets: .dev.vars + .env.development (prod via wrangler secret put)
 * - frontend: .env.development (prod values baked at build time)
 * - local: .env.development only (tooling, never goes to worker)
 *
 * Value structure:
 * - { development: '...', production: '...' } = known values for both envs
 * - { development: '...' } = dev value only, no prod value needed
 * - {} = CI/prod secret (no dev value, read from process.env in CI, wrangler secret in prod)
 *
 * Usage:
 * - Run `pnpm generate:env` to generate .env.development, .dev.vars, and wrangler.toml [vars]
 * - Run `pnpm generate:env --mode=ci-e2e` in CI to include secrets from process.env
 * - Production secrets are set via GitHub Secrets → wrangler secret put in CI
 */
export const envConfig = {
  // Worker vars - go to .dev.vars + wrangler.toml [vars] (NOT .env.development)
  worker: {
    NODE_ENV: { development: 'development', production: 'production' },
    BETTER_AUTH_URL: {
      development: 'http://localhost:8787',
      production: 'https://api.lome-chat.com',
    },
    FRONTEND_URL: {
      development: 'http://localhost:5173',
      production: 'https://lome-chat.com',
    },
  },

  // Worker secrets - go to .dev.vars + .env.development (prod via wrangler secret put)
  workerSecrets: {
    DATABASE_URL: { development: 'postgres://postgres:postgres@localhost:4444/lome_chat' },
    BETTER_AUTH_SECRET: { development: 'dev-secret-minimum-32-characters-long' },
    // CI/prod secrets - no dev value, needed in CI (from process.env) and prod (via wrangler secret)
    RESEND_API_KEY: {},
    OPENROUTER_API_KEY: {},
    HELCIM_API_TOKEN: {},
    HELCIM_WEBHOOK_VERIFIER: {},
  },

  // Frontend vars - go to .env.development, prod values baked at build
  frontend: {
    VITE_API_URL: {
      development: 'http://localhost:8787',
      production: 'https://api.lome-chat.com',
    },
    // CI/prod secret - goes to .env.local in CI
    VITE_HELCIM_JS_TOKEN: {},
  },

  // Local tooling only - go to .env.development, never to worker
  local: {
    MIGRATION_DATABASE_URL: {
      development: 'postgresql://postgres:postgres@localhost:5432/lome_chat',
    },
  },
} as const;

// Type helpers for the section structure
export type VarConfig = { development?: string; production?: string };
type SectionConfig = Record<string, VarConfig>;

export type EnvConfig = typeof envConfig;

/**
 * Check if a var config is an empty CI/prod secret (no dev value).
 */
export function isEmptySecret(config: VarConfig): boolean {
  return Object.keys(config).length === 0;
}

/**
 * Get all keys from a section that have development values.
 */
export function getDevKeys(section: SectionConfig): string[] {
  return Object.entries(section)
    .filter(([, config]) => config.development !== undefined)
    .map(([key]) => key);
}

/**
 * Get all keys from a section that are CI/prod secrets (empty {}).
 */
export function getCiProdSecretKeys(section: SectionConfig): string[] {
  return Object.entries(section)
    .filter(([, config]) => isEmptySecret(config))
    .map(([key]) => key);
}

// Zod schemas for validation
export const workerEnvSchema = z.object({
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

export type WorkerEnv = z.infer<typeof workerEnvSchema>;

export const frontendEnvSchema = z.object({
  VITE_API_URL: z.string().url(),
  VITE_HELCIM_JS_TOKEN: z.string().optional(),
});

export type FrontendEnv = z.infer<typeof frontendEnvSchema>;

// Legacy exports for backward compatibility during migration
export const envSchema = workerEnvSchema.merge(frontendEnvSchema.pick({ VITE_API_URL: true }));
export type Env = z.infer<typeof envSchema>;
