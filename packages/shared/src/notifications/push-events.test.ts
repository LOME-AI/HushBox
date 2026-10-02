import { describe, expect, it } from 'vitest';
import { testUuidV7 } from '../testing/test-time.ts';
import {
  NOTIFICATION_CATEGORIES,
  NOTIFICATION_COPY,
  conversationIdSchema,
  notificationCategorySchema,
  notificationCopyForCategory,
  pushEventPayloadSchema,
} from './push-events.ts';

const VALID_ID = testUuidV7(1);

describe('notificationCategorySchema', () => {
  it('accepts each of the three closed categories', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(notificationCategorySchema.parse(category)).toBe(category);
    }
  });

  it('rejects a category outside the closed set', () => {
    expect(notificationCategorySchema.safeParse('mention').success).toBe(false);
  });

  it('enumerates exactly message, runCompletion, membership', () => {
    expect(NOTIFICATION_CATEGORIES).toEqual(['message', 'runCompletion', 'membership']);
  });
});

describe('conversationIdSchema', () => {
  it('accepts a well-formed uuid', () => {
    expect(conversationIdSchema.parse(VALID_ID)).toBe(VALID_ID);
  });

  it('rejects a value that is not a uuid', () => {
    expect(conversationIdSchema.safeParse('../etc/passwd').success).toBe(false);
  });

  it('rejects a uuid carrying a path-traversal suffix', () => {
    expect(conversationIdSchema.safeParse(`${VALID_ID}/../admin`).success).toBe(false);
  });
});

describe('pushEventPayloadSchema', () => {
  it('accepts a generic payload of category plus conversationId', () => {
    const payload = { category: 'message' as const, conversationId: VALID_ID };
    expect(pushEventPayloadSchema.parse(payload)).toEqual(payload);
  });

  it('rejects an unknown key so no user-generated text can ride along', () => {
    const result = pushEventPayloadSchema.safeParse({
      category: 'message',
      conversationId: VALID_ID,
      title: 'Alice: secret message',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload whose conversationId is not a uuid', () => {
    expect(
      pushEventPayloadSchema.safeParse({ category: 'message', conversationId: 'nope' }).success
    ).toBe(false);
  });

  it('rejects a payload whose category is outside the closed set', () => {
    expect(
      pushEventPayloadSchema.safeParse({ category: 'mention', conversationId: VALID_ID }).success
    ).toBe(false);
  });
});

describe('notificationCopyForCategory', () => {
  it('resolves the fixed copy for every category', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      expect(notificationCopyForCategory(category)).toEqual(NOTIFICATION_COPY[category]);
    }
  });

  it('gives every category a non-empty title and body', () => {
    for (const category of NOTIFICATION_CATEGORIES) {
      const copy = notificationCopyForCategory(category);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.body.length).toBeGreaterThan(0);
    }
  });

  it('defines exactly one entry per known category', () => {
    const alphabetical = (values: readonly string[]): string[] =>
      values.toSorted((a, b) => a.localeCompare(b));
    expect(alphabetical(Object.keys(NOTIFICATION_COPY))).toEqual(
      alphabetical(NOTIFICATION_CATEGORIES)
    );
  });

  it('states the words a delivered notification carries', () => {
    // Pinned literally: this is the text a person reads on a locked phone, and
    // it is the only text a content-free notification may carry.
    expect(NOTIFICATION_COPY).toEqual({
      message: { title: 'New message', body: 'You have a new message.' },
      runCompletion: { title: 'Response ready', body: 'A response is ready to view.' },
      membership: {
        title: 'Conversation update',
        body: 'A conversation you are in was updated.',
      },
    });
  });
});
