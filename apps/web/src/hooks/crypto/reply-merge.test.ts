import { describe, it, expect } from 'vitest';
import {
  joinTextParts,
  pickIsSmartModel,
  replyDisplayFields,
  pickModelName,
  pickReasoningEffort,
  sumReasoningDuration,
  sumReasoningTokens,
  type ReplyMergeItem,
} from './reply-merge';
import type { MessageMediaItem } from '@/lib/api/api';

/** One stored item of a reply, recording nothing unless a case says so. */
function item(overrides: Partial<ReplyMergeItem> = {}): ReplyMergeItem {
  return {
    modelName: null,
    isSmartModel: false,
    reasoningTokens: null,
    reasoningEffort: null,
    reasoningDurationMs: null,
    ...overrides,
  };
}

describe('joinTextParts', () => {
  it('joins the text items in the order given, with nothing between them', () => {
    expect(joinTextParts(['First paragraph', 'Second paragraph'])).toBe(
      'First paragraphSecond paragraph'
    );
  });

  it('joins no text items to an empty answer', () => {
    expect(joinTextParts([])).toBe('');
  });
});

describe('pickModelName', () => {
  it('takes the first model name any item records', () => {
    expect(
      pickModelName([
        item(),
        item({ modelName: 'first/model' }),
        item({ modelName: 'second/model' }),
      ])
    ).toBe('first/model');
  });

  it('is null when no item records a model', () => {
    expect(pickModelName([item(), item()])).toBeNull();
  });
});

describe('pickIsSmartModel', () => {
  it('is true when any item was Smart-routed', () => {
    expect(pickIsSmartModel([item(), item({ isSmartModel: true })])).toBe(true);
  });

  it('is false when no item was Smart-routed', () => {
    expect(pickIsSmartModel([item(), item()])).toBe(false);
  });
});

describe('sumReasoningTokens', () => {
  it('sums the token counts the items recorded', () => {
    expect(
      sumReasoningTokens([item({ reasoningTokens: 900 }), item(), item({ reasoningTokens: 304 })])
    ).toBe(1204);
  });

  it('is zero when no item recorded a count', () => {
    expect(sumReasoningTokens([item(), item()])).toBe(0);
  });
});

describe('pickReasoningEffort', () => {
  it('takes the first level any item recorded', () => {
    expect(
      pickReasoningEffort([
        item(),
        item({ reasoningEffort: 'high' }),
        item({ reasoningEffort: 'low' }),
      ])
    ).toBe('high');
  });

  it('keeps a level resolved to off rather than skipping it', () => {
    expect(pickReasoningEffort([item({ reasoningEffort: 'off' })])).toBe('off');
  });

  it('is undefined when no item recorded a level', () => {
    expect(pickReasoningEffort([item(), item()])).toBeUndefined();
  });
});

describe('sumReasoningDuration', () => {
  it('sums the durations of every item that recorded one', () => {
    expect(
      sumReasoningDuration([
        item({ reasoningDurationMs: 14_000 }),
        item(),
        item({ reasoningDurationMs: 2000 }),
      ])
    ).toBe(16_000);
  });

  it('keeps a recorded zero duration rather than dropping it', () => {
    expect(sumReasoningDuration([item({ reasoningDurationMs: 0 })])).toBe(0);
  });

  it('is undefined when no item recorded a duration', () => {
    expect(sumReasoningDuration([item(), item()])).toBeUndefined();
  });
});

describe('replyDisplayFields', () => {
  const IMAGE: MessageMediaItem = {
    id: 'ci-image-1',
    position: 1,
    contentType: 'image',
    mimeType: 'image/png',
    sizeBytes: 2048,
  };

  it('marks the reply Smart when any item was Smart-routed', () => {
    expect(replyDisplayFields([item(), item({ isSmartModel: true })], [])).toHaveProperty(
      'isSmartModel',
      true
    );
  });

  it('leaves the Smart flag absent when no item was Smart-routed', () => {
    expect(replyDisplayFields([item()], [])).not.toHaveProperty('isSmartModel');
  });

  it('carries the media rows it is given', () => {
    expect(replyDisplayFields([item()], [IMAGE]).mediaItems).toEqual([IMAGE]);
  });

  it('leaves the media rows absent when there are none', () => {
    expect(replyDisplayFields([item()], [])).not.toHaveProperty('mediaItems');
  });

  it('carries the summed reasoning token count when it is positive', () => {
    expect(
      replyDisplayFields([item({ reasoningTokens: 40 }), item({ reasoningTokens: 2 })], [])
        .reasoningTokens
    ).toBe(42);
  });

  it('leaves the reasoning token count absent when it sums to zero', () => {
    expect(replyDisplayFields([item({ reasoningTokens: 0 })], [])).not.toHaveProperty(
      'reasoningTokens'
    );
  });

  it('carries the first reasoning level recorded, off included', () => {
    expect(replyDisplayFields([item({ reasoningEffort: 'off' })], []).reasoningEffort).toBe('off');
  });

  it('leaves the reasoning level absent when none was recorded', () => {
    expect(replyDisplayFields([item()], [])).not.toHaveProperty('reasoningEffort');
  });

  it('carries the summed reasoning duration when one was recorded', () => {
    expect(replyDisplayFields([item({ reasoningDurationMs: 0 })], []).reasoningDurationMs).toBe(0);
  });

  it('leaves the reasoning duration absent when none was recorded', () => {
    expect(replyDisplayFields([item()], [])).not.toHaveProperty('reasoningDurationMs');
  });
});
