import { z } from 'zod';

export const USERNAME_REGEX = /^[a-z][a-z0-9_]{2,19}$/;

// The error message is user-facing: users type with spaces and mixed case.
// Input is normalized (spaces → underscores, lowercased) before this regex runs.
// displayUsername() reverses: underscores → spaces, title-cased.
export const usernameSchema = z
  .string()
  .regex(USERNAME_REGEX, '3-20 chars, starts with a letter. Letters, numbers, spaces only.');

export const RESERVED_USERNAMES = [
  'admin',
  'system',
  'root',
  'null',
  'undefined',
  'guest',
  'anonymous',
  'support',
  'help',
  'api',
  'www',
  'mod',
  'moderator',
  'staff',
  'lome',
  'hushbox',
  'bot',
] as const;

export function isReservedUsername(username: string): boolean {
  return (RESERVED_USERNAMES as readonly string[]).includes(username);
}
