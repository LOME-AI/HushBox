import { describe, expect, it, vi } from 'vitest';
import { createRoomBindings } from './room-bindings.js';
import type { Bindings } from '../../../lib/context/index.js';

// The published binding value-imports the realtime barrel, which transitively
// imports the workerd-only platform module; stubbed in node.
vi.mock('cloudflare:workers', () => ({
  // Never instantiated here — the stub only satisfies `extends` at load time.
  DurableObject: class {
    constructor(protected readonly ctx: unknown) {}
  },
}));

describe('conversations room-bindings door', () => {
  it('publishes the live room composition, which fail-fasts on an absent DATABASE_URL', () => {
    expect(() => createRoomBindings({} as Bindings)).toThrow(/DATABASE_URL/);
  });
});
