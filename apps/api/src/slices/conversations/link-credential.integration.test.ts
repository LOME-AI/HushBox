// A link guest authenticates only by the token its URL's secret derives. A value
// any member or any operator can read — the link's public key, or any readable
// column of its row — authenticates nothing, and each refusal sits beside the
// real token's admission on the same route so a 401 cannot pass by accident.
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import { generateKeyPair, wrapEpochKeyForNewMember } from '@hushbox/crypto';
import { conversationMembers, sharedLinks } from '@hushbox/db';
import { ERROR_CODES, UPGRADE_TICKET_PARAM, toBase64 } from '@hushbox/shared';
import { okAsync } from '../../lib/result/index.js';
import { applyPipeline } from '../../middleware/pipeline.js';
import { createLinkResolutionAdapter } from '../../composition/bindings/link-resolution.js';
import { createBillingStores } from '../billing/index.js';
import { createChatManifest, deleteForkMessagesWithinTx } from '../chat/index.js';
import {
  MODEL,
  STARTED,
  cookie,
  db,
  fakeRealtime,
  redis,
  seedConversation,
  seedModel,
  seedOwnerFunding,
  seedUser,
  testEnv,
} from '../../test-support/chat-routes.integration.setup.js';
import { mintLinkCredential } from '../../test-support/link-credential.js';
import {
  createConversationsManifest,
  createConversationsStores,
  createMembershipRevoker,
} from './index.js';
import { LINK_CREDENTIAL_HEADER } from './domain/index.js';
import { UPGRADE_TICKET_KEY, hashUpgradeTicket } from './domain/shares/upgrade-ticket.js';
import type { z } from 'zod';
import type { AppEnv } from '../../lib/context/index.js';
import type { createLinkBodySchema } from './domain/index.js';
import type { RealtimeBroadcast, UpgradePrincipal } from './ports/realtime.js';

interface SeededLink {
  readonly linkId: string;
  readonly memberId: string;
  readonly linkPublicKey: Uint8Array;
  /** The credential the link's URL yields: base64 of the token its secret derives. */
  readonly token: string;
}

interface Scene {
  readonly conversationId: string;
  readonly ownerId: string;
  readonly ownerCookie: string;
  /** A read-only member's session cookie. */
  readonly memberCookie: string;
  readonly memberSeatId: string;
  readonly write: SeededLink;
  readonly read: SeededLink;
}

interface Harness {
  readonly app: Hono<AppEnv>;
  /** Every run the chat route handed the room. */
  readonly starts: string[];
  /** Every socket principal the upgrade route handed the room. */
  readonly upgrades: UpgradePrincipal[];
}

function harness(): Harness {
  const starts: string[] = [];
  const upgrades: UpgradePrincipal[] = [];
  const realtime: RealtimeBroadcast = fakeRealtime(STARTED, {
    startRun: (conversationId) => {
      starts.push(conversationId);
      return okAsync(STARTED);
    },
    upgrade: (_conversationId, principal) => {
      upgrades.push(principal);
      // The room's real answer is a 101, which a `Response` cannot be built with.
      return okAsync(new Response(null, { status: 200 }));
    },
  });
  const app = applyPipeline(new Hono<AppEnv>());
  const conversationsManifest = createConversationsManifest({
    stores: createConversationsStores,
    billing: createBillingStores(),
    revoker: createMembershipRevoker,
    realtime: () => realtime,
    deleteForkMessages: (writer) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(writer, conversationId, ids),
    linkResolution: (writer) => createLinkResolutionAdapter(writer),
  });
  const chatManifest = createChatManifest({
    conversations: createConversationsStores,
    billing: createBillingStores(),
    realtime: () => realtime,
    trialRoomName: (sessionId) => `trial:${sessionId}`,
    linkResolution: (writer) => createLinkResolutionAdapter(writer),
  });
  app.route(conversationsManifest.basePath, conversationsManifest.routes);
  app.route(chatManifest.basePath, chatManifest.routes);
  return { app, starts, upgrades };
}

