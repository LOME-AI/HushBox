import { describe, it, expect, beforeAll } from 'vitest';
import { testUuidV7 } from '@hushbox/shared/test-time';
import {
  PUSH_CAPTURE_LIMIT,
  createPushSenderFromEnv,
  listCapturedPushes,
} from './push-sender-factory.js';
import { createCollapseAliasDeriver } from './collapse-alias.js';
import type { PushMessage } from '../ports/index.js';

const TAG_SECRET = 'test-collapse-alias-key';

let serviceAccountJson: string;

beforeAll(async () => {
  const keyPair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify']
  );
  const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
  const bytes = new Uint8Array(pkcs8);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  const lines = btoa(binary).match(/.{1,64}/g) ?? [];
  const pem = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----`; // gitleaks:allow
  serviceAccountJson = JSON.stringify({ client_email: 'svc@test.iam', private_key: pem });
});

const productionEnv = {
  NODE_ENV: 'production',
  NOTIFICATION_TAG_SECRET: TAG_SECRET,
  FCM_PROJECT_ID: 'hushbox-prod',
  FCM_SERVICE_ACCOUNT_JSON: '',
  VAPID_PUBLIC_KEY: 'vapid-public',
  VAPID_PRIVATE_KEY: 'vapid-private',
  VAPID_SUBJECT: 'mailto:test@hushbox.ai',
};

const CONVERSATION_ID = testUuidV7(1);

const conversationMessage: PushMessage = {
  recipients: [{ platform: 'ios', userId: 'u1', token: 'tok-1' }],
  payload: { category: 'message', conversationId: CONVERSATION_ID },
};

const emptyMessage: PushMessage = {
  recipients: [],
  payload: { category: 'message', conversationId: CONVERSATION_ID },
};

describe('createPushSenderFromEnv', () => {
  it('fails fast when NODE_ENV is unset', () => {
    expect(() => createPushSenderFromEnv({})).toThrow(/NODE_ENV/);
  });

  it('fails fast when the collapse-alias secret is unset', () => {
    expect(() => createPushSenderFromEnv({ NODE_ENV: 'development' })).toThrow(
      /NOTIFICATION_TAG_SECRET/
    );
  });

  it('backs the composite with the mock in local dev', async () => {
    const sender = createPushSenderFromEnv({
      NODE_ENV: 'development',
      NOTIFICATION_TAG_SECRET: TAG_SECRET,
    });

    // The mock reports every native target delivered; no network is touched.
    const result = await sender.send(conversationMessage);
    expect(result._unsafeUnwrap().successCount).toBe(1);
  });

  it('backs the composite with the mock in CI', async () => {
    const sender = createPushSenderFromEnv({
      NODE_ENV: 'development',
      CI: 'true',
      NOTIFICATION_TAG_SECRET: TAG_SECRET,
    });

    const result = await sender.send(conversationMessage);
    expect(result._unsafeUnwrap().successCount).toBe(1);
  });

  it('captures every mock-delivered send with the composite-derived collapse alias', async () => {
    const sender = createPushSenderFromEnv({
      NODE_ENV: 'development',
      NOTIFICATION_TAG_SECRET: TAG_SECRET,
    });

    const sent = await sender.send(conversationMessage);
    expect(sent.isOk()).toBe(true);

    // Read from the end: the log is bounded and shared across this file's
    // tests, so an absolute index into it is not stable.
    const captured = listCapturedPushes().at(-1);
    const expectedAlias = await createCollapseAliasDeriver(TAG_SECRET)(CONVERSATION_ID);
    expect(captured?.message.collapseKey).toBe(expectedAlias);
    expect(captured?.message.payload).toEqual(conversationMessage.payload);
  });

  it('captures each platform partition of a mixed send separately', async () => {
    const sender = createPushSenderFromEnv({
      NODE_ENV: 'development',
      NOTIFICATION_TAG_SECRET: TAG_SECRET,
    });

    const sent = await sender.send({
      ...conversationMessage,
      recipients: [
        { platform: 'android', userId: 'u1', token: 'tok-1' },
        {
          platform: 'web',
          userId: 'u2',
          endpoint: 'https://push.test/endpoint',
          p256dh: 'key',
          auth: 'auth',
        },
      ],
    });
    expect(sent.isOk()).toBe(true);

    const platforms = listCapturedPushes()
      .slice(-2)
      .map((entry) => entry.message.recipients.map((recipient) => recipient.platform));
    expect(platforms).toEqual([['android'], ['web']]);
  });

  it('captures nothing when the real transports are selected', async () => {
    const sender = createPushSenderFromEnv({
      ...productionEnv,
      FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson,
    });
    const before = listCapturedPushes();

    const sent = await sender.send(emptyMessage);
    expect(sent.isOk()).toBe(true);

    expect(listCapturedPushes()).toEqual(before);
  });

  it('fails fast in production without FCM credentials', () => {
    expect(() =>
      createPushSenderFromEnv({ NODE_ENV: 'production', NOTIFICATION_TAG_SECRET: TAG_SECRET })
    ).toThrow(/FCM_PROJECT_ID/);
  });

  it('fails fast in production without VAPID keys', () => {
    expect(() =>
      createPushSenderFromEnv({
        NODE_ENV: 'production',
        NOTIFICATION_TAG_SECRET: TAG_SECRET,
        FCM_PROJECT_ID: 'hushbox-prod',
        FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson,
      })
    ).toThrow(/VAPID/);
  });

  it('constructs the real composite in production with all credentials', async () => {
    const sender = createPushSenderFromEnv({
      ...productionEnv,
      FCM_SERVICE_ACCOUNT_JSON: serviceAccountJson,
    });

    // An empty send exercises no transport, proving construction succeeded.
    const result = await sender.send(emptyMessage);
    expect(result._unsafeUnwrap()).toEqual({
      successCount: 0,
      failureCount: 0,
      deliveredTokens: [],
      deadTokens: [],
    });
  });

  it('stops growing at the capture limit, keeping the most recent sends', async () => {
    const sender = createPushSenderFromEnv({
      NODE_ENV: 'development',
      NOTIFICATION_TAG_SECRET: TAG_SECRET,
    });
    const overshoot = 5;

    for (let index = 0; index < PUSH_CAPTURE_LIMIT + overshoot; index += 1) {
      const sent = await sender.send({
        ...conversationMessage,
        recipients: [
          { platform: 'ios', userId: `u${String(index)}`, token: `tok-${String(index)}` },
        ],
      });
      expect(sent.isOk()).toBe(true);
    }

    // Sending more than the limit evicts everything that came before, so the
    // survivors are exactly the last PUSH_CAPTURE_LIMIT of this loop's sends
    // whatever the log held on entry.
    const captured = listCapturedPushes();
    expect(captured).toHaveLength(PUSH_CAPTURE_LIMIT);
    expect(captured.at(0)?.message.recipients[0]?.userId).toBe(`u${String(overshoot)}`);
    expect(captured.at(-1)?.message.recipients[0]?.userId).toBe(
      `u${String(PUSH_CAPTURE_LIMIT + overshoot - 1)}`
    );
  });
});
