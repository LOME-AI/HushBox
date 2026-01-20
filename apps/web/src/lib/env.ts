import { createEnvUtils } from '@lome-chat/shared';

/**
 * Frontend environment utilities - initialized once with Vite's env.
 *
 * Usage:
 * ```typescript
 * import { env } from '@/lib/env';
 * if (env.isLocalDev) { // use mock }
 * ```
 */
const viteCI = import.meta.env['VITE_CI'] as string | undefined;
const viteE2E = import.meta.env['VITE_E2E'] as string | undefined;

export const env = createEnvUtils({
  NODE_ENV: import.meta.env.MODE,
  ...(viteCI ? { CI: viteCI } : {}),
  ...(viteE2E ? { E2E: viteE2E } : {}),
});