/** A link minted from a real link secret, with the guest seat it grants. */
async function seedLink(
  conversationId: string,
  privilege: 'read' | 'write',
  displayName: string
): Promise<SeededLink> {
  const minted = mintLinkCredential();
  const [link] = await db
    .insert(sharedLinks)
    .values({
      conversationId,
      linkPublicKey: minted.linkPublicKey,
      linkAuthHash: minted.linkAuthHash,
      displayName,
    })
    .returning({ id: sharedLinks.id });
  if (link === undefined) throw new Error('shared link seed failed');
  const [member] = await db
    .insert(conversationMembers)
    .values({ conversationId, linkId: link.id, privilege, visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  if (member === undefined) throw new Error('link member seed failed');
  return {
    linkId: link.id,
    memberId: member.id,
    linkPublicKey: minted.linkPublicKey,
    token: minted.token,
  };
}

/** Owner O, read-only member M, and an owner-funded write link W beside a read link R. */
async function seedScene(): Promise<Scene> {
  await seedModel();
  const ownerId = await seedUser();
  const conversationId = await seedConversation(ownerId, false);
  await db
    .insert(conversationMembers)
    .values({ conversationId, userId: ownerId, privilege: 'owner', visibleFromEpoch: 1 });
  const memberId = await seedUser();
  const [seat] = await db
    .insert(conversationMembers)
    .values({ conversationId, userId: memberId, privilege: 'read', visibleFromEpoch: 1 })
    .returning({ id: conversationMembers.id });
  if (seat === undefined) throw new Error('member seed failed');
  const write = await seedLink(conversationId, 'write', 'Write link');
  const read = await seedLink(conversationId, 'read', 'Read link');
  await seedOwnerFunding(ownerId, conversationId, write.memberId);
  return {
    conversationId,
    ownerId,
    ownerCookie: await cookie(ownerId),
    memberCookie: await cookie(memberId),
    memberSeatId: seat.id,
    write,
    read,
  };
}

function credentialHeaders(
  credential: string | undefined,
  sessionCookie?: string
): Record<string, string> {
  return {
    'content-type': 'application/json',
    ...(credential === undefined ? {} : { [LINK_CREDENTIAL_HEADER]: credential }),
    ...(sessionCookie === undefined ? {} : { cookie: sessionCookie }),
  };
}

function guestSend(
  { app }: Harness,
  conversationId: string,
  credential: string,
  sessionCookie?: string
): Promise<Response> {
  return Promise.resolve(
    app.request(
      '/chat/guest',
      {
        method: 'POST',
        headers: {
          ...credentialHeaders(credential, sessionCookie),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify({
          conversationId,
          turnSources: [{ kind: 'model', id: MODEL }],
          userMessage: { content: 'hello from a link guest' },
        }),
      },
      testEnv
    )
  );
}

function rename(
  { app }: Harness,
  conversationId: string,
  credential: string,
  displayName: string
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/conversations/${conversationId}/my-name`,
      {
        method: 'PATCH',
        headers: credentialHeaders(credential),
        body: JSON.stringify({ displayName }),
      },
      testEnv
    )
  );
}

function readConversation(
  { app }: Harness,
  conversationId: string,
  credential: string | undefined,
  sessionCookie?: string
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/conversations/${conversationId}`,
      { method: 'GET', headers: credentialHeaders(credential, sessionCookie) },
      testEnv
    )
  );
}

function mintTicket(
  { app }: Harness,
  conversationId: string,
  credential: string | undefined,
  sessionCookie?: string
): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/conversations/${conversationId}/websocket-ticket`,
      { method: 'POST', headers: credentialHeaders(credential, sessionCookie) },
      testEnv
    )
  );
}

async function issuedTicket(h: Harness, conversationId: string, token: string): Promise<string> {
  const res = await mintTicket(h, conversationId, token);
  expect(res.status).toBe(200);
  const body = await res.json<{ ticket: string }>();
  return body.ticket;
}

/** A socket upgrade from an allowed origin, carrying only what `request` names. */
function upgradeSocket(
  { app }: Harness,
  conversationId: string,
  request: { readonly query?: Record<string, string>; readonly credential?: string }
): Promise<Response> {
  const query = new URLSearchParams(request.query ?? {}).toString();
  const path = `/conversations/${conversationId}/websocket`;
  return Promise.resolve(
    app.request(
      query === '' ? path : `${path}?${query}`,
      {
        method: 'GET',
        headers: {
          Origin: 'capacitor://localhost',
          ...(request.credential === undefined
            ? {}
            : { [LINK_CREDENTIAL_HEADER]: request.credential }),
        },
      },
      testEnv
    )
  );
}

function upgradeWithTicket(h: Harness, conversationId: string, ticket: string): Promise<Response> {
  return upgradeSocket(h, conversationId, { query: { [UPGRADE_TICKET_PARAM]: ticket } });
}

async function statusOf(pending: Promise<Response>): Promise<number> {
  const res = await pending;
  return res.status;
}

async function displayNameOf(linkId: string): Promise<string | null> {
  const [row] = await db
    .select({ displayName: sharedLinks.displayName })
    .from(sharedLinks)
    .where(eq(sharedLinks.id, linkId));
  if (row === undefined) throw new Error('link row missing');
  return row.displayName;
}

/** The public keys M reads from the member-keys route while a member. */
async function memberKeysReadBy(
  { app }: Harness,
  scene: Scene
): Promise<{ linkId: string | null; publicKey: string }[]> {
  const res = await app.request(
    `/conversations/${scene.conversationId}/member-keys`,
    { method: 'GET', headers: { cookie: scene.memberCookie } },
    testEnv
  );
  expect(res.status).toBe(200);
  const body = await res.json<{ members: { linkId: string | null; publicKey: string }[] }>();
  return body.members;
}

interface PanelValue {
  readonly column: string;
  /** What an operator would paste as a credential: base64 for bytes, the text itself otherwise. */
  readonly presented: string;
}

/**
 * Every bytea and text-typed value of one link row, read through the admin SQL
 * panel's own role. The column list comes from what that role can see, so a
 * column the panel gains later is presented here without editing this test.
 */
async function panelReadableValues(linkId: string): Promise<PanelValue[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE admin_sql_panel`);
    const columns = await tx.execute<{ column_name: string; data_type: string }>(
      sql`SELECT column_name, data_type FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = 'shared_links'
            AND data_type IN ('bytea', 'text', 'uuid', 'character varying')`
    );
    const values: PanelValue[] = [];
    for (const { column_name: column, data_type: type } of columns.rows) {
      const projected =
        type === 'bytea'
          ? sql`translate(encode(${sql.identifier(column)}, 'base64'), E'\n', '')`
          : sql`${sql.identifier(column)}::text`;
      const result = await tx.execute<{ value: string | null }>(
        sql`SELECT ${projected} AS value FROM shared_links WHERE id = ${linkId}`
      );
      const value = result.rows[0]?.value;
      if (value !== null && value !== undefined) values.push({ column, presented: value });
    }
    return values;
  });
}

