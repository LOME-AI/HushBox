import { describe, expect, it } from 'vitest';
import { USERNAME_REGEX, usernameSchema, RESERVED_USERNAMES, isReservedUsername } from './username';

describe('username validation', () => {
  describe('USERNAME_REGEX', () => {
    it('accepts valid usernames', () => {
      expect(USERNAME_REGEX.test('john_smith')).toBe(true);
      expect(USERNAME_REGEX.test('abc')).toBe(true);
      expect(USERNAME_REGEX.test('user123')).toBe(true);
      expect(USERNAME_REGEX.test('a_b_c')).toBe(true);
      expect(USERNAME_REGEX.test('abcdefghijklmnopqrst')).toBe(true);
    });

    it('rejects usernames starting with a number', () => {
      expect(USERNAME_REGEX.test('1user')).toBe(false);
    });

    it('rejects usernames starting with underscore', () => {
      expect(USERNAME_REGEX.test('_user')).toBe(false);
    });

    it('rejects usernames with uppercase', () => {
      expect(USERNAME_REGEX.test('John')).toBe(false);
    });

    it('rejects usernames shorter than 3 chars', () => {
      expect(USERNAME_REGEX.test('ab')).toBe(false);
    });

    it('rejects usernames longer than 20 chars', () => {
      expect(USERNAME_REGEX.test('a' + 'b'.repeat(20))).toBe(false);
    });

    it('rejects usernames with spaces', () => {
      expect(USERNAME_REGEX.test('john smith')).toBe(false);
    });

    it('rejects usernames with special characters', () => {
      expect(USERNAME_REGEX.test('john-smith')).toBe(false);
      expect(USERNAME_REGEX.test('john.smith')).toBe(false);
      expect(USERNAME_REGEX.test('john@smith')).toBe(false);
    });

    it('rejects empty string', () => {
      expect(USERNAME_REGEX.test('')).toBe(false);
    });
  });

  describe('usernameSchema', () => {
    it('parses valid usernames', () => {
      expect(usernameSchema.parse('john_smith')).toBe('john_smith');
    });

    it('rejects invalid usernames with descriptive error', () => {
      expect(() => usernameSchema.parse('1bad')).toThrow();
    });
  });

  describe('RESERVED_USERNAMES', () => {
    it('contains expected reserved words', () => {
      expect(RESERVED_USERNAMES).toContain('admin');
      expect(RESERVED_USERNAMES).toContain('system');
      expect(RESERVED_USERNAMES).toContain('root');
      expect(RESERVED_USERNAMES).toContain('guest');
      expect(RESERVED_USERNAMES).toContain('lome');
      expect(RESERVED_USERNAMES).toContain('hushbox');
    });

    it('all reserved words match the username regex', () => {
      for (const word of RESERVED_USERNAMES) {
        expect(USERNAME_REGEX.test(word)).toBe(true);
      }
    });
  });

  describe('isReservedUsername', () => {
    it('returns true for reserved usernames', () => {
      expect(isReservedUsername('admin')).toBe(true);
      expect(isReservedUsername('lome')).toBe(true);
    });

    it('returns false for non-reserved usernames', () => {
      expect(isReservedUsername('john_smith')).toBe(false);
    });
  });
});
