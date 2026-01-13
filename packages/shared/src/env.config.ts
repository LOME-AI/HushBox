import { z } from 'zod';

/**
 * Section-based env config. Section name determines destination:
 * - worker: .dev.vars + wrangler.toml [vars] only (NOT .env.development)
 * - workerSecrets: .dev.vars + .env.development (prod via wrangler secret put)
 * - frontend: .env.development (prod values baked at build time)
 * - local: .env.development only (tooling, never goes to worker)
 *
 * Value patterns:
 * - 'literal'         - Use this exact string
 * - '$SECRET_NAME'    - Read from GitHub secret at runtime
 * - 'duplicate_x'     - Use same value as environment x (e.g., 'duplicate_development')
 * - (missing)         - Not set in this environment
 *
 * Usage:
 * - Run `pnpm generate:env` to generate .env.development, .dev.vars, and wrangler.toml [vars]
 * - Run `pnpm generate:env --mode=ciE2E` in CI to include secrets from process.env
 * - Production secrets are set via GitHub Secrets → wrangler secret put in CI
 */
export const envConfig = {
  // Worker vars - go to .dev.vars + wrangler.toml [vars] (NOT .env.development)
  worker: {
    NODE_ENV: {
      development: 'development',
      ciVitest: 'duplicate_development',
      ciE2E: 'duplicate_development',
      production: 'production',
    },
    BETTER_AUTH_URL: {
      development: 'http://localhost:8787',
      ciVitest: 'duplicate_development',
      ciE2E: 'duplicate_development',
      production: 'https://api.lome-chat.com',
    },
    FRONTEND_URL: {
      development: 'http://localhost:5173',
      ciVitest: 'duplicate_development',
      ciE2E: 'duplicate_development',
      production: 'https://lome-chat.com',
    },
    CI: {
      ciVitest: 'true',
      ciE2E: 'duplicate_ciVitest',
    },
    E2E: {
      ciE2E: 'true',
    },
  },

  // Worker secrets - go to .dev.vars + .env.development (prod via wrangler secret put)
  workerSecrets: {
    DATABASE_URL: {
      development: 'postgres://postgres:postgres@localhost:4444/lome_chat',
      ciVitest: 'duplicate_development',
      ciE2E: 'duplicate_development',
      production: '$DATABASE_URL',
    },
    BETTER_AUTH_SECRET: {
      development: 'dev-secret-minimum-32-characters-long',
      ciVitest: 'duplicate_development',
      ciE2E: 'duplicate_development',
      production: '$BETTER_AUTH_SECRET',
    },
    RESEND_API_KEY: {
      ciVitest: '$RESEND_API_KEY',
      ciE2E: 'duplicate_ciVitest',
      production: 'duplicate_ciVitest',
    },
    OPENROUTER_API_KEY: {
      ciVitest: '$OPENROUTER_API_KEY',
      production: 'duplicate_ciVitest',
      // NOT in ciE2E - E2E tests don't need OpenRouter
    },
    HELCIM_API_TOKEN: {
      ciE2E: '$HELCIM_API_TOKEN_SANDBOX',
      production: '$HELCIM_API_TOKEN_PRODUCTION',
      // NOT in ciVitest - unit tests don't need Helcim
    },
    HELCIM_WEBHOOK_VERIFIER: {
      ciE2E: '$HELCIM_WEBHOOK_VERIFIER_SANDBOX',
      production: '$HELCIM_WEBHOOK_VERIFIER_PRODUCTION',
    },
  },

  // Frontend vars - go to .env.development, prod values baked at build
  frontend: {
    VITE_API_URL: {
      development: 'http://localhost:8787',
      ciVitest: 'duplicate_development',
      ciE2E: 'duplicate_development',
      production: 'https://api.lome-chat.com',
    },
    VITE_HELCIM_JS_TOKEN: {
      ciE2E: '$VITE_HELCIM_JS_TOKEN_SANDBOX',
      production: '$VITE_HELCIM_JS_TOKEN_PRODUCTION',
    },
    VITE_CI: {
      ciVitest: 'true',
      ciE2E: 'duplicate_ciVitest',
    },
  },

  // Local tooling only - go to .env.development, never to worker
  local: {
    MIGRATION_DATABASE_URL: {
      development: 'postgresql://postgres:postgres@localhost:5432/lome_chat',
    },
  },
} as const;

/**
 * Environment-specific value configuration.
 *
 * Value patterns:
 * - 'literal'         - Use this exact string
 * - '$SECRET_NAME'    - Read from GitHub secret at runtime
 * - 'duplicate_x'     - Use same value as environment x (e.g., 'duplicate_development')
 * - (missing)         - Not set in this environment
 */
export type VarConfig = {
  /** Local development value */
  development?: string;
  /** CI unit/integration tests (Vitest) */
  ciVitest?: string;
  /** CI E2E tests (Playwright) */
  ciE2E?: string;
  /** Production deployment */
  production?: string;
};
type SectionConfig = Record<string, VarConfig>;

export type EnvConfig = typeof envConfig;

/**
 * Check if a var config is a CI/prod secret (no dev value).
 * These secrets must be provided from process.env in CI.
 */
export function isEmptySecret(config: VarConfig): boolean {
  return config.development === undefined;
}

/**
 * Check if a value is a secret reference (starts with $).
 * Example: '$HELCIM_API_TOKEN_SANDBOX' means "read from GitHub secret HELCIM_API_TOKEN_SANDBOX"
 */
export function isSecretRef(value: string): boolean {
  return value.startsWith('$');
}

/**
 * Check if a value is a duplicate reference (starts with 'duplicate_').
 * Example: 'duplicate_development' means "use the same value as development"
 */
export function isDuplicateRef(value: string): boolean {
  return value.startsWith('duplicate_');
}

/**
 * Extract the referenced environment key from a duplicate reference.
 * Example: 'duplicate_development' → 'development'
 */
export function getDuplicateKey(value: string): string {
  if (!isDuplicateRef(value)) {
    return value;
  }
  return value.replace('duplicate_', '');
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
