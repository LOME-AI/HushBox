import type { Clock, NoteStoreFactory } from '../ports/index.js';

/** Dependencies the composition root injects into this slice's routes. */
export interface TemplateDeps {
  readonly clock: Clock;
  readonly notes: NoteStoreFactory;
}

/** Example domain logic: pure, port-driven, infra-free. */
export function buildGreeting(clock: Clock): string {
  return `hello from the template slice at ${clock.now().toISOString()}`;
}
