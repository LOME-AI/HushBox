import { z } from 'zod';

import { VALID_PLATFORMS } from '../platform/platform.ts';

/**
 * The frontend half of the env contract, deliberately a leaf module rather
 * than part of `env.config.ts`. The `@hushbox/shared` barrel is imported by
 * three browser bundles and needs this schema; `env.config.ts` holds the
 * backend registry, whose variable names have no business in a browser. Kept
 * apart, the registry is off the barrel's module graph outright instead of
 * relying on a bundler proving it pure.
 */
export const frontendEnvSchema = z.object({
  // No `.default()` for VITE_PLATFORM / VITE_APP_VERSION: the generated env files
  // carry a value for every mode and api.ts forwards them, so absence means a
  // bad bootstrap and must fail fast rather than silently resolve to a default.
  VITE_API_URL: z.url(),
  VITE_PLATFORM: z.enum(VALID_PLATFORMS),
  VITE_APP_VERSION: z.string().min(1),
  VITE_HELCIM_JS_TOKEN: z.string().optional(),
  VITE_DRIZZLE_STUDIO_URL: z.url().optional(),
  VITE_ADMIN_URL: z.url().optional(),
  // Optional (like VITE_ADMIN_URL): the dev-only crawler-eye badge reads it
  // behind an `env.isDev` gate; it carries no production value, so a required
  // field would throw at web-app module load in prod.
  VITE_CRAWLER_VIEW_URL: z.url().optional(),
  // Optional (like VITE_ADMIN_URL): the admin SPA supplies it for its
  // admin→chat link, but the product web app parses only VITE_API_URL /
  // VITE_PLATFORM / VITE_APP_VERSION (apps/web/src/lib/api/api.ts), so a required
  // field would throw at web-app module load. Defined for every mode in
  // envConfig (production `https://hushbox.ai`), so it is present when needed.
  VITE_WEB_URL: z.url().optional(),
  // Optional (like VITE_ADMIN_URL): the VAPID public key for PushManager.
  // subscribe. Read behind a push-capability gate in the web client, and it
  // carries no value in modes that omit it, so a required field would throw at
  // web-app module load.
  VITE_VAPID_PUBLIC_KEY: z.string().min(1).optional(),
});
