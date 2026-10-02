import { Hono } from 'hono';
import { defineSliceManifest } from '../../middleware/pipeline-manifest.js';
import { accountDeletionRoutes } from './routes/account-deletion-routes.js';
import { accountProfileRoutes } from './routes/account-profile-routes.js';
import { emailTokenRoutes } from './routes/email-token-routes.js';
import { loginRoutes } from './routes/login-routes.js';
import { passwordChangeRoutes } from './routes/password-change-routes.js';
import { recoveryResetRoutes } from './routes/recovery-reset-routes.js';
import { recoverySaveRoutes } from './routes/recovery-save-routes.js';
import { registrationRoutes } from './routes/registration-routes.js';
import { twoFactorRoutes } from './routes/two-factor-routes.js';
import type { AppEnv } from '../../middleware/pipeline-manifest.js';
import type { IdentityRouteDeps } from './routes/deps.js';

/**
 * The identity slice's HTTP surface. The OPAQUE rounds are
 * `opaque-protocol`-exempt from the Idempotency-Key header: the Redis
 * challenge state is the dedup — a retry restarts the handshake harmlessly.
 *
 * No return annotation: the chained route schema must flow through
 * `defineSliceManifest`'s generic so `AppType` (and the typed client) carry
 * this slice's routes after mounting.
 */
export function createIdentityManifest(deps: IdentityRouteDeps) {
  return defineSliceManifest({
    basePath: '/auth',
    // Every group mounts at `/`, so the router sees the same paths in the same
    // order as one chain: the groups are contiguous slices of it.
    routes: new Hono<AppEnv>()
      .route('/', registrationRoutes(deps))
      .route('/', loginRoutes(deps))
      .route('/', twoFactorRoutes(deps))
      .route('/', passwordChangeRoutes(deps))
      .route('/', recoveryResetRoutes(deps))
      .route('/', emailTokenRoutes(deps))
      .route('/', accountDeletionRoutes(deps))
      .route('/', accountProfileRoutes(deps))
      .route('/', recoverySaveRoutes(deps)),
  });
}
