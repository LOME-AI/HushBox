import { Factory } from 'fishery';
import { faker } from '@faker-js/faker';

import { placeholderBytes } from './helpers.js';
import type { sharedLinks } from '../schema/shared-links';

type NewSharedLink = typeof sharedLinks.$inferInsert;

/** Build overrides. The conversation id is required — see {@link SharedLinkBuilder}. */
type SharedLinkParams = Partial<NewSharedLink> & Pick<NewSharedLink, 'conversationId'>;

/**
 * fishery types `build` as `build(params?)`, so no generator default can force a
 * caller's hand. `shared_links.conversation_id` is a NOT NULL foreign key, so a
 * defaulted id references a conversation that does not exist and the row can only
 * ever be rejected at insert; narrowing the exported shape to this makes omitting
 * it a compile error instead.
 */
interface SharedLinkBuilder {
  build: (params: SharedLinkParams) => NewSharedLink;
}

/** Builds insertable `shared_links` rows for the conversation the caller names. */
export const sharedLinkFactory: SharedLinkBuilder = Factory.define<
  NewSharedLink,
  never,
  NewSharedLink,
  SharedLinkParams
>(({ params }) => ({
  conversationId: params.conversationId,
  linkPublicKey: placeholderBytes(32),
  linkAuthHash: placeholderBytes(32),
  displayName: faker.person.firstName(),
}));

/** Revoked link — enforced lazily at the read path. */
export const revokedSharedLinkFactory: SharedLinkBuilder = Factory.define<
  NewSharedLink,
  never,
  NewSharedLink,
  SharedLinkParams
>(({ params }) => ({
  ...sharedLinkFactory.build(params),
  revokedAt: faker.date.recent(),
}));
