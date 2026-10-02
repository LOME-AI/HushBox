import { describe, expect, it } from 'vitest';
import { match } from 'ts-pattern';
import { LINK_AUTH_TOKEN_BYTES, hashLinkAuthToken } from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';
import { errAsync, okAsync } from '../../../lib/result/index.js';
import { unavailableError } from '../../../lib/errors/index.js';
import { resolveLinkGuestPrincipal } from './link-guest.js';
import type { Principal } from '../../../lib/context/index.js';
import type { LinkResolutionPort } from '../ports/index.js';

const LINK_TOKEN = new Uint8Array(LINK_AUTH_TOKEN_BYTES).fill(7);
const LIVE = { linkId: 'link-1', conversationId: 'conv-1' };

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

/** Port double resolving exactly one live link, by the hash of its token. */
const livePort: LinkResolutionPort = {
  resolveLinkCredential: (linkAuthHash) =>
    okAsync(sameBytes(linkAuthHash, hashLinkAuthToken(LINK_TOKEN)) ? LIVE : null),
};

/** Port double recording every value it was asked to resolve. */
function recordingPort(): { readonly seen: Uint8Array[]; readonly port: LinkResolutionPort } {
  const seen: Uint8Array[] = [];
  return {
    seen,
    port: {
      resolveLinkCredential: (linkAuthHash) => {
        seen.push(linkAuthHash);
        return okAsync(LIVE);
      },
    },
  };
}

describe('resolveLinkGuestPrincipal', () => {
  it('resolves a live link token to a typed link-guest principal', async () => {
    const result = await resolveLinkGuestPrincipal({
      port: livePort,
      credential: toBase64(LINK_TOKEN),
    });
    expect(result._unsafeUnwrap()).toEqual({
      kind: 'link-guest',
      linkId: 'link-1',
      conversationId: 'conv-1',
    });
  });

  it('hands the port the hash of the presented token', async () => {
    const { seen, port } = recordingPort();
    const result = await resolveLinkGuestPrincipal({ port, credential: toBase64(LINK_TOKEN) });
    expect(result.isOk()).toBe(true);
    expect(seen).toEqual([hashLinkAuthToken(LINK_TOKEN)]);
  });

  it('never hands the port the presented token itself', async () => {
    const { seen, port } = recordingPort();
    const result = await resolveLinkGuestPrincipal({ port, credential: toBase64(LINK_TOKEN) });
    expect(result.isOk()).toBe(true);
    expect(seen.some((value) => sameBytes(value, LINK_TOKEN))).toBe(false);
  });

  it('degrades an unknown token to none', async () => {
    const result = await resolveLinkGuestPrincipal({
      port: livePort,
      credential: toBase64(new Uint8Array(LINK_AUTH_TOKEN_BYTES).fill(9)),
    });
    expect(result._unsafeUnwrap()).toEqual({ kind: 'none' });
  });

  it.each([
    ['one byte short of a token', LINK_AUTH_TOKEN_BYTES - 1],
    ['one byte longer than a token', LINK_AUTH_TOKEN_BYTES + 1],
    ['empty', 0],
  ])(
    'degrades a credential that is %s to none without consulting the port',
    async (_label, length) => {
      const { seen, port } = recordingPort();
      const result = await resolveLinkGuestPrincipal({
        port,
        credential: toBase64(new Uint8Array(length).fill(7)),
      });
      expect(result._unsafeUnwrap()).toEqual({ kind: 'none' });
      expect(seen).toEqual([]);
    }
  );

  it('degrades a malformed base64 credential to none without consulting the port', async () => {
    let consulted = false;
    const port: LinkResolutionPort = {
      resolveLinkCredential: () => {
        consulted = true;
        return okAsync(LIVE);
      },
    };
    const result = await resolveLinkGuestPrincipal({ port, credential: '!!!not-base64!!!' });
    expect(result._unsafeUnwrap()).toEqual({ kind: 'none' });
    expect(consulted).toBe(false);
  });

  it('propagates a port failure instead of degrading to none', async () => {
    const port: LinkResolutionPort = {
      resolveLinkCredential: () => errAsync(unavailableError('link store down')),
    };
    const result = await resolveLinkGuestPrincipal({
      port,
      credential: toBase64(LINK_TOKEN),
    });
    expect(result._unsafeUnwrapErr().code).toBe('unavailable');
  });

  it('lets a consumer authorize by exhaustive kind match with no field sniffing', async () => {
    // A realtime-shaped consumer: which conversation may this principal join?
    // The exhaustive match over the FULL union is the acceptance shape —
    // adding a Principal variant fails compilation here, and the guest arm
    // reads only typed scope fields.
    function authorizeJoin(principal: Principal): { allowed: boolean; scope: string } {
      return match(principal)
        .with({ kind: 'link-guest' }, (guest) => ({
          allowed: guest.conversationId === 'conv-1',
          scope: guest.linkId,
        }))
        .with({ kind: 'trial-session' }, (trial) => ({ allowed: false, scope: trial.sessionId }))
        .with({ kind: 'full' }, (session) => ({ allowed: true, scope: session.claims.userId }))
        .with({ kind: 'billing-portal' }, () => ({ allowed: false, scope: 'billing' }))
        .with({ kind: 'pending-2fa' }, () => ({ allowed: false, scope: '2fa' }))
        .with({ kind: 'admin-actor' }, () => ({ allowed: false, scope: 'admin' }))
        .with({ kind: 'none' }, () => ({ allowed: false, scope: 'anonymous' }))
        .exhaustive();
    }
    const resolved = await resolveLinkGuestPrincipal({
      port: livePort,
      credential: toBase64(LINK_TOKEN),
    });
    expect(authorizeJoin(resolved._unsafeUnwrap())).toEqual({ allowed: true, scope: 'link-1' });
  });
});
