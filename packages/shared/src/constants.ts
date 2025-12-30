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

/** LOME's fee rate on AI model usage (15%) */
export const LOME_FEE_RATE = 0.15;

/** Feature flags for conditional feature rendering */
interface FeatureFlags {
  /** Enable projects feature in sidebar. TODO: Enable when projects feature is ready */
  PROJECTS_ENABLED: boolean;
}

export const FEATURE_FLAGS: FeatureFlags = {
  PROJECTS_ENABLED: false,
};
