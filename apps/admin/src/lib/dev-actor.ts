import { useSyncExternalStore } from 'react';

/**
 * The dev actors the API's dev-mode ADMIN_ACTOR_ALLOWLIST admits, in the order
 * the switcher offers them (see packages/shared/src/env/env.config.ts, which
 * also maps each to its role). The first two are operators; the last is the
 * read-only growth viewer, whose authorization is narrower than either — which
 * is why the switcher offers the list rather than swapping between two.
 * The dev-auth fetch wrapper mints a fresh Access JWT per actor.
 */
export const DEV_ADMIN_ACTORS = [
  'admin@hushbox.test',
  'ops@hushbox.test',
  'viewer@hushbox.test',
] as const;

type DevAdminActor = (typeof DEV_ADMIN_ACTORS)[number];

let currentActor: DevAdminActor = DEV_ADMIN_ACTORS[0];
const listeners = new Set<() => void>();

export function getDevActor(): DevAdminActor {
  return currentActor;
}

export function setDevActor(actor: DevAdminActor): void {
  if (actor === currentActor) return;
  currentActor = actor;
  for (const listener of listeners) listener();
}

export function subscribeDevActor(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useDevActor(): DevAdminActor {
  return useSyncExternalStore(subscribeDevActor, getDevActor);
}
