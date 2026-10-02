import { describe, it, expect, beforeAll } from 'vitest';
import { createAuthServerFixture } from '@/test-utils/auth-server-fixture';
import { beginPasswordStepUp } from '@/lib/auth/password-step-up.js';
import type { AuthServerFixture } from '@/test-utils/auth-server-fixture';

describe('beginPasswordStepUp against a real OPAQUE server', () => {
  let fixture: AuthServerFixture;

  beforeAll(async () => {
    fixture = await createAuthServerFixture();
  });

  it('produces a proof the server accepts for the registered password', async () => {
    const stepUp = await beginPasswordStepUp(fixture.password);
    const { ke2, sessionId } = await fixture.challengeStepUp(stepUp.ke1);

    const ke3 = await stepUp.finish(ke2);

    expect(fixture.proveStepUp(ke3, sessionId)).toBe(true);
  });

  // The proof closes the handshake only when both halves ran on one client
  // instance: a second `createOpaqueClient()` would carry neither the blinded
  // OPRF state nor the AKE ephemeral, and its MAC would not verify.
  it('proves the challenge on the client that produced the ke1, not a fresh one', async () => {
    const stepUp = await beginPasswordStepUp(fixture.password);
    const other = await beginPasswordStepUp(fixture.password);
    const { ke2 } = await fixture.challengeStepUp(stepUp.ke1);

    await expect(other.finish(ke2)).rejects.toThrow();
  });

  it('exposes no login key material beyond the proof', async () => {
    const stepUp = await beginPasswordStepUp(fixture.password);

    expect(Object.keys(stepUp)).toStrictEqual(['ke1', 'finish']);
  });

  it('rejects rather than swallowing the failure when the password is wrong', async () => {
    const stepUp = await beginPasswordStepUp('not-the-password');
    const { ke2 } = await fixture.challengeStepUp(stepUp.ke1);

    await expect(stepUp.finish(ke2)).rejects.toThrow();
  });
});
