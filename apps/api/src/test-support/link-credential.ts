import { createSharedLink, deriveLinkAuthToken, generateKeyPair } from '@hushbox/crypto';
import { toBase64 } from '@hushbox/shared';

export interface LinkCredential {
  /** What a link guest presents in the credential header: base64 of the token its secret derives. */
  readonly token: string;
  /** The stored form of `token`, as `shared_links.link_auth_hash` holds it. */
  readonly linkAuthHash: Uint8Array;
  readonly linkPublicKey: Uint8Array;
  readonly linkSecret: Uint8Array;
}

/**
 * A shared link's material as a real mint yields it, so a test that seeds a link or
 * presents its credential exercises the same derivation a guest's URL does. The epoch
 * wrap `createSharedLink` also builds is discarded: callers seed their own wraps.
 */
export function mintLinkCredential(): LinkCredential {
  const { linkSecret, linkPublicKey, linkAuthHash } = createSharedLink(
    generateKeyPair().privateKey,
    { conversationId: crypto.randomUUID(), epochNumber: 1 }
  );
  return {
    token: toBase64(deriveLinkAuthToken(linkSecret)),
    linkAuthHash,
    linkPublicKey,
    linkSecret,
  };
}
