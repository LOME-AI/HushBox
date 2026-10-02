import { SERVICES, SERVICE_KEYS } from './port-plan.js';

/**
 * Ports published on the host by a container instead of bound by a process of
 * this checkout: the `docker-compose.yml` services, plus the adb port of the
 * Android emulator that `scripts/mobile-test.ts` starts through its own
 * `docker run`. Freeing one would mean stopping a container, which port cleanup
 * must never do — so these are the keys subtracted when
 * {@link HOST_BOUND_PORT_ENVS} is derived.
 *
 * Membership is checked in both directions rather than asserted: the colocated
 * test reads those container launches themselves, and fails both on a published
 * port missing here and on a key here that no container publishes. The second
 * direction is the one the declaration cannot supply — a service declared
 * `host` reaches the kill set by default, so omission is already
 * unrepresentable, while an over-wide subtraction set silently stops the kill
 * list reaching a port it should reach.
 *
 * The subtraction is a convenience, not the safeguard: dev-clean ends a
 * listener only where a claim licenses it — a dead run's claim naming the port,
 * or the printed flag a developer passes for one no claim names — and no claim
 * of this stack names a port a container published.
 */
export const CONTAINER_OWNED_PORTS: ReadonlySet<string> = new Set<string>(
  SERVICE_KEYS.filter((key) => SERVICES[key].owner === 'container')
);

/**
 * The env var `scripts/generate-env.ts` mints for a port key. One
 * implementation, so a kill set derived from the port declaration always names
 * variables the generator actually writes.
 */
export function portEnvName(key: string): string {
  return `HB_${key.replaceAll(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}_PORT`;
}

/** The given port keys, less the container-owned ones, as env var names. */
export function hostBoundPortEnvNames(portKeys: readonly string[]): string[] {
  return portKeys.filter((key) => !CONTAINER_OWNED_PORTS.has(key)).map((key) => portEnvName(key));
}

/**
 * Every minted port no container of this stack publishes: the set the read-only
 * world audit classifies, which is where a listener this checkout left behind is
 * named. Derived from the service declaration, so a service added to
 * {@link SERVICES} joins it without anyone having to remember.
 */
export const HOST_BOUND_PORT_ENVS: readonly string[] = hostBoundPortEnvNames(SERVICE_KEYS);

/**
 * The ports development and e2e each bind their own copy of. Derived from the
 * declaration's mode-banding, which every host-bound service but the idle
 * daemon carries — the daemon is one sentinel per slot, watching both modes.
 */
export const MODE_BANDED_PORT_ENVS: readonly string[] = SERVICE_KEYS.filter(
  (key) => SERVICES[key].modeBanded
).map((key) => portEnvName(key));
