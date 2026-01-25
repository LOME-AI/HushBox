import { describe, expect, it } from 'vitest';
import {
  formatNumber,
  formatContextLength,
  formatPricePer1k,
  formatCost,
  shortenModelName,
  generateChatTitle,
  CHAT_TITLE_MAX_LENGTH,
  DEFAULT_CHAT_TITLE,
} from './formatting';

describe('formatting utilities', () => {
  describe('formatNumber', () => {
    it('formats small numbers without separators', () => {
      expect(formatNumber(123)).toBe('123');
    });

    it('formats large numbers with thousand separators', () => {
      // Note: exact format depends on locale, but should include separator
      const result = formatNumber(1_234_567);
      expect(result).toMatch(/1.*234.*567/);
    });

    it('handles zero', () => {
      expect(formatNumber(0)).toBe('0');
    });

    it('handles negative numbers', () => {
      const result = formatNumber(-1234);
      expect(result).toContain('1');
      expect(result).toContain('234');
    });
  });

  describe('formatContextLength', () => {
    it('formats values under 1M with k suffix', () => {
      expect(formatContextLength(128_000)).toBe('128k');
      expect(formatContextLength(4000)).toBe('4k');
      expect(formatContextLength(32_000)).toBe('32k');
    });

    it('formats values at or above 1M with M suffix', () => {
      expect(formatContextLength(1_000_000)).toBe('1M');
      expect(formatContextLength(2_000_000)).toBe('2M');
    });

    it('rounds to nearest unit', () => {
      expect(formatContextLength(128_500)).toBe('129k');
      expect(formatContextLength(1_500_000)).toBe('2M');
    });
  });

  describe('formatPricePer1k', () => {
    it('formats typical token prices', () => {
      expect(formatPricePer1k(0.000_01)).toBe('$0.01');
      expect(formatPricePer1k(0.000_015)).toBe('$0.015');
    });

    it('strips trailing zeros', () => {
      expect(formatPricePer1k(0.001)).toBe('$1');
      expect(formatPricePer1k(0.0001)).toBe('$0.1');
    });

    it('handles very small prices', () => {
      expect(formatPricePer1k(0.000_001)).toBe('$0.001');
    });
  });

  describe('formatCost', () => {
    it('formats zero as $0.00', () => {
      expect(formatCost(0)).toBe('$0.00');
      expect(formatCost('0')).toBe('$0.00');
      expect(formatCost('0.00000000')).toBe('$0.00');
    });

    it('formats costs with full precision, stripping trailing zeros', () => {
      expect(formatCost(0.0234)).toBe('$0.0234');
      expect(formatCost('0.12345678')).toBe('$0.12345678');
      expect(formatCost(0.001_36)).toBe('$0.00136');
    });

    it('formats very small costs with full precision', () => {
      expect(formatCost(0.000_01)).toBe('$0.00001');
      expect(formatCost('0.000005')).toBe('$0.000005');
    });

    it('handles NaN as $0.00', () => {
      expect(formatCost('invalid')).toBe('$0.00');
      expect(formatCost(Number.NaN)).toBe('$0.00');
    });

    it('strips trailing zeros from costs', () => {
      expect(formatCost(1.5)).toBe('$1.5');
      expect(formatCost('1.5')).toBe('$1.5');
      expect(formatCost(1)).toBe('$1');
      expect(formatCost('2.00000000')).toBe('$2');
    });
  });

  describe('shortenModelName', () => {
    it('removes date-like suffixes in format -YYYY-MM-DD', () => {
      expect(shortenModelName('Claude 3.5 Sonnet-2024-08-06')).toBe('Claude 3.5 Sonnet');
      expect(shortenModelName('GPT-4 Turbo-2024-01-15')).toBe('GPT-4 Turbo');
    });

    it('removes date-like suffixes in format -YYYYMMDD', () => {
      expect(shortenModelName('Claude 3.5 Sonnet-20240806')).toBe('Claude 3.5 Sonnet');
    });

    it('removes version number suffixes like -4-0', () => {
      expect(shortenModelName('Gemini Pro-1-5')).toBe('Gemini Pro');
      expect(shortenModelName('Model-4-0-mini')).toBe('Model-4-0-mini'); // should only strip trailing patterns
    });

    it('removes suffixes with multiple number groups', () => {
      expect(shortenModelName('Model-1-2-3-4')).toBe('Model');
    });

    it('preserves names without version/date suffixes', () => {
      expect(shortenModelName('GPT-4')).toBe('GPT-4');
      expect(shortenModelName('Claude 3 Opus')).toBe('Claude 3 Opus');
      expect(shortenModelName('Gemini Pro')).toBe('Gemini Pro');
    });

    it('handles empty and whitespace strings', () => {
      expect(shortenModelName('')).toBe('');
      expect(shortenModelName('   ')).toBe('');
    });

    it('trims whitespace from result', () => {
      expect(shortenModelName('  Claude 3.5 Sonnet-2024-08-06  ')).toBe('Claude 3.5 Sonnet');
    });
  });

  describe('generateChatTitle', () => {
    it('returns default title when no content provided', () => {
      expect(generateChatTitle()).toBe(DEFAULT_CHAT_TITLE);
      expect(generateChatTitle()).toBe(DEFAULT_CHAT_TITLE);
      expect(generateChatTitle('')).toBe(DEFAULT_CHAT_TITLE);
    });

    it('uses first 50 characters of message content', () => {
      const shortMessage = 'Hello, world!';
      expect(generateChatTitle(shortMessage)).toBe(shortMessage);
    });

    it('truncates messages longer than 50 characters', () => {
      const longMessage =
        'This is a very long message that exceeds the fifty character limit for titles';
      expect(generateChatTitle(longMessage)).toBe(longMessage.slice(0, CHAT_TITLE_MAX_LENGTH));
      expect(generateChatTitle(longMessage).length).toBe(CHAT_TITLE_MAX_LENGTH);
    });

    it('exports CHAT_TITLE_MAX_LENGTH as 50', () => {
      expect(CHAT_TITLE_MAX_LENGTH).toBe(50);
    });

    it('exports DEFAULT_CHAT_TITLE as "New Conversation"', () => {
      expect(DEFAULT_CHAT_TITLE).toBe('New Conversation');
    });
  });
});
