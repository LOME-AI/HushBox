/**
 * The synthetic caller addresses the E2E suite presents, and the one place the
 * address space is partitioned. Every per-IP limiter in the Worker keys on
 * `cf-connecting-ip`, and the local runtime injects the loopback address when a
 * client sends none — so an identity that is not derived here is one identity
 * shared by every project, and one project's dev-endpoint reset reaches into
 * another's.
 *
 * Two roles, two blocks of RFC 5737 documentation space (never routable, so a
 * value that escapes into a real request can name no real host):
 *
 * - **caller** — TEST-NET-1, the identity a project's own contexts present.
 * - **guest** — TEST-NET-3, the identity a spec presents when it must be
 *   sessionless traffic that is NOT the project's own caller, so that guest
 *   floods and caller traffic cannot spend each other's windows.
 *
 * TEST-NET-2 is deliberately left to neither: `apps/api`'s integration tests
 * write addresses in it against the same local Redis, so a third role taken
 * from there could collide with a vitest run.
 *
 * Both roles carry the same two axes — project and parallel worker slot — off
 * one derivation, so no second list and no second arithmetic can disagree with
 * this one, and the two blocks differ, so a guest address can never land on a
 * caller window whatever the registry grows to.
 *
 * Import-free of `process` and of Playwright at module scope, like the registry
 * it reads: `playwright.config.ts`, the E2E helpers and vitest all import it.
 */

import { ALL_PROJECT_NAMES } from './projects.js';

/** Usable host octets in a /24 (1–254; 0 is the network, 255 the broadcast). */
const HOSTS_PER_BLOCK = 254;

/** TEST-NET-1 — project caller identities. */
const CALLER_IP_BLOCK = '192.0.2.';

/** TEST-NET-3 — the guest identities specs present alongside their project's. */
const GUEST_IP_BLOCK = '203.0.113.';

/**
 * How many worker slots each project gets in either block: the block divided by
 * the registry, floored. Derived rather than picked so adding a project narrows
 * every project's allotment instead of overflowing the block — the failure mode
 * a hand-set number would ship the day a seventh engine lands.
 */
export const SLOTS_PER_PROJECT = Math.floor(HOSTS_PER_BLOCK / ALL_PROJECT_NAMES.length);

/**
 * A project's position in the registry — the value both derivations key on.
 * Absence is fatal rather than defaulted: a silent fallback would put two
 * projects back on one identity, which is the state these blocks close.
 */
function registryIndex(project: string): number {
  const index = ALL_PROJECT_NAMES.indexOf(project);
  if (index === -1) {
    throw new Error(`e2e-identities: project "${project}" is absent from the registry`);
  }
  return index;
}

/**
 * One block's address for one project and one parallel worker slot.
 *
 * Collision-free by construction rather than by inspection: the octet is
 * `index * slots + slot`, a Euclidean division, so `(index, slot)` is
 * recoverable from it and two distinct pairs cannot produce one address. Slots
 * wrap, so a machine running more workers than a project has slots stays
 * total — the wrap puts two workers of THAT project on one address, never a
 * second project's.
 */
function slotAddress(block: string, project: string, workerSlot: number): string {
  if (!Number.isInteger(workerSlot) || workerSlot < 0) {
    throw new Error(`e2e-identities: worker slot must be a whole index, got ${String(workerSlot)}`);
  }
  const offset = registryIndex(project) * SLOTS_PER_PROJECT;
  return `${block}${String(offset + (workerSlot % SLOTS_PER_PROJECT) + 1)}`;
}

/**
 * The project's own rate-limit identity, for one parallel worker slot. Both
 * axes cost something real: without the project axis every project spends one
 * set of caller windows, and without the worker axis every concurrently-running
 * worker of a project piles onto one window between resets — which is what
 * turned the ten-per-hour registration cap into a suite-wide budget that any
 * worker's reset freed for every other worker to drain.
 *
 * A project's setup project takes the same block position deliberately: its
 * logins spend the windows that project's own specs spend later.
 *
 * The reset that clears these windows must present the same address (the dev
 * endpoint scopes per-IP buckets to its caller), so the fixture that resets
 * derives through this function too.
 */
export function projectCallerIp(project: string, workerSlot: number): string {
  return slotAddress(CALLER_IP_BLOCK, project, workerSlot);
}

/**
 * The guest identity a spec presents on a sessionless path, for one project and
 * one parallel worker slot. Same two axes, same reasons, out of the block the
 * caller identity cannot reach.
 */
export function projectGuestIp(project: string, workerSlot: number): string {
  return slotAddress(GUEST_IP_BLOCK, project, workerSlot);
}
