import {
  createOpaqueClient,
  startLogin,
  finishLogin,
  OPAQUE_SERVER_IDENTIFIER,
} from '@hushbox/crypto';

/**
 * A password step-up in flight: the client's `ke1` for the flow's own `/init`
 * call, and the proof step that closes the handshake with the server's `ke2`.
 */
interface PasswordStepUp {
  readonly ke1: number[];
  /** Rejects when the password is wrong — OPAQUE's MAC check fails here, never on the wire. */
  finish: (ke2: number[]) => Promise<number[]>;
}

/**
 * The one client-side OPAQUE step-up: it owns the client instance both halves
 * must share and the server identifier the proof is bound to, so a caller can
 * only get its endpoints or its payload wrong, never the protocol.
 *
 * It yields a proof and never key material, which is why login does not use it:
 * login needs `finishLogin`'s export key to unwrap the account key, and handing
 * that to a step-up caller would widen key exposure for three shared lines.
 */
export async function beginPasswordStepUp(password: string): Promise<PasswordStepUp> {
  const client = createOpaqueClient();
  const { ke1 } = await startLogin(client, password);

  return {
    ke1,
    finish: async (ke2: number[]): Promise<number[]> => {
      const { ke3 } = await finishLogin(client, ke2, OPAQUE_SERVER_IDENTIFIER);
      return ke3;
    },
  };
}
