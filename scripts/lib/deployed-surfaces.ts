/**
 * Every static surface the production deploy publishes and the post-deploy
 * probe proves, keyed by the directory the deploy publishes it from. The probe
 * reads each surface's origin from the registry variable named here, and the
 * env generator emits exactly those variables into the probe step, so the
 * names exist once.
 */
import type { envConfig } from '@hushbox/shared/env.config';

interface Surface {
  /** The registry variable naming the surface's production origin. */
  readonly origin: keyof typeof envConfig;
  /** Serves its stamp publicly; a surface that does not is proven behind its Access wall. */
  readonly public: boolean;
  /** Deployed as a Worker from its directory, so its live version can be read by tag. */
  readonly worker: boolean;
}

export const SURFACES = {
  'apps/web': { origin: 'FRONTEND_URL', public: true, worker: false },
  'apps/sandbox': { origin: 'SANDBOX_ORIGIN_URL', public: true, worker: true },
  'apps/admin': { origin: 'ADMIN_URL', public: false, worker: true },
} as const satisfies Readonly<Record<string, Surface>>;

/** A registry variable naming a probed surface's origin. */
export type OriginVariable = (typeof SURFACES)[keyof typeof SURFACES]['origin'];

/** The origin variable of every surface, in the order {@link SURFACES} declares them. */
export const SURFACE_ORIGINS: readonly OriginVariable[] = Object.values(SURFACES).map(
  (surface) => surface.origin
);
