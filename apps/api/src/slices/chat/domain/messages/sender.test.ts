import { describe, expect, it } from 'vitest';
import { senderCaller, senderUserId } from './sender.js';

describe('senderCaller', () => {
  it('maps a user sender to a user caller', () => {
    expect(senderCaller({ kind: 'user', userId: 'u1' }, 'c1')).toEqual({
      kind: 'user',
      userId: 'u1',
    });
  });

  it('maps a link-guest sender to a guest caller carrying the conversation it acts in', () => {
    expect(senderCaller({ kind: 'linkGuest', linkId: 'l1' }, 'c1')).toEqual({
      kind: 'linkGuest',
      linkId: 'l1',
      conversationId: 'c1',
    });
  });
});

describe('senderUserId', () => {
  it('returns a user sender own account id', () => {
    expect(senderUserId({ kind: 'user', userId: 'u1' })).toBe('u1');
  });

  it('returns undefined for a link guest, which holds no account', () => {
    expect(senderUserId({ kind: 'linkGuest', linkId: 'l1' })).toBeUndefined();
  });
});
