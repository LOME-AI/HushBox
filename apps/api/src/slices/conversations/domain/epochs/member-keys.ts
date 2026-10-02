import { z } from 'zod';
import { MEMBER_PRIVILEGES, toBase64 } from '@hushbox/shared';
import { okAsync } from '../../../../lib/result/index.js';
import { resolveCallerMember } from '../shares/caller.js';
import type { ConversationCaller } from '../shares/caller.js';
import type { DomainError } from '../../../../lib/errors/index.js';
import type { ResultAsync } from '../../../../lib/result/index.js';
import type { ConversationsStores } from '../../ports/index.js';
import type { Outcome } from '../outcomes.js';

const memberKeyViewSchema = z.object({
  memberId: z.string(),
  userId: z.string().nullable(),
  linkId: z.string().nullable(),
  /** Base64 public key: `users.publicKey` or `sharedLinks.linkPublicKey`. */
  publicKey: z.string(),
  privilege: z.enum(MEMBER_PRIVILEGES),
  visibleFromEpoch: z.number().int(),
});

type MemberKeyView = z.infer<typeof memberKeyViewSchema>;

const memberKeysViewSchema = z.object({ members: z.array(memberKeyViewSchema) });

type MemberKeysView = z.infer<typeof memberKeysViewSchema>;

/**
 * Every active member's PUBLIC key — the authoritative set a departing member
 * must re-wrap the next epoch key against (`planEpochWraps` refuses a mismatch),
 * so key rotation is impossible without it. Gated at READ privilege, not admin:
 * a non-owner member generates the rotation client-side and needs every
 * remaining member's key. Public keys are non-secret crypto material by design;
 * a non-member gets the indistinguishable not-found. The set spans both member
 * kinds: the store reads user members and link members as two separate joins
 * (`users` and `shared_links` carry the public key respectively) and merges
 * them, so a link member's key is never silently missing from a rotation.
 */
export function getMemberKeys(
  stores: ConversationsStores,
  params: { readonly conversationId: string; readonly caller: ConversationCaller }
): ResultAsync<Outcome<MemberKeysView>, DomainError> {
  return resolveCallerMember(stores, params.conversationId, params.caller).andThen((caller) => {
    if (caller === null) return okAsync<Outcome<MemberKeysView>>({ refusal: 'not-found' });
    // Validated where it is built: the schema is this view's runtime invariant,
    // and a shape it does not declare is a server defect (a throw), never a
    // refusal the client could act on.
    return stores.members.activeKeysOrdered(params.conversationId).map((rows) =>
      memberKeysViewSchema.parse({
        members: rows.map(
          (row): MemberKeyView => ({
            memberId: row.memberId,
            userId: row.userId,
            linkId: row.linkId,
            publicKey: toBase64(row.publicKey),
            privilege: row.privilege,
            visibleFromEpoch: row.visibleFromEpoch,
          })
        ),
      })
    );
  });
}