describe('a read-only member presenting a write link public key', () => {
  it('holds the write link public key through the member-keys route', async () => {
    const h = harness();
    const scene = await seedScene();
    const keys = await memberKeysReadBy(h, scene);
    expect(keys).toContainEqual(
      expect.objectContaining({
        linkId: scene.write.linkId,
        publicKey: toBase64(scene.write.linkPublicKey),
      })
    );
  });

  it('is refused the guest send with 401, starting no run', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await guestSend(h, scene.conversationId, toBase64(scene.write.linkPublicKey));
    expect(res.status).toBe(401);
    expect(h.starts).toEqual([]);
  });

  it('is refused the rename with 401, leaving the name unchanged', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await rename(h, scene.conversationId, toBase64(scene.write.linkPublicKey), 'Taken');
    expect(res.status).toBe(401);
    expect(await displayNameOf(scene.write.linkId)).toBe('Write link');
  });

  it('is refused the conversation read with 401', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await readConversation(
      h,
      scene.conversationId,
      toBase64(scene.write.linkPublicKey)
    );
    expect(res.status).toBe(401);
  });

  it('is refused the socket ticket with 401', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await mintTicket(h, scene.conversationId, toBase64(scene.write.linkPublicKey));
    expect(res.status).toBe(401);
  });

  it('is refused the upgrade through the linkPublicKey query with 401, opening no socket', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await upgradeSocket(h, scene.conversationId, {
      query: { linkPublicKey: toBase64(scene.write.linkPublicKey) },
    });
    expect(res.status).toBe(401);
    expect(h.upgrades).toEqual([]);
  });

  it('is refused the upgrade through the credential header with 401, opening no socket', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await upgradeSocket(h, scene.conversationId, {
      credential: toBase64(scene.write.linkPublicKey),
    });
    expect(res.status).toBe(401);
    expect(h.upgrades).toEqual([]);
  });
});

