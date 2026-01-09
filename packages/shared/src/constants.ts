export const MESSAGE_ROLES = ['user', 'assistant', 'system'] as const;
export type MessageRole = (typeof MESSAGE_ROLES)[number];

/** Shared password for all dev personas. Only for local development. */
export const DEV_PASSWORD = 'password123';

/** Email domain for development personas */
export const DEV_EMAIL_DOMAIN = 'dev.lome-chat.com';

/** Email domain for test personas (used by E2E tests) */
export const TEST_EMAIL_DOMAIN = 'test.lome-chat.com';

/** Model ID for the "Strongest" quick-select button */
export const STRONGEST_MODEL_ID = 'anthropic/claude-opus-4.5';

/** Model ID for the "Value" quick-select button */
export const VALUE_MODEL_ID = 'deepseek/deepseek-r1';

/** LOME's profit margin on AI model usage (5%) */
export const LOME_FEE_RATE = 0.05;

/** Credit card processing fee (4.5%) */
export const CREDIT_CARD_FEE_RATE = 0.045;

/** AI provider overhead fee (5.5%) */
export const PROVIDER_FEE_RATE = 0.055;

/**
 * Total combined fee rate applied to all model usage.
 * SINGLE SOURCE OF TRUTH for fee calculations.
 * = LOME_FEE_RATE + CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE
 * = 0.05 + 0.045 + 0.055 = 0.15 (15%)
 */
export const TOTAL_FEE_RATE = LOME_FEE_RATE + CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE;

/** Characters that fit in one kilobyte */
export const CHARACTERS_PER_KILOBYTE = 1000;

/** Kilobytes in one gigabyte */
export const KILOBYTES_PER_GIGABYTE = 1000000;

/** Monthly cost to store one gigabyte in USD */
export const MONTHLY_COST_PER_GB = 0.5;

/** Months in a year */
export const MONTHS_PER_YEAR = 12;

/** Number of years to retain storage */
export const STORAGE_YEARS = 50;

/**
 * Cost per character for storage in USD.
 * Derived: (MONTHLY_COST_PER_GB * MONTHS_PER_YEAR * STORAGE_YEARS) / (CHARACTERS_PER_KILOBYTE * KILOBYTES_PER_GIGABYTE)
 * = ($0.5 * 12 * 50) / (1000 * 1000000) = $300 / 1,000,000,000 = $0.0000003
 */
export const STORAGE_COST_PER_CHARACTER =
  (MONTHLY_COST_PER_GB * MONTHS_PER_YEAR * STORAGE_YEARS) /
  (CHARACTERS_PER_KILOBYTE * KILOBYTES_PER_GIGABYTE);

/**
 * Cost per 1000 characters for storage in USD.
 * Derived: STORAGE_COST_PER_CHARACTER * 1000 = $0.0003
 */
export const STORAGE_COST_PER_1K_CHARS = STORAGE_COST_PER_CHARACTER * 1000;

/** Feature flags for conditional feature rendering */
interface FeatureFlags {
  /** Enable projects feature in sidebar. TODO: Enable when projects feature is ready */
  PROJECTS_ENABLED: boolean;
  /** Enable settings feature in user menu. TODO: Enable when settings feature is ready */
  SETTINGS_ENABLED: boolean;
}

export const FEATURE_FLAGS: FeatureFlags = {
  PROJECTS_ENABLED: false,
  SETTINGS_ENABLED: false,
};
