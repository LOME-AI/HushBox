// Verifiable epoch rotation end to end: a departure pends, one route rotates it
// out and recovers from a hostile rotation, and every member detects a bad key
// with the one shared verifier. Every key is a real X25519 pair.
import { afterAll, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { sealData } from 'iron-session';
import { z } from 'zod';
import { and, eq, inArray } from 'drizzle-orm';
import {
  asEpochPrivateKey,
  createFirstEpoch,
  decryptContentEnvelope,
  encryptTextForEpoch,
  generateKeyPair,
  openEpochWrap,
  performEpochRotation,
  unwrapContentKeyFromEpoch,
  verifyKeyChain,
  wrapEpochKeyForNewMember,
} from '@hushbox/crypto';
import {
  LOCAL_NEON_DEV_CONFIG,
  contentItems,
  conversationMembers,
  conversations,
  createDb,
  epochMembers,
  epochs,
  messages,
  sharedLinks,
  users,
} from '@hushbox/db';
import { userFactory } from '@hushbox/db/factories';
import {
  ERROR_CODES,
  fromBase64,
  keyChainResponseSchema,
  rotationBodySchema,
  toBase64,
} from '@hushbox/shared';
import { applyPipeline } from '../../middleware/pipeline.js';
import { SESSION_COOKIE_NAME } from '../../middleware/pipeline-session.js';
import { bindRequestValue } from '../../lib/context/index.js';
import { okAsync } from '../../lib/result/index.js';
import { createLinkResolutionAdapter } from '../../composition/bindings/link-resolution.js';
import { scrubSentryEvent } from '../../lib/telemetry/adapters/sentry-scrub.js';
import { mintLinkCredential } from '../../test-support/link-credential.js';
import { createBillingStores } from '../billing/index.js';
import { createChatManifest, deleteForkMessagesWithinTx } from '../chat/index.js';
import {
  createConversationsManifest,
  createConversationsStores,
  createMembershipRevoker,
} from './index.js';
import { LINK_CREDENTIAL_HEADER, createSharedLink } from './domain/index.js';
import type { KeyChainResponse } from '@hushbox/shared';
import type { WrappedSecret } from '@hushbox/crypto';
import type { AppEnv, Bindings } from '../../lib/context/index.js';
import type { Telemetry, TelemetryEnv } from '../../lib/telemetry/index.js';
import type { RealtimeBroadcast } from './ports/realtime.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const UPSTASH_REDIS_REST_URL = process.env['UPSTASH_REDIS_REST_URL'];
const UPSTASH_REDIS_REST_TOKEN = process.env['UPSTASH_REDIS_REST_TOKEN'];
if (!DATABASE_URL || !UPSTASH_REDIS_REST_URL || !UPSTASH_REDIS_REST_TOKEN) {
  throw new Error('DATABASE_URL and UPSTASH_REDIS_* are required for epoch rotation tests');
}

const SECRET = 'secret-at-least-32-characters-long!!';

const testEnv: Bindings & TelemetryEnv = {
  NODE_ENV: 'development',
  DATABASE_URL,
  UPSTASH_REDIS_REST_URL,
  UPSTASH_REDIS_REST_TOKEN,
  IRON_SESSION_SECRET: SECRET,
  TELEMETRY_SINKS: 'console',
};

const db = createDb(DATABASE_URL, { neonDev: LOCAL_NEON_DEV_CONFIG });
const PLACEHOLDER = new Uint8Array([9, 9, 9]);
const createdUserIds: string[] = [];
const createdConversationIds: string[] = [];

afterAll(async () => {
  if (createdConversationIds.length > 0) {
    await db.delete(conversations).where(inArray(conversations.id, createdConversationIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
  await db.$client.end();
});

interface Principal {
  readonly userId: string;
  readonly cookie: string;
  readonly publicKey: Uint8Array;
  readonly privateKey: Uint8Array;
}

async function newPrincipal(keys = generateKeyPair()): Promise<Principal> {
  const username = `zz${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;
  const rows = await db
    .insert(users)
    .values(
      userFactory.build({
        email: `${username}@epoch-rotation.test`,
        username,
        opaqueRegistration: PLACEHOLDER,
        publicKey: keys.publicKey,
        passwordWrappedPrivateKey: PLACEHOLDER,
        recoveryWrappedPrivateKey: PLACEHOLDER,
        recoveryPublicKey: PLACEHOLDER,
      })
    )
    .returning({ id: users.id });
  const userId = rows[0]?.id;
  if (userId === undefined) throw new Error('user seed failed');
  createdUserIds.push(userId);
  const sealed = await sealData(
    {
      userId,
      sessionId: `session-${userId}`,
      createdAt: Date.now() - 1000,
      pending2FA: false,
      pending2FAExpiresAt: 0,
    },
    { password: SECRET }
  );
  return {
    userId,
    cookie: `${SESSION_COOKIE_NAME}=${sealed}`,
    publicKey: keys.publicKey,
    privateKey: keys.privateKey,
  };
}

const silentRealtime: RealtimeBroadcast = {
  broadcast: () => okAsync({ delivered: 0, paused: 0, evicted: 0 }),
  evict: () => okAsync(0),
  presence: () => okAsync([]),
  startRun: () => okAsync({ started: false, code: ERROR_CODES.CONFLICT }),
  stopRun: () => okAsync(false),
  upgrade: () => okAsync(new Response(null, { status: 200 })),
};

interface Capture {
  readonly error: Error;
  readonly errorCode: string;
}

/** The conversations and chat surfaces on one pipeline, with every capture recorded. */
function createApp(captures: Capture[]): Hono<AppEnv> {
  const conversationsManifest = createConversationsManifest({
    stores: createConversationsStores,
    billing: createBillingStores(),
    revoker: createMembershipRevoker,
    realtime: () => silentRealtime,
    deleteForkMessages: (writer) => (conversationId, ids) =>
      deleteForkMessagesWithinTx(writer, conversationId, ids),
    linkResolution: (writer) => createLinkResolutionAdapter(writer),
  });
  const chatManifest = createChatManifest({
    conversations: createConversationsStores,
    billing: createBillingStores(),
    realtime: () => silentRealtime,
    trialRoomName: (sessionId) => `trial:${sessionId}`,
    linkResolution: (writer) => createLinkResolutionAdapter(writer),
  });
  const app = applyPipeline(new Hono<AppEnv>());
  // After the pipeline, which binds `logger`, and before the routes.
  app.use(async (c, next) => {
    const logger = c.var.logger;
    const captureError: Telemetry['captureError'] = (error, errorCode) => {
      captures.push({ error, errorCode });
      logger.captureError(error, errorCode);
    };
    bindRequestValue(c, 'logger', { ...logger, captureError });
    await next();
  });
  app.route(conversationsManifest.basePath, conversationsManifest.routes);
  app.route(chatManifest.basePath, chatManifest.routes);
  return app;
}

interface EpochKey {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

/** One conversation under test, the app serving it, and the honest epoch keys minted so far. */
interface Group {
  readonly id: string;
  readonly app: Hono<AppEnv>;
  readonly captures: Capture[];
  readonly keys: Map<number, EpochKey>;
}

async function get(group: Pick<Group, 'app'>, path: string, cookie: string): Promise<Response> {
  return await group.app.request(path, { method: 'GET', headers: { cookie } }, testEnv);
}

async function post(
  group: Pick<Group, 'app'>,
  path: string,
  cookie: string,
  body: unknown
): Promise<Response> {
  return await group.app.request(
    path,
    {
      method: 'POST',
      headers: {
        cookie,
        'content-type': 'application/json',
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: JSON.stringify(body),
    },
    testEnv
  );
}

async function statusOf(pending: Promise<Response>): Promise<number> {
  const response = await pending;
  return response.status;
}

async function expectOk(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`expected 200, got ${String(response.status)}: ${JSON.stringify(body)}`);
  }
  return body;
}

function titleFor(group: Pick<Group, 'id'>, epochNumber: number, publicKey: Uint8Array): string {
  return toBase64(
    encryptTextForEpoch(publicKey, 'a title', { conversationId: group.id, epochNumber })
  );
}

/** A conversation created through the API with a real first epoch, the owner alone in it. */
async function createGroup(owner: Principal): Promise<Group> {
  const id = crypto.randomUUID();
  createdConversationIds.push(id);
  const captures: Capture[] = [];
  const group: Group = { id, app: createApp(captures), captures, keys: new Map() };
  const first = createFirstEpoch([owner.publicKey], id, 1);
  const wrap = first.memberWraps[0]?.wrap;
  if (wrap === undefined) throw new Error('first epoch minted no owner wrap');
  await expectOk(
    await post(group, '/conversations', owner.cookie, {
      id,
      title: titleFor(group, 1, first.epochPublicKey),
      epochPublicKey: toBase64(first.epochPublicKey),
      confirmationHash: toBase64(first.confirmationHash),
      memberWrap: toBase64(wrap),
    })
  );
  group.keys.set(1, { privateKey: first.epochPrivateKey, publicKey: first.epochPublicKey });
  return group;
}

function currentKey(group: Group, epochNumber: number): EpochKey {
  const key = group.keys.get(epochNumber);
  if (key === undefined) throw new Error(`no honest key for epoch ${String(epochNumber)}`);
  return key;
}

/** Seats `member` with a real bound wrap of the current epoch key and visibility from epoch 1. */
async function addWithFullHistory(
  group: Group,
  owner: Principal,
  member: Principal,
  epochNumber: number
): Promise<void> {
  const key = currentKey(group, epochNumber);
  const wrap = wrapEpochKeyForNewMember(key.privateKey, member.publicKey, {
    conversationId: group.id,
    epochNumber,
    epochPublicKey: key.publicKey,
  });
  await expectOk(
    await post(group, `/conversations/${group.id}/members`, owner.cookie, {
      userId: member.userId,
      privilege: 'write',
      giveFullHistory: true,
      expectedEpoch: epochNumber,
      wrap: toBase64(wrap),
    })
  );
}

const memberKeysSchema = z.object({ members: z.array(z.object({ publicKey: z.string() })) });

async function liveKeys(group: Group, caller: Principal): Promise<Uint8Array[]> {
  const body = memberKeysSchema.parse(
    await expectOk(await get(group, `/conversations/${group.id}/member-keys`, caller.cookie))
  );
  return body.members.map((member) => fromBase64(member.publicKey));
}

interface RotationBodyInput {
  readonly expectedEpoch: number;
  readonly epochPublicKey: Uint8Array;
  readonly confirmationHash: Uint8Array;
  readonly chainLink: Uint8Array;
  readonly memberWraps: readonly { memberPublicKey: Uint8Array; wrap: Uint8Array }[];
  readonly predecessorEpoch?: number;
}

function rotationBody(group: Group, input: RotationBodyInput): Record<string, unknown> {
  return {
    expectedEpoch: input.expectedEpoch,
    epochPublicKey: toBase64(input.epochPublicKey),
    confirmationHash: toBase64(input.confirmationHash),
    chainLink: toBase64(input.chainLink),
    memberWraps: input.memberWraps.map((wrap) => ({
      memberPublicKey: toBase64(wrap.memberPublicKey),
      wrap: toBase64(wrap.wrap),
    })),
    encryptedTitle: titleFor(group, input.expectedEpoch + 1, input.epochPublicKey),
    ...(input.predecessorEpoch === undefined ? {} : { predecessorEpoch: input.predecessorEpoch }),
  };
}

/** An honest rotation to `expectedEpoch + 1`, chained to `predecessor`, wrapped to `keys`. */
function honestRotation(
  group: Group,
  expectedEpoch: number,
  predecessor: number,
  keys: Uint8Array[]
): { readonly body: Record<string, unknown>; readonly key: EpochKey } {
  const older = currentKey(group, predecessor);
  const rotated = performEpochRotation({
    predecessor: { epochNumber: predecessor, ...older },
    memberPublicKeys: keys,
    conversationId: group.id,
    epochNumber: expectedEpoch + 1,
  });
  return {
    body: rotationBody(group, {
      expectedEpoch,
      epochPublicKey: rotated.epochPublicKey,
      confirmationHash: rotated.confirmationHash,
      chainLink: rotated.chainLink,
      memberWraps: rotated.memberWraps,
      ...(predecessor === expectedEpoch ? {} : { predecessorEpoch: predecessor }),
    }),
    key: { privateKey: rotated.epochPrivateKey, publicKey: rotated.epochPublicKey },
  };
}

const rotateOutcomeSchema = z.union([
  z.object({ rotated: z.literal(true), newEpochNumber: z.number() }),
  z.object({ rotated: z.literal(false), currentEpoch: z.number() }),
]);

async function postEpochs(
  group: Group,
  caller: Principal,
  body: Record<string, unknown>
): Promise<Response> {
  return await post(group, `/conversations/${group.id}/epochs`, caller.cookie, body);
}

/** Rotates honestly as `caller` and records the new epoch key. */
async function rotate(
  group: Group,
  caller: Principal,
  expectedEpoch: number,
  predecessor = expectedEpoch
): Promise<number> {
  const { body, key } = honestRotation(
    group,
    expectedEpoch,
    predecessor,
    await liveKeys(group, caller)
  );
  const outcome = rotateOutcomeSchema.parse(await expectOk(await postEpochs(group, caller, body)));
  if (!outcome.rotated) throw new Error('the honest rotation was answered as already done');
  group.keys.set(outcome.newEpochNumber, key);
  return outcome.newEpochNumber;
}

async function leave(group: Group, member: Principal): Promise<Response> {
  return await post(group, `/conversations/${group.id}/leave`, member.cookie, {});
}

async function keyChain(group: Group, caller: Principal): Promise<KeyChainResponse> {
  return keyChainResponseSchema.parse(
    await expectOk(await get(group, `/conversations/${group.id}/keychain`, caller.cookie))
  );
}

const sentSchema = z.object({ messageId: z.string() });

async function sendMessage(group: Group, sender: Principal, content: string): Promise<Response> {
  return await post(group, `/chat/${group.id}/message`, sender.cookie, { content });
}

async function sendOk(group: Group, sender: Principal, content: string): Promise<string> {
  return sentSchema.parse(await expectOk(await sendMessage(group, sender, content))).messageId;
}

/** Opens a stored user-only message with an epoch key the verifier yielded. */
async function readMessage(
  group: Group,
  messageId: string,
  sender: Principal,
  epochKey: Uint8Array
): Promise<string> {
  const [message] = await db.select().from(messages).where(eq(messages.id, messageId));
  const [item] = await db.select().from(contentItems).where(eq(contentItems.messageId, messageId));
  const blob = item?.encryptedBlob ?? null;
  if (message === undefined || item === undefined || blob === null) {
    throw new Error('message missing');
  }
  // Stored bytes are the wrap the server minted; the brand is how the package names them.
  const wrapped = message.wrappedContentKey as WrappedSecret;
  const contentKey = unwrapContentKeyFromEpoch(asEpochPrivateKey(epochKey), wrapped);
  const plaintext = decryptContentEnvelope(
    contentKey,
    wrapped,
    {
      conversationId: group.id,
      messageId,
      contentItemId: item.id,
      position: 0,
      epochNumber: message.epochNumber,
      senderId: sender.userId,
    },
    blob
  );
  return new TextDecoder().decode(plaintext);
}

interface WrapRow {
  readonly conversationId: string;
  readonly epochNumber: number;
  readonly memberPublicKey: string;
  readonly visibleFromEpoch: number;
  readonly wrap: Uint8Array;
}

/** Every stored wrap of the given conversations, with the epoch number it belongs to. */
async function wrapRows(conversationIds: string[]): Promise<WrapRow[]> {
  const rows = await db
    .select({
      conversationId: epochs.conversationId,
      epochNumber: epochs.epochNumber,
      memberPublicKey: epochMembers.memberPublicKey,
      visibleFromEpoch: epochMembers.visibleFromEpoch,
      wrap: epochMembers.wrap,
    })
    .from(epochMembers)
    .innerJoin(epochs, eq(epochs.id, epochMembers.epochId))
    .where(inArray(epochs.conversationId, conversationIds));
  return rows.map((row) => ({ ...row, memberPublicKey: toBase64(row.memberPublicKey) }));
}

function wrapsOf(rows: WrapRow[], key: Uint8Array): WrapRow[] {
  return rows.filter((row) => row.memberPublicKey === toBase64(key));
}

async function currentEpochOf(group: Group): Promise<number | undefined> {
  const [row] = await db.select().from(conversations).where(eq(conversations.id, group.id));
  return row?.currentEpoch;
}

/** Owner A with members B, C and D, one message written at epoch 1, then D leaves: pending. */
async function pendingGroupOfFour(): Promise<{
  readonly group: Group;
  readonly a: Principal;
  readonly b: Principal;
  readonly c: Principal;
  readonly beforeAttack: string;
}> {
  const [a, b, c, d] = await Promise.all([
    newPrincipal(),
    newPrincipal(),
    newPrincipal(),
    newPrincipal(),
  ]);
  const group = await createGroup(a);
  for (const member of [b, c, d]) await addWithFullHistory(group, a, member, 1);
  const beforeAttack = await sendOk(group, a, 'written before the attack');
  expect(await statusOf(leave(group, d))).toBe(200);
  return { group, a, b, c, beforeAttack };
}

/**
 * The hostile member's rotation to epoch 2: a key whose confirmation is its
 * own, wrapped to every live seat, but published under another key's public
 * key, with a chain link that honestly opens to epoch 1.
 */
async function publicKeyMismatchRotation(group: Group, hostile: Principal): Promise<void> {
  const keys = await liveKeys(group, hostile);
  const bad = performEpochRotation({
    predecessor: { epochNumber: 1, ...currentKey(group, 1) },
    memberPublicKeys: keys,
    conversationId: group.id,
    epochNumber: 2,
  });
  const other = generateKeyPair();
  const location = { conversationId: group.id, epochNumber: 2, epochPublicKey: other.publicKey };
  const body = rotationBody(group, {
    expectedEpoch: 1,
    epochPublicKey: other.publicKey,
    confirmationHash: bad.confirmationHash,
    chainLink: bad.chainLink,
    memberWraps: keys.map((memberPublicKey) => ({
      memberPublicKey,
      wrap: wrapEpochKeyForNewMember(bad.epochPrivateKey, memberPublicKey, location),
    })),
  });
  expect(await statusOf(postEpochs(group, hostile, body))).toBe(200);
}

function randomBytes(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(64));
}

describe('a departure pends until a remaining member rotates it out', () => {
  it('leaves nothing for the departed member to open after the rotation', async () => {
    const [a, b, c] = await Promise.all([newPrincipal(), newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    await addWithFullHistory(group, a, b, 1);
    await addWithFullHistory(group, a, c, 1);

    const left = await leave(group, b);
    expect(left.status).toBe(200);
    expect(await currentEpochOf(group)).toBe(1);
    const pendingChain = await keyChain(group, a);
    expect(pendingChain.rotationPending).toBe(true);

    const refused = await sendMessage(group, a, 'into the pending epoch');
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ code: ERROR_CODES.ROTATION_PENDING });
    expect(await db.select().from(messages).where(eq(messages.conversationId, group.id))).toEqual(
      []
    );

    const epochOneBefore = await wrapRows([group.id]);
    expect(await rotate(group, a, 1)).toBe(2);

    const after = await wrapRows([group.id]);
    expect(wrapsOf(after, b.publicKey)).toEqual([]);
    const epochTwo = after.filter((row) => row.epochNumber === 2);
    expect(new Set(epochTwo.map((row) => row.memberPublicKey))).toEqual(
      new Set([toBase64(a.publicKey), toBase64(c.publicKey)])
    );
    for (const holder of [a, c]) {
      expect(wrapsOf(after, holder.publicKey).filter((row) => row.epochNumber === 1)).toEqual(
        wrapsOf(epochOneBefore, holder.publicKey)
      );
    }
    const epochTwoKey = currentKey(group, 2);
    const [epochTwoRow] = await db
      .select()
      .from(epochs)
      .where(and(eq(epochs.conversationId, group.id), eq(epochs.epochNumber, 2)));
    if (epochTwoRow === undefined) throw new Error('epoch 2 missing');
    for (const row of epochTwo) {
      const opened = openEpochWrap(b.privateKey, row.wrap, {
        conversationId: group.id,
        epochNumber: 2,
        epochPublicKey: epochTwoKey.publicKey,
        confirmationHash: epochTwoRow.confirmationHash,
      });
      expect(opened.ok).toBe(false);
    }
    expect(await statusOf(get(group, `/conversations/${group.id}/keychain`, b.cookie))).toBe(404);

    const messageId = await sendOk(group, a, 'after the rotation');
    const [persisted] = await db.select().from(messages).where(eq(messages.id, messageId));
    expect(persisted?.epochNumber).toBe(2);
  });
});

describe('a bad rotation is detected as bad, not as a missing key', () => {
  it('reports a key published under another public key as a public-key mismatch', async () => {
    const { group, a, b, c } = await pendingGroupOfFour();
    await publicKeyMismatchRotation(group, b);

    for (const member of [a, c]) {
      const verdict = verifyKeyChain(await keyChain(group, member), member.privateKey, group.id);
      expect(verdict.epochs.get(2)?.key).toEqual({
        status: 'bad',
        reason: 'public-key-mismatch',
      });
      expect(verdict.epochs.get(1)?.key).toEqual({ status: 'ok' });
      expect(verdict.rotation).toBe('bad');
      expect(verdict.lastGoodEpoch).toBe(1);
    }
  });

  it('reports wraps of random bytes as unwrap failures', async () => {
    const { group, a, b } = await pendingGroupOfFour();
    const keys = await liveKeys(group, b);
    const honest = honestRotation(group, 1, 1, keys);
    const junk = {
      ...honest.body,
      memberWraps: keys.map((key) => ({
        memberPublicKey: toBase64(key),
        wrap: toBase64(randomBytes()),
      })),
    };
    expect(await statusOf(postEpochs(group, b, junk))).toBe(200);

    const verdict = verifyKeyChain(await keyChain(group, a), a.privateKey, group.id);
    expect(verdict.epochs.get(2)?.key).toEqual({ status: 'bad', reason: 'unwrap-failed' });
    expect(verdict.rotation).toBe('bad');
    expect(verdict.lastGoodEpoch).toBe(1);
  });

  it('reports a junk chain link as a bad link on an honestly keyed epoch', async () => {
    const { group, a, b } = await pendingGroupOfFour();
    const honest = honestRotation(group, 1, 1, await liveKeys(group, b));
    const junk = { ...honest.body, chainLink: toBase64(randomBytes()) };
    expect(await statusOf(postEpochs(group, b, junk))).toBe(200);

    const verdict = verifyKeyChain(await keyChain(group, a), a.privateKey, group.id);
    expect(verdict.epochs.get(2)).toEqual({ key: { status: 'ok' }, link: 'bad' });
    expect(verdict.rotation).toBe('bad');
    expect(verdict.lastGoodEpoch).toBe(1);
  });
});

describe('recovery from the last good epoch', () => {
  it('restores readability for members, a reload and a later full-history joiner', async () => {
    const { group, a, b, c, beforeAttack } = await pendingGroupOfFour();
    await publicKeyMismatchRotation(group, b);
    expect(await rotate(group, a, 2, 1)).toBe(3);

    const verdict = verifyKeyChain(await keyChain(group, c), c.privateKey, group.id);
    expect(verdict.epochs.get(3)).toEqual({ key: { status: 'ok' }, link: 'ok' });
    expect(verdict.epochs.get(1)?.key).toEqual({ status: 'ok' });
    expect(verdict.epochs.get(2)?.key.status).not.toBe('ok');
    expect(verdict.rotation).toBe('ok');
    const cWraps = wrapsOf(await wrapRows([group.id]), c.publicKey);
    expect(cWraps.map((row) => row.epochNumber).toSorted(ascending)).toEqual([1, 2, 3]);
    const epochOne = verdict.keys.get(1);
    if (epochOne === undefined) throw new Error('no verified epoch 1 key');
    expect(await readMessage(group, beforeAttack, a, epochOne)).toBe('written before the attack');

    const e = await newPrincipal();
    await addWithFullHistory(group, a, e, 3);
    expect(wrapsOf(await wrapRows([group.id]), e.publicKey).map((row) => row.epochNumber)).toEqual([
      3,
    ]);
    const joiner = verifyKeyChain(await keyChain(group, e), e.privateKey, group.id);
    expect(joiner.rotation).toBe('ok');
    const joinerEpochOne = joiner.keys.get(1);
    if (joinerEpochOne === undefined) throw new Error('the joiner reached no epoch 1 key');
    expect(await readMessage(group, beforeAttack, a, joinerEpochOne)).toBe(
      'written before the attack'
    );

    const superseded = group.captures.filter(
      (capture) => capture.errorCode === 'epoch_rotation_superseded'
    );
    expect(superseded).toHaveLength(1);
  });

  it('reports the superseded epoch to Sentry by its identifiers alone', async () => {
    const { group, a, b } = await pendingGroupOfFour();
    await publicKeyMismatchRotation(group, b);
    expect(await rotate(group, a, 2, 1)).toBe(3);

    const [capture] = group.captures;
    const error = capture?.error ?? new Error('nothing captured');
    // The whole key set, not a lookup of the expected ones: a second property
    // arriving on this error would meet only the scrub's allowlist.
    expect(Object.keys(error)).toEqual([
      'name',
      'conversationId',
      'supersededEpoch',
      'predecessorEpoch',
    ]);
    expect(error.name).toBe('EpochRotationSuperseded');
    expect(Reflect.get(error, 'conversationId')).toBe(group.id);
    expect(Reflect.get(error, 'supersededEpoch')).toBe(2);
    expect(Reflect.get(error, 'predecessorEpoch')).toBe(1);
    const scrubbed = scrubSentryEvent(
      { type: undefined, tags: { errorCode: 'epoch_rotation_superseded' } },
      { originalException: error }
    );
    expect(scrubbed?.tags).toEqual({
      errorCode: 'epoch_rotation_superseded',
      conversationId: group.id,
      supersededEpoch: 2,
      predecessorEpoch: 1,
    });
  });

  it('cannot be turned against a live seat: a junk recovery deletes no member wrap', async () => {
    const { group, a, b, c } = await pendingGroupOfFour();
    await publicKeyMismatchRotation(group, b);
    expect(await rotate(group, a, 2, 1)).toBe(3);
    const before = await wrapRows([group.id]);

    const keys = await liveKeys(group, b);
    const junk = rotationBody(group, {
      expectedEpoch: 3,
      predecessorEpoch: 1,
      epochPublicKey: generateKeyPair().publicKey,
      confirmationHash: randomBytes(),
      chainLink: randomBytes(),
      memberWraps: keys.map((memberPublicKey) => ({ memberPublicKey, wrap: randomBytes() })),
    });
    expect(await statusOf(postEpochs(group, b, junk))).toBe(200);

    const after = await wrapRows([group.id]);
    for (const member of [a, c]) {
      expect(wrapsOf(after, member.publicKey)).toHaveLength(
        wrapsOf(before, member.publicKey).length + 1
      );
    }
    const verdict = verifyKeyChain(await keyChain(group, c), c.privateKey, group.id);
    expect(verdict.rotation).toBe('bad');
    expect(verdict.lastGoodEpoch).toBe(3);

    expect(await rotate(group, a, 4, 3)).toBe(5);
    expect(verifyKeyChain(await keyChain(group, c), c.privateKey, group.id).rotation).toBe('ok');
  });
});

describe('the rotate route gates', () => {
  it('refuses a predecessor at or above the current epoch as a validation error', async () => {
    const a = await newPrincipal();
    const group = await createGroup(a);
    const { body } = honestRotation(group, 1, 1, await liveKeys(group, a));
    const res = await postEpochs(group, a, { ...body, predecessorEpoch: 1 });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.VALIDATION });
  });

  it('forbids a recovery from a caller holding no wrap in the predecessor', async () => {
    const [a, f] = await Promise.all([newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    await addWithRotation(group, a, f);
    const { body } = honestRotation(group, 2, 1, await liveKeys(group, f));
    const res = await postEpochs(group, f, body);
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ code: ERROR_CODES.FORBIDDEN });
    expect(await currentEpochOf(group)).toBe(2);
    // The control: the owner, who holds an epoch-1 wrap, may recover from it.
    expect(await rotate(group, a, 2, 1)).toBe(3);
  });

  it('answers a maintenance rotation of a conversation with nothing pending as already done', async () => {
    const a = await newPrincipal();
    const group = await createGroup(a);
    const { body } = honestRotation(group, 1, 1, await liveKeys(group, a));
    const res = await postEpochs(group, a, body);
    expect(await expectOk(res)).toEqual({ rotated: false, currentEpoch: 1 });
    expect(await currentEpochOf(group)).toBe(1);
  });

  it('answers a stale maintenance rotation as already done once another member rotated', async () => {
    const [a, b, c] = await Promise.all([newPrincipal(), newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    await addWithFullHistory(group, a, b, 1);
    await addWithFullHistory(group, a, c, 1);
    const late = honestRotation(group, 1, 1, [a.publicKey, c.publicKey]);
    expect(await statusOf(leave(group, b))).toBe(200);
    await rotate(group, a, 1);

    const res = await postEpochs(group, c, late.body);
    expect(await expectOk(res)).toEqual({ rotated: false, currentEpoch: 2 });
  });

  it('refuses a stale maintenance rotation while a later departure is still pending', async () => {
    const [a, b, c] = await Promise.all([newPrincipal(), newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    await addWithFullHistory(group, a, b, 1);
    await addWithFullHistory(group, a, c, 1);
    const late = honestRotation(group, 1, 1, [a.publicKey]);
    expect(await statusOf(leave(group, b))).toBe(200);
    await rotate(group, a, 1);
    expect(await statusOf(leave(group, c))).toBe(200);

    const res = await postEpochs(group, a, late.body);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch: 2 },
    });
  });

  it('answers a link guest with 401, because the route admits sessions only', async () => {
    const a = await newPrincipal();
    const group = await createGroup(a);
    const { linkPublicKey, linkAuthHash, token } = mintLinkCredential();
    const [link] = await db
      .insert(sharedLinks)
      .values({ conversationId: group.id, linkPublicKey, linkAuthHash })
      .returning({ id: sharedLinks.id });
    if (link === undefined) throw new Error('link seed failed');
    await db.insert(conversationMembers).values({
      conversationId: group.id,
      linkId: link.id,
      privilege: 'write',
      visibleFromEpoch: 1,
    });
    const { body } = honestRotation(group, 1, 1, [a.publicKey, linkPublicKey]);
    const res = await group.app.request(
      `/conversations/${group.id}/epochs`,
      {
        method: 'POST',
        headers: {
          [LINK_CREDENTIAL_HEADER]: token,
          'content-type': 'application/json',
          'Idempotency-Key': crypto.randomUUID(),
        },
        body: JSON.stringify(body),
      },
      testEnv
    );
    expect(res.status).toBe(401);
    expect(await currentEpochOf(group)).toBe(1);
  });

  it('refuses a wrap set that still seats the departed key', async () => {
    const [a, b] = await Promise.all([newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    await addWithFullHistory(group, a, b, 1);
    expect(await statusOf(leave(group, b))).toBe(200);
    const { body } = honestRotation(group, 1, 1, [a.publicKey, b.publicKey]);
    const res = await postEpochs(group, a, body);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ code: ERROR_CODES.WRAP_SET_MISMATCH });
    expect(await currentEpochOf(group)).toBe(1);
  });

  it('refuses a stale recovery with the current epoch', async () => {
    const [a, b] = await Promise.all([newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    await addWithRotation(group, a, b);
    const stale = honestRotation(group, 1, 1, await liveKeys(group, a));
    const res = await postEpochs(group, a, { ...stale.body, predecessorEpoch: 1 });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      code: ERROR_CODES.STALE_EPOCH,
      details: { currentEpoch: 2 },
    });
  });

  it('answers not-found for a conversation that does not exist', async () => {
    const a = await newPrincipal();
    const group = await createGroup(a);
    const { body } = honestRotation(group, 1, 1, [a.publicKey]);
    const res = await post(group, `/conversations/${crypto.randomUUID()}/epochs`, a.cookie, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });

  it('hides the conversation from a caller who is not an active member', async () => {
    const [a, outsider] = await Promise.all([newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    const { body } = honestRotation(group, 1, 1, [a.publicKey]);
    const res = await postEpochs(group, outsider, body);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ code: ERROR_CODES.NOT_FOUND });
  });
});

/** Seats `member` through a rotation, so their visibility floor is the new epoch. */
async function addWithRotation(group: Group, owner: Principal, member: Principal): Promise<void> {
  const current = (await currentEpochOf(group)) ?? 1;
  const { body, key } = honestRotation(group, current, current, [
    ...(await liveKeys(group, owner)),
    member.publicKey,
  ]);
  await expectOk(
    await post(group, `/conversations/${group.id}/members`, owner.cookie, {
      userId: member.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: body,
    })
  );
  group.keys.set(current + 1, key);
}

describe('floor safety', () => {
  it('withholds a skip link reaching below a member floor', async () => {
    const [a, f] = await Promise.all([newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    await addWithRotation(group, a, f);
    expect(await rotate(group, a, 2, 1)).toBe(3);

    const floored = await keyChain(group, f);
    const epochThree = floored.epochs.find((epoch) => epoch.epochNumber === 3);
    expect(epochThree).toMatchObject({ previousEpochNumber: 1, chainLink: null });
    const ownersChain = await keyChain(group, a);
    const owners = ownersChain.epochs.find((epoch) => epoch.epochNumber === 3);
    expect(owners?.chainLink).toEqual(expect.any(String));
  });
});

/** A second conversation `holder` owns, where their key holds wraps in two epochs. */
async function secondConversationOf(holder: Principal): Promise<Group> {
  const other = await createGroup(holder);
  await addWithRotation(other, holder, await newPrincipal());
  return other;
}

const byEpoch = (x: WrapRow, y: WrapRow): number => x.epochNumber - y.epochNumber;
const ascending = (x: number, y: number): number => x - y;

describe('re-seat hygiene', () => {
  it('drops every wrap of a leaver on the next rotation and nothing in another conversation', async () => {
    const [a, b, c] = await Promise.all([newPrincipal(), newPrincipal(), newPrincipal()]);
    const other = await secondConversationOf(b);
    const group = await createGroup(a);
    await addWithFullHistory(group, a, b, 1);
    await addWithRotation(group, a, c);
    const seeded = wrapsOf(await wrapRows([group.id]), b.publicKey);
    expect(seeded.map((row) => row.epochNumber).toSorted(ascending)).toEqual([1, 2]);
    const elsewhere = wrapsOf(await wrapRows([other.id]), b.publicKey);
    expect(elsewhere).toHaveLength(2);

    expect(await statusOf(leave(group, b))).toBe(200);
    expect(await rotate(group, a, 2)).toBe(3);

    expect(wrapsOf(await wrapRows([group.id]), b.publicKey)).toEqual([]);
    expect(wrapsOf(await wrapRows([other.id]), b.publicKey)).toEqual(elsewhere);
  });

  it('re-adds a departed key with full history from epoch 1, not its stale floor', async () => {
    const [a, x, y] = await Promise.all([newPrincipal(), newPrincipal(), newPrincipal()]);
    const other = await secondConversationOf(x);
    const group = await createGroup(a);
    await addWithRotation(group, a, x);
    await addWithRotation(group, a, y);
    const seeded = wrapsOf(await wrapRows([group.id]), x.publicKey).toSorted(byEpoch);
    expect(seeded.map((row) => [row.epochNumber, row.visibleFromEpoch])).toEqual([
      [2, 2],
      [3, 2],
    ]);
    const elsewhere = wrapsOf(await wrapRows([other.id]), x.publicKey);
    expect(elsewhere).toHaveLength(2);
    expect(await statusOf(leave(group, x))).toBe(200);

    await addWithFullHistory(group, a, x, 3);

    const reseated = wrapsOf(await wrapRows([group.id]), x.publicKey);
    expect(reseated.map((row) => [row.epochNumber, row.visibleFromEpoch])).toEqual([[3, 1]]);
    const reseatedChain = await keyChain(group, x);
    expect(reseatedChain.epochs.map((epoch) => epoch.epochNumber)).toEqual([1, 2, 3]);
    expect(wrapsOf(await wrapRows([other.id]), x.publicKey)).toEqual(elsewhere);
  });

  it('mints a full-history link over stale wraps of its key as a fresh seat from epoch 1', async () => {
    const [a, f, o] = await Promise.all([newPrincipal(), newPrincipal(), newPrincipal()]);
    const group = await createGroup(a);
    await addWithRotation(group, a, f);
    const other = await secondConversationOf(o);
    const { linkPublicKey, linkAuthHash } = mintLinkCredential();
    await seedStaleWraps(group.id, linkPublicKey, [1, 2]);
    await seedStaleWraps(other.id, linkPublicKey, [1, 2]);
    const elsewhere = wrapsOf(await wrapRows([other.id]), linkPublicKey);
    expect(elsewhere).toHaveLength(2);

    const key = currentKey(group, 2);
    const minted = await createSharedLink(createConversationsStores(db), {
      conversationId: group.id,
      callerUserId: a.userId,
      linkPublicKey: toBase64(linkPublicKey),
      linkAuthHash: toBase64(linkAuthHash),
      displayName: null,
      expiresAt: null,
      privilege: 'read',
      giveFullHistory: true,
      expectedEpoch: 2,
      memberWrap: toBase64(
        wrapEpochKeyForNewMember(key.privateKey, linkPublicKey, {
          conversationId: group.id,
          epochNumber: 2,
          epochPublicKey: key.publicKey,
        })
      ),
    });
    expect(minted._unsafeUnwrap()).toMatchObject({ created: true });

    const reseated = wrapsOf(await wrapRows([group.id]), linkPublicKey);
    expect(reseated.map((row) => [row.epochNumber, row.visibleFromEpoch])).toEqual([[2, 1]]);
    expect(wrapsOf(await wrapRows([other.id]), linkPublicKey)).toEqual(elsewhere);
  });
});

/**
 * Owner A, member C, and victim B, whose key holds wraps at epochs 1 and 2 here
 * and two more in a conversation B owns: the reach a colliding seat would hit.
 */
async function liveVictim(): Promise<{
  readonly group: Group;
  readonly other: Group;
  readonly a: Principal;
  readonly b: Principal;
  readonly before: WrapRow[];
}> {
  const [a, b, c] = await Promise.all([newPrincipal(), newPrincipal(), newPrincipal()]);
  const other = await secondConversationOf(b);
  const group = await createGroup(a);
  await addWithFullHistory(group, a, b, 1);
  await addWithRotation(group, a, c);
  const before = await victimWraps(group, other, b);
  expect(before.map((row) => [row.conversationId === group.id, row.epochNumber])).toEqual([
    [true, 1],
    [true, 2],
    [false, 1],
    [false, 2],
  ]);
  return { group, other, a, b, before };
}

/** Every wrap of `victim`'s key in both conversations, in a stable order. */
async function victimWraps(group: Group, other: Group, victim: Principal): Promise<WrapRow[]> {
  const elsewhere = (row: WrapRow): number => Number(row.conversationId !== group.id);
  return wrapsOf(await wrapRows([group.id, other.id]), victim.publicKey).toSorted(
    (x, y) => elsewhere(x) - elsewhere(y) || byEpoch(x, y)
  );
}

/** Every member row `principal` holds in the conversation, left or not. */
async function seatsOf(group: Group, principal: Principal): Promise<{ id: string }[]> {
  return await db
    .select({ id: conversationMembers.id })
    .from(conversationMembers)
    .where(
      and(
        eq(conversationMembers.conversationId, group.id),
        eq(conversationMembers.userId, principal.userId)
      )
    );
}

/** A full-history wrap of epoch 2's key to `publicKey`. */
function epochTwoWrap(group: Group, publicKey: Uint8Array): Uint8Array {
  const key = currentKey(group, 2);
  return wrapEpochKeyForNewMember(key.privateKey, publicKey, {
    conversationId: group.id,
    epochNumber: 2,
    epochPublicKey: key.publicKey,
  });
}

describe('a seat never takes a key a live seat holds', () => {
  it('refuses a full-history link mint of a live member key, and every wrap of that key survives', async () => {
    const { group, other, a, b, before } = await liveVictim();

    const minted = await createSharedLink(createConversationsStores(db), {
      conversationId: group.id,
      callerUserId: a.userId,
      linkPublicKey: toBase64(b.publicKey),
      linkAuthHash: toBase64(mintLinkCredential().linkAuthHash),
      displayName: null,
      expiresAt: null,
      privilege: 'read',
      giveFullHistory: true,
      expectedEpoch: 2,
      memberWrap: toBase64(epochTwoWrap(group, b.publicKey)),
    });

    expect(minted._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
    expect(await victimWraps(group, other, b)).toEqual(before);
  });

  it('refuses a rotation link mint of a live member key, and every wrap of that key survives', async () => {
    const { group, other, a, b, before } = await liveVictim();
    const { body } = honestRotation(group, 2, 2, await liveKeys(group, a));

    const minted = await createSharedLink(createConversationsStores(db), {
      conversationId: group.id,
      callerUserId: a.userId,
      linkPublicKey: toBase64(b.publicKey),
      linkAuthHash: toBase64(mintLinkCredential().linkAuthHash),
      displayName: null,
      expiresAt: null,
      privilege: 'read',
      giveFullHistory: false,
      rotation: rotationBodySchema.parse(body),
    });

    expect(minted._unsafeUnwrap()).toEqual({ refusal: 'conflict' });
    expect(await victimWraps(group, other, b)).toEqual(before);
    expect(await currentEpochOf(group)).toBe(2);
  });

  it('refuses a full-history add of an account carrying a live member key, and every wrap survives', async () => {
    const { group, other, a, b, before } = await liveVictim();
    const twin = await newPrincipal({ publicKey: b.publicKey, privateKey: b.privateKey });

    const res = await post(group, `/conversations/${group.id}/members`, a.cookie, {
      userId: twin.userId,
      privilege: 'write',
      giveFullHistory: true,
      expectedEpoch: 2,
      wrap: toBase64(epochTwoWrap(group, twin.publicKey)),
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
    expect(await victimWraps(group, other, b)).toEqual(before);
    expect(await seatsOf(group, twin)).toEqual([]);
  });

  it('refuses a rotation add of an account carrying a live member key, and every wrap survives', async () => {
    const { group, other, a, b, before } = await liveVictim();
    const twin = await newPrincipal({ publicKey: b.publicKey, privateKey: b.privateKey });
    const { body } = honestRotation(group, 2, 2, await liveKeys(group, a));

    const res = await post(group, `/conversations/${group.id}/members`, a.cookie, {
      userId: twin.userId,
      privilege: 'write',
      giveFullHistory: false,
      rotation: body,
    });

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ code: ERROR_CODES.CONFLICT });
    expect(await victimWraps(group, other, b)).toEqual(before);
    expect(await seatsOf(group, twin)).toEqual([]);
    expect(await currentEpochOf(group)).toBe(2);
  });
});

/** Stale wraps of `key` written straight into the named epochs, floored at the highest one. */
async function seedStaleWraps(
  conversationId: string,
  key: Uint8Array,
  epochNumbers: number[]
): Promise<void> {
  const rows = await db
    .select({ id: epochs.id, epochNumber: epochs.epochNumber })
    .from(epochs)
    .where(
      and(eq(epochs.conversationId, conversationId), inArray(epochs.epochNumber, epochNumbers))
    );
  if (rows.length !== epochNumbers.length) throw new Error('an epoch to seed is missing');
  await db.insert(epochMembers).values(
    rows.map((row) => ({
      epochId: row.id,
      memberPublicKey: key,
      wrap: randomBytes(),
      visibleFromEpoch: Math.max(...epochNumbers),
    }))
  );
}