describe('the write link real token', () => {
  it('is admitted to the guest send, which starts one run', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await guestSend(h, scene.conversationId, scene.write.token);
    expect(res.status).toBe(201);
    expect(h.starts).toEqual([scene.conversationId]);
  });

  it('renames the link with 200', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await rename(h, scene.conversationId, scene.write.token, 'Renamed');
    expect(res.status).toBe(200);
    expect(await displayNameOf(scene.write.linkId)).toBe('Renamed');
  });

  it('reads the conversation with 200', async () => {
    const h = harness();
    const scene = await seedScene();
    const res = await readConversation(h, scene.conversationId, scene.write.token);
    expect(res.status).toBe(200);
  });

  it('mints a ticket that opens the socket as the link guest', async () => {
    const h = harness();
    const scene = await seedScene();
    const ticket = await issuedTicket(h, scene.conversationId, scene.write.token);
    const res = await upgradeWithTicket(h, scene.conversationId, ticket);
    expect(res.status).toBe(200);
    expect(h.upgrades).toEqual([
      expect.objectContaining({ isGuest: true, principalId: scene.write.linkId }),
    ]);
  });

  it('cannot replay its ticket: the second upgrade gets 401 and opens no second socket', async () => {
    const h = harness();
    const scene = await seedScene();
    const ticket = await issuedTicket(h, scene.conversationId, scene.write.token);
    expect(await statusOf(upgradeWithTicket(h, scene.conversationId, ticket))).toBe(200);
    const replay = await upgradeWithTicket(h, scene.conversationId, ticket);
    expect(replay.status).toBe(401);
    expect(h.upgrades).toHaveLength(1);
  });
});

