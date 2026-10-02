import { describe, expect, it } from 'vitest';
import { okAsync } from '../../../lib/result/index.js';
import { resolveUpgradePrincipal } from './caller-authorization.js';
import type { ConversationsRouteDeps } from './deps.js';
import type { AppEnv } from '../../../middleware/pipeline-manifest.js';
import type { Context } from 'hono';

const CONVERSATION_ID = '11111111-1111-4111-8111-111111111111';
const USER_ID = '22222222-2222-4222-8222-222222222222';

/**
 * A member row carries far more than the upgrade reads, and the store it comes
 * from is a live Drizzle query — so the double is asserted, with the same
 * justification a documented `any` needs: only `displayName` is read here, and
 * a widened row would type-check against a shape the upgrade never touches.
 */
function depsReturningMember(): ConversationsRouteDeps {
  return {
    stores: () => ({
      members: { activeByUser: () => okAsync({ displayName: null }) },
    }),
  } as unknown as ConversationsRouteDeps;
}

/**
 * The upgrade reads only the principal, so the context is asserted for the same
 * reason the deps are: a real `Context<AppEnv>` carries the whole pipeline.
 */
function contextWithPrincipal(kind: 'full' | 'pending-2fa'): Context<AppEnv> {
  const principal = { kind, claims: { sessionId: 'session-1', createdAt: 1 } };
  return { var: { db: {}, principal } } as unknown as Context<AppEnv>;
}

describe('resolveUpgradePrincipal', () => {
  it('forwards the session snapshot when the caller holds a full principal', async () => {
    const upgrade = await resolveUpgradePrincipal(
      depsReturningMember(),
      contextWithPrincipal('full'),
      CONVERSATION_ID,
      { kind: 'user', userId: USER_ID }
    );

    expect(upgrade).toEqual({
      principalId: USER_ID,
      isGuest: false,
      session: { id: 'session-1', createdAt: 1 },
    });
  });

  it('upgrades without a session snapshot when the principal is not a full one', async () => {
    const upgrade = await resolveUpgradePrincipal(
      depsReturningMember(),
      contextWithPrincipal('pending-2fa'),
      CONVERSATION_ID,
      { kind: 'user', userId: USER_ID }
    );

    expect(upgrade).toEqual({ principalId: USER_ID, isGuest: false });
  });
});
