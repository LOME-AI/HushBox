import { describe, it, expect } from 'vitest';
import { generateKeyPair, createFirstEpoch } from '@hushbox/crypto';
import { MEDIA_DOWNLOAD_URL_TTL_SECONDS, toBase64 } from '@hushbox/shared';
import {
  DAY_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  TEST_DAY_START,
  TEST_LOCAL_DAY_START,
  isoAt,
} from '@hushbox/shared/test-time';
import { conversationDateGroup, mostRecentConversations } from '@/lib/chat/conversation-groups';
import { DemoBackendStore } from './store';
import { DEMO_CONVERSATIONS } from './fixtures';

/** A clock the test moves by hand; the store reads it through `now`. */
interface TestClock {
  readonly now: () => Date;
  set: (instantMs: number) => void;
}

function clockAt(instantMs: number): TestClock {
  let current = instantMs;
  return {
    now: () => new Date(current),
    set: (next) => {
      current = next;
    },
  };
}

function storeAt(clock: TestClock): DemoBackendStore {
  return new DemoBackendStore(generateKeyPair().publicKey, clock.now);
}

/** The new-chat request body for a conversation the visitor creates. */
function newChatRequest(id: string): {
  id: string;
  epochPublicKey: string;
  confirmationHash: string;
  memberWrap: string;
} {
  const account = generateKeyPair();
  const epoch = createFirstEpoch([account.publicKey], id, 1);
  const ownerWrap = epoch.memberWraps[0];
  if (ownerWrap === undefined) throw new Error('no owner wrap');
  return {
    id,
    epochPublicKey: toBase64(epoch.epochPublicKey),
    confirmationHash: toBase64(epoch.confirmationHash),
    memberWrap: toBase64(ownerWrap.wrap),
  };
}

function localDayOf(instantMs: number): string {
  const date = new Date(instantMs);
  return [date.getFullYear(), date.getMonth(), date.getDate()].join('-');
}

const MIDDAY = TEST_LOCAL_DAY_START + 12 * HOUR_MS;

describe('DemoBackendStore visit-day stamps', () => {
  it('stamps each seeded conversation one second before the one listed above it', () => {
    const store = storeAt(clockAt(MIDDAY));

    const stamps = store.listConversations().conversations.map((item) => item.createdAt);

    expect(stamps).toEqual(DEMO_CONVERSATIONS.map((_, index) => isoAt(MIDDAY - index * SECOND_MS)));
  });

  it('stamps a seeded conversation updated when it was created', () => {
    const store = storeAt(clockAt(MIDDAY));

    for (const item of store.listConversations().conversations) {
      expect(item.updatedAt).toBe(item.createdAt);
    }
  });

  it('serves the seeded stamp on the conversation detail', () => {
    const store = storeAt(clockAt(MIDDAY));
    const first = DEMO_CONVERSATIONS[0];
    if (first === undefined) throw new Error('no fixtures');

    expect(store.getConversation(first.id)?.conversation.createdAt).toBe(isoAt(MIDDAY));
  });

  it('holds seeded stamps at local midnight for a visit seconds into the day', () => {
    const visit = TEST_LOCAL_DAY_START + 2 * SECOND_MS;
    const store = storeAt(clockAt(visit));

    const stamps = store.listConversations().conversations.map((item) => item.createdAt);

    expect(stamps).toEqual(
      DEMO_CONVERSATIONS.map((_, index) =>
        isoAt(Math.max(TEST_LOCAL_DAY_START, visit - index * SECOND_MS))
      )
    );
  });

  it('groups every seeded conversation under Today', () => {
    // A year on, so a stamp left on any fixed earlier day falls out of Today.
    for (const visit of [TEST_LOCAL_DAY_START + 2 * SECOND_MS, MIDDAY + 365 * DAY_MS]) {
      const store = storeAt(clockAt(visit));

      const groups = store
        .listConversations()
        .conversations.map((item) => conversationDateGroup(item.updatedAt, new Date(visit)));

      expect(new Set(groups)).toEqual(new Set(['Today']));
    }
  });

  it('ranks seeded conversations by recency in the script order', () => {
    const store = storeAt(clockAt(MIDDAY));
    const listed = store.listConversations().conversations;

    const ranked = mostRecentConversations(listed, listed.length).map((item) => item.id);

    expect(ranked).toEqual(DEMO_CONVERSATIONS.map((conversation) => conversation.id));
  });

  it('keys the allowance to the visit UTC day', () => {
    const store = storeAt(clockAt(TEST_DAY_START + 12 * HOUR_MS));

    expect(store.getBalance().allowance.day).toBe(isoAt(TEST_DAY_START).slice(0, 10));
  });

  it('reads the clock for seeded stamps and the allowance day once, at construction', () => {
    const clock = clockAt(MIDDAY);
    const store = storeAt(clock);
    const stampsBefore = store.listConversations().conversations.map((item) => item.createdAt);
    const dayBefore = store.getBalance().allowance.day;

    clock.set(MIDDAY + 3 * DAY_MS);

    expect(store.listConversations().conversations.map((item) => item.createdAt)).toEqual(
      stampsBefore
    );
    expect(store.getBalance().allowance.day).toBe(dayBefore);
  });

  it('stamps a conversation created during the visit at its creation', () => {
    const clock = clockAt(MIDDAY);
    const store = storeAt(clock);
    const createdAt = MIDDAY + 5 * MINUTE_MS;
    clock.set(createdAt);

    const { conversation } = store.createConversation(newChatRequest('created-live'));

    expect(conversation.createdAt).toBe(isoAt(createdAt));
    expect(conversation.updatedAt).toBe(isoAt(createdAt));
  });

  it('expires a media download URL one TTL after the visit began', () => {
    const clock = clockAt(MIDDAY);
    const store = storeAt(clock);
    store.fillConversation('demo-image');
    const mediaItem = store
      .getMessages('demo-image')
      ?.flatMap((message) => message.contentItems)
      .find((item) => item.contentType === 'image');
    if (mediaItem === undefined) throw new Error('no media item');
    const requestedAt = MIDDAY + 7 * MINUTE_MS;
    clock.set(requestedAt);

    const presign = store.getMediaDownloadUrl(mediaItem.id);

    expect(presign?.expiresAt).toBe(isoAt(MIDDAY + MEDIA_DOWNLOAD_URL_TTL_SECONDS * SECOND_MS));
  });

  it('dates every replayed message on the visit day for a visit a minute before midnight', () => {
    const visit = TEST_LOCAL_DAY_START + DAY_MS - MINUTE_MS;
    const store = storeAt(clockAt(visit));

    for (const conversation of DEMO_CONVERSATIONS) {
      store.fillConversation(conversation.id);
      const days = (store.getMessages(conversation.id) ?? []).map((message) =>
        localDayOf(Date.parse(message.createdAt))
      );
      expect(new Set(days)).toEqual(new Set([localDayOf(visit)]));
    }
  });

  it('dates every member as joining when its conversation was created', () => {
    const store = storeAt(clockAt(MIDDAY));

    for (const item of store.listConversations().conversations) {
      const joined = store.getMembers(item.id).members.map((member) => member.joinedAt);
      expect(new Set(joined)).toEqual(new Set([item.createdAt]));
    }
  });
});