describe('a removed member presenting the link public keys it saved', () => {
  async function removedMemberScene(h: Harness): Promise<{ scene: Scene; saved: string[] }> {
    const scene = await seedScene();
    const members = await memberKeysReadBy(h, scene);
    const saved = members
      .filter((member) => member.linkId !== null)
      .map((member) => member.publicKey);
    const byText = (x: string, y: string): number => x.localeCompare(y);
    expect(saved.toSorted(byText)).toEqual(
      [toBase64(scene.write.linkPublicKey), toBase64(scene.read.linkPublicKey)].toSorted(byText)
    );
    await db
      .update(conversationMembers)
      .set({ leftAt: new Date() })
      .where(eq(conversationMembers.id, scene.memberSeatId));
    return { scene, saved };
  }

  it('is refused the guest send with 401 for every saved key, starting no run', async () => {
    const h = harness();
    const { scene, saved } = await removedMemberScene(h);
    for (const key of saved) {
      expect(await statusOf(guestSend(h, scene.conversationId, key))).toBe(401);
    }
    expect(h.starts).toEqual([]);
  });

  it('is refused the rename with 401 for every saved key, changing no name', async () => {
    const h = harness();
    const { scene, saved } = await removedMemberScene(h);
    for (const key of saved) {
      expect(await statusOf(rename(h, scene.conversationId, key, 'Taken'))).toBe(401);
    }
    expect(await displayNameOf(scene.write.linkId)).toBe('Write link');
    expect(await displayNameOf(scene.read.linkId)).toBe('Read link');
  });

  it('is refused the conversation read with 401 for every saved key', async () => {
    const h = harness();
    const { scene, saved } = await removedMemberScene(h);
    for (const key of saved) {
      expect(await statusOf(readConversation(h, scene.conversationId, key))).toBe(401);
    }
  });

  it('is refused the socket ticket with 401 for every saved key', async () => {
    const h = harness();
    const { scene, saved } = await removedMemberScene(h);
    for (const key of saved) {
      expect(await statusOf(mintTicket(h, scene.conversationId, key))).toBe(401);
    }
  });

  it('is answered as its departed session, never as a link, when it also sends its cookie', async () => {
    const h = harness();
    const { scene, saved } = await removedMemberScene(h);
    for (const key of saved) {
      const read = await readConversation(h, scene.conversationId, key, scene.memberCookie);
      expect(read.status).toBe(404);
      const send = await guestSend(h, scene.conversationId, key, scene.memberCookie);
      expect(send.status).toBe(403);
    }
    expect(h.starts).toEqual([]);
  });

  it('leaves both links reachable by their real tokens', async () => {
    const h = harness();
    const { scene } = await removedMemberScene(h);
    expect(await statusOf(readConversation(h, scene.conversationId, scene.write.token))).toBe(200);
    expect(await statusOf(readConversation(h, scene.conversationId, scene.read.token))).toBe(200);
  });
});

describe('a value the admin SQL panel reads from the link row', () => {
  it('reads the id, the public key, the auth hash among its values', async () => {
    const scene = await seedScene();
    const values = await panelReadableValues(scene.write.linkId);
    const columns = values.map((value) => value.column);
    expect(columns).toEqual(expect.arrayContaining(['id', 'link_public_key', 'link_auth_hash']));
  });

  it('is refused the guest send with 401 for every value, starting no run', async () => {
    const h = harness();
    const scene = await seedScene();
    for (const { presented } of await panelReadableValues(scene.write.linkId)) {
      expect(await statusOf(guestSend(h, scene.conversationId, presented))).toBe(401);
    }
    expect(h.starts).toEqual([]);
  });

  it('is refused the rename with 401 for every value, leaving the name unchanged', async () => {
    const h = harness();
    const scene = await seedScene();
    for (const { presented } of await panelReadableValues(scene.write.linkId)) {
      expect(await statusOf(rename(h, scene.conversationId, presented, 'Taken'))).toBe(401);
    }
    expect(await displayNameOf(scene.write.linkId)).toBe('Write link');
  });

  it('is refused the conversation read with 401 for every value', async () => {
    const h = harness();
    const scene = await seedScene();
    for (const { presented } of await panelReadableValues(scene.write.linkId)) {
      expect(await statusOf(readConversation(h, scene.conversationId, presented))).toBe(401);
    }
  });

  it('is refused the socket ticket with 401 for every value', async () => {
    const h = harness();
    const scene = await seedScene();
    for (const { presented } of await panelReadableValues(scene.write.linkId)) {
      expect(await statusOf(mintTicket(h, scene.conversationId, presented))).toBe(401);
    }
  });

  it('opens the socket through a ticket its real token mints', async () => {
    const h = harness();
    const scene = await seedScene();
    const ticket = await issuedTicket(h, scene.conversationId, scene.write.token);
    expect(await statusOf(upgradeWithTicket(h, scene.conversationId, ticket))).toBe(200);
  });
});

