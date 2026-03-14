import { describe, it, expect } from 'vitest';
import { filterMessagesForFork } from './use-fork-messages.js';
import type { Message } from '../lib/api.js';

function makeMessage(
  overrides: Partial<Message> & { id: string; parentMessageId?: string | null }
): Message & { parentMessageId?: string | null } {
  return {
    conversationId: 'conv-1',
    role: 'user',
    content: 'test',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('filterMessagesForFork', () => {
  it('returns messages in original order when no forks', () => {
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
      makeMessage({ id: 'm3', parentMessageId: 'm2' }),
    ];

    const result = filterMessagesForFork(messages, [], null);

    expect(result.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('walks parent chain from fork tip to root', () => {
    // Tree:
    //   M1 → M2 → M3 → M4 (Main tip)
    //              ↘ M5 → M6 (Fork 1 tip)
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
      makeMessage({ id: 'm3', parentMessageId: 'm2' }),
      makeMessage({ id: 'm4', parentMessageId: 'm3' }),
      makeMessage({ id: 'm5', parentMessageId: 'm2' }),
      makeMessage({ id: 'm6', parentMessageId: 'm5' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm4', createdAt: '' },
      { id: 'f2', conversationId: 'conv-1', name: 'Fork 1', tipMessageId: 'm6', createdAt: '' },
    ];

    // Walk Main: m4 → m3 → m2 → m1 → reverse → [m1, m2, m3, m4]
    const main = filterMessagesForFork(messages, forks, 'f1');
    expect(main.map((m) => m.id)).toEqual(['m1', 'm2', 'm3', 'm4']);

    // Walk Fork 1: m6 → m5 → m2 → m1 → reverse → [m1, m2, m5, m6]
    const fork1 = filterMessagesForFork(messages, forks, 'f2');
    expect(fork1.map((m) => m.id)).toEqual(['m1', 'm2', 'm5', 'm6']);
  });

  it('returns all messages sorted by sequenceNumber when activeForkId is null and forks exist', () => {
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm2', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, null);
    expect(result.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('falls back to all messages when fork tip not found in messages', () => {
    const messages = [makeMessage({ id: 'm1', parentMessageId: null })];

    const forks = [
      {
        id: 'f1',
        conversationId: 'conv-1',
        name: 'Main',
        tipMessageId: 'nonexistent',
        createdAt: '',
      },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('falls back to all messages when fork ID not found', () => {
    const messages = [makeMessage({ id: 'm1', parentMessageId: null })];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm1', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'nonexistent');
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('falls back to all messages when fork has null tipMessageId', () => {
    const messages = [makeMessage({ id: 'm1', parentMessageId: null })];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: null, createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('falls back to all messages preserving order when fork not found with multiple messages', () => {
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: null }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
      makeMessage({ id: 'm3', parentMessageId: 'm2' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm3', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'nonexistent');
    expect(result.map((m) => m.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('handles empty messages array', () => {
    const result = filterMessagesForFork([], [], null);
    expect(result).toEqual([]);
  });

  it('handles single message (root only)', () => {
    const messages = [makeMessage({ id: 'm1', parentMessageId: null })];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm1', createdAt: '' },
    ];

    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.map((m) => m.id)).toEqual(['m1']);
  });

  it('prevents infinite loop on circular parentMessageId references', () => {
    // Pathological: m1 → m2 → m1 (circular)
    const messages = [
      makeMessage({ id: 'm1', parentMessageId: 'm2' }),
      makeMessage({ id: 'm2', parentMessageId: 'm1' }),
    ];

    const forks = [
      { id: 'f1', conversationId: 'conv-1', name: 'Main', tipMessageId: 'm2', createdAt: '' },
    ];

    // Should not infinite loop; returns whatever it walks before detecting cycle
    const result = filterMessagesForFork(messages, forks, 'f1');
    expect(result.length).toBeLessThanOrEqual(2);
  });
});
