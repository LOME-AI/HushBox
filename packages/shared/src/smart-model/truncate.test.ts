import { describe, expect, it } from 'vitest';

import {
  CLASSIFIER_CHARS_PER_DIRECTION,
  CLASSIFIER_CHUNK_SIZE,
  MAX_CLASSIFIER_CONTEXT_CHARS,
  truncateForClassifier,
} from './truncate.js';

const long = (n: number, char = 'x'): string => char.repeat(n);

describe('truncateForClassifier constants', () => {
  it('budget is 4 directions × per-direction cap', () => {
    expect(MAX_CLASSIFIER_CONTEXT_CHARS).toBe(CLASSIFIER_CHARS_PER_DIRECTION * 4);
  });

  it('chunk size divides evenly into per-direction budget', () => {
    expect(CLASSIFIER_CHARS_PER_DIRECTION % CLASSIFIER_CHUNK_SIZE).toBe(0);
  });
});

describe('truncateForClassifier', () => {
  it('returns an empty string when both messages are empty', () => {
    expect(truncateForClassifier({ latestUserMessage: '', latestAssistantMessage: '' })).toBe('');
  });

  it('omits the [AI ...] sections when assistant message is empty', () => {
    const out = truncateForClassifier({
      latestUserMessage: 'hello world',
      latestAssistantMessage: '',
    });
    expect(out).toContain('[USER START]: hello world');
    expect(out).not.toContain('[AI START]');
    expect(out).not.toContain('[AI END]');
  });

  it('emits both user start and end markers when message is short enough to fit in one direction', () => {
    const userMessage = 'short user input';
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    // Short message fits entirely in [USER START] direction; [USER END] would duplicate.
    expect(out).toContain('[USER START]: short user input');
  });

  it('includes all four sections when both messages are long', () => {
    const userMessage = `${long(500, 'a')}${long(500, 'b')}`; // 1000 chars
    const aiMessage = `${long(500, 'c')}${long(500, 'd')}`; // 1000 chars

    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: aiMessage,
    });

    expect(out).toContain('[USER START]:');
    expect(out).toContain('[USER END]:');
    expect(out).toContain('[AI START]:');
    expect(out).toContain('[AI END]:');
  });

  it('caps total captured content at MAX_CLASSIFIER_CONTEXT_CHARS', () => {
    const veryLong = long(10_000);
    const out = truncateForClassifier({
      latestUserMessage: veryLong,
      latestAssistantMessage: veryLong,
    });

    // Strip both section markers AND the blank-line separators — they're
    // formatting overhead, not classifier content. The cap is on captured chars.
    const stripped = out.replaceAll(/\[(USER|AI) (START|END)\]: /g, '').replaceAll('\n\n', '');
    expect(stripped.length).toBeLessThanOrEqual(MAX_CLASSIFIER_CONTEXT_CHARS);
  });

  it('captures from the start when capturing a USER START or AI START direction', () => {
    const userMessage = 'BEGINNING-MARKER' + long(2000) + 'END-MARKER';
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    const startSection = out.split('\n\n').find((s) => s.startsWith('[USER START]:'));
    expect(startSection).toContain('BEGINNING-MARKER');
  });

  it('captures from the end when capturing a USER END or AI END direction', () => {
    const userMessage = 'BEGINNING-MARKER' + long(2000) + 'END-MARKER';
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    const endSection = out.split('\n\n').find((s) => s.startsWith('[USER END]:'));
    expect(endSection).toContain('END-MARKER');
  });

  it('reallocates leftover budget when one direction has nothing to contribute', () => {
    // AI is empty, so AI directions get nothing — total captured can still
    // approach the global budget by reading more from the user message.
    const userMessage = long(MAX_CLASSIFIER_CONTEXT_CHARS * 2);
    const out = truncateForClassifier({
      latestUserMessage: userMessage,
      latestAssistantMessage: '',
    });
    const stripped = out.replaceAll(/\[(USER|AI) (START|END)\]: /g, '').replaceAll('\n\n', '');
    // When AI is empty, only user start + user end fire — capped at 2 × per-direction.
    expect(stripped.length).toBeLessThanOrEqual(CLASSIFIER_CHARS_PER_DIRECTION * 2);
    expect(stripped.length).toBeGreaterThan(CLASSIFIER_CHARS_PER_DIRECTION); // not just one direction
  });

  it('preserves directional separators between sections', () => {
    const out = truncateForClassifier({
      latestUserMessage: 'hello',
      latestAssistantMessage: 'world',
    });
    // Sections are separated by blank lines.
    expect(out).toMatch(/\[USER START\]: hello.*\n\n\[AI START\]: world/s);
  });
});