// A test may not walk the shared keyspace, so the store is read by address: the
// key the ticket itself would name, and the key its hash names. That the mint
// sends Redis nothing carrying the ticket is proven beside the ticket module.
describe('a socket ticket at rest in Redis', () => {
  it('is held under its hash and never under the ticket itself', async () => {
    const h = harness();
    const scene = await seedScene();
    const ticket = await issuedTicket(h, scene.conversationId, scene.write.token);
    const hashed = await hashUpgradeTicket(ticket);
    const ticketHash = hashed._unsafeUnwrap();
    expect(await redis.exists(UPGRADE_TICKET_KEY.buildKey(ticket))).toBe(0);
    expect(await redis.exists(UPGRADE_TICKET_KEY.buildKey(ticketHash))).toBe(1);
    const stored: unknown = await redis.get(UPGRADE_TICKET_KEY.buildKey(ticketHash));
    expect(JSON.stringify(stored)).not.toContain(ticket);
  });

  it('refuses its stored hash presented as a ticket with 401, opening no socket', async () => {
    const h = harness();
    const scene = await seedScene();
    const ticket = await issuedTicket(h, scene.conversationId, scene.write.token);
    const hashed = await hashUpgradeTicket(ticket);
    const ticketHash = hashed._unsafeUnwrap();
    const res = await upgradeWithTicket(h, scene.conversationId, ticketHash);
    expect(res.status).toBe(401);
    expect(h.upgrades).toEqual([]);
  });
});

type MintBody = z.input<typeof createLinkBodySchema>;

/** A full-history mint body for a fresh link secret, and the token that secret yields. */
function freshMint(conversationId: string): { readonly body: MintBody; readonly token: string } {
  const minted = mintLinkCredential();
  const epoch = generateKeyPair();
  const memberWrap = wrapEpochKeyForNewMember(epoch.privateKey, minted.linkPublicKey, {
    conversationId,
    epochNumber: 1,
    epochPublicKey: epoch.publicKey,
  });
  return {
    body: {
      linkPublicKey: toBase64(minted.linkPublicKey),
      linkAuthHash: toBase64(minted.linkAuthHash),
      privilege: 'read',
      giveFullHistory: true,
      expectedEpoch: 1,
      memberWrap: toBase64(memberWrap),
    },
    token: minted.token,
  };
}

function mint({ app }: Harness, scene: Scene, body: MintBody): Promise<Response> {
  return Promise.resolve(
    app.request(
      `/conversations/${scene.conversationId}/links`,
      {
        method: 'POST',
        headers: {
          ...credentialHeaders(undefined, scene.ownerCookie),
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      },
      testEnv
    )
  );
}

async function mintedLinkId(res: Response): Promise<string> {
  expect(res.status).toBe(200);
  const body = await res.json<{ link: { id: string }; created: boolean }>();
  return body.link.id;
}

describe('minting a link', () => {
  it('stores the submitted hash, so the minted link answers to its token', async () => {
    const h = harness();
    const scene = await seedScene();
    const { body, token } = freshMint(scene.conversationId);
    await mintedLinkId(await mint(h, scene, body));
    expect(await statusOf(readConversation(h, scene.conversationId, token))).toBe(200);
  });

  it('converges a re-mint of the same key under the same hash on the existing link', async () => {
    const h = harness();
    const scene = await seedScene();
    const { body } = freshMint(scene.conversationId);
    const first = await mintedLinkId(await mint(h, scene, body));
    const again = await mint(h, scene, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ link: { id: first }, created: false });
  });

  it('answers 409 to a re-mint of the same key under a different hash', async () => {
    const h = harness();
    const scene = await seedScene();
    const { body, token } = freshMint(scene.conversationId);
    await mintedLinkId(await mint(h, scene, body));
    const forged = { ...body, linkAuthHash: freshMint(scene.conversationId).body.linkAuthHash };
    const res = await mint(h, scene, forged);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
    expect(await statusOf(readConversation(h, scene.conversationId, token))).toBe(200);
  });

  it('answers 409, not 500, to a new key carrying a hash another link holds', async () => {
    const h = harness();
    const scene = await seedScene();
    const { body } = freshMint(scene.conversationId);
    await mintedLinkId(await mint(h, scene, body));
    const colliding = { ...freshMint(scene.conversationId).body, linkAuthHash: body.linkAuthHash };
    const res = await mint(h, scene, colliding);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
  });
});
