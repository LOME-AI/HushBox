import { describe, expect, it } from 'vitest';
import { normalizeUsername, displayUsername, normalizeIdentifier } from './username';

describe('username utilities', () => {
  describe('normalizeUsername', () => {
    it('converts to lowercase', () => {
      expect(normalizeUsername('JohnSmith')).toBe('johnsmith');
    });

    it('replaces spaces with underscores', () => {
      expect(normalizeUsername('john smith')).toBe('john_smith');
    });

    it('trims whitespace', () => {
      expect(normalizeUsername('  john  ')).toBe('john');
    });

    it('handles multiple spaces between words', () => {
      expect(normalizeUsername('john   smith')).toBe('john_smith');
    });

    it('handles mixed case with spaces', () => {
      expect(normalizeUsername('John Smith')).toBe('john_smith');
    });

    it('preserves existing underscores', () => {
      expect(normalizeUsername('john_smith')).toBe('john_smith');
    });

    it('handles tabs and newlines as whitespace', () => {
      expect(normalizeUsername('john\tsmith')).toBe('john_smith');
    });

    it('collapses mixed whitespace', () => {
      expect(normalizeUsername('john  \t smith')).toBe('john_smith');
    });
  });

  describe('displayUsername', () => {
    it('replaces underscores with spaces and capitalizes each word', () => {
      expect(displayUsername('john_smith')).toBe('John Smith');
    });

    it('capitalizes single word', () => {
      expect(displayUsername('john')).toBe('John');
    });

    it('handles multiple underscores', () => {
      expect(displayUsername('john_james_smith')).toBe('John James Smith');
    });

    it('handles already capitalized input', () => {
      expect(displayUsername('john')).toBe('John');
    });

    it('handles single character words', () => {
      expect(displayUsername('a_b_c')).toBe('A B C');
    });
  });

  describe('round-trip: displayUsername(normalizeUsername(x))', () => {
    it.each([
      ['John Smith', 'John Smith'],
      ['Alice', 'Alice'],
      ['John James Smith', 'John James Smith'],
      ['A B C', 'A B C'],
    ])('round-trips title-case input "%s" → "%s"', (input, expected) => {
      expect(displayUsername(normalizeUsername(input))).toBe(expected);
    });

    it.each([
      ['john smith', 'John Smith'],
      ['JOHN SMITH', 'John Smith'],
      ['alice', 'Alice'],
      ['john_smith', 'John Smith'],
    ])('normalizes non-title-case input "%s" to deterministic display "%s"', (input, expected) => {
      expect(displayUsername(normalizeUsername(input))).toBe(expected);
    });
  });

  describe('normalizeIdentifier', () => {
    it('passes email through unchanged', () => {
      expect(normalizeIdentifier('User@Example.com')).toBe('User@Example.com');
    });

    it('normalizes username when no @ present', () => {
      expect(normalizeIdentifier('John Smith')).toBe('john_smith');
    });

    it('normalizes uppercase username', () => {
      expect(normalizeIdentifier('ALICE')).toBe('alice');
    });

    it('treats value with @ as email even if unusual', () => {
      expect(normalizeIdentifier('test@localhost')).toBe('test@localhost');
    });

    it('trims and normalizes username with spaces', () => {
      expect(normalizeIdentifier('  Test User  ')).toBe('test_user');
    });
  });

  describe('displayUsername idempotency: f(f(x)) === f(x)', () => {
    it.each(['john_smith', 'alice', 'a_b_c', 'john123', 'john_james_smith'])(
      'displayUsername is idempotent for stored input "%s"',
      (stored) => {
        const once = displayUsername(stored);
        const twice = displayUsername(once);
        expect(twice).toBe(once);
      }
    );
  });
});
