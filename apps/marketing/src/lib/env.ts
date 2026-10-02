import { createEnvUtilities } from '@hushbox/shared';

/**
 * Frontend environment utilities — initialized once with Vite's env, same
 * pattern as apps/web/src/lib/platform/env.ts and apps/admin/src/lib/env.ts.
 */
const viteCI = import.meta.env.VITE_CI;
const viteE2E = import.meta.env.VITE_E2E;

export const env = createEnvUtilities({
  NODE_ENV: import.meta.env.MODE,
  ...(viteCI ? { CI: viteCI } : {}),
  ...(viteE2E ? { E2E: viteE2E } : {}),
});
