import { describe, it, expect } from 'vitest';
import {
  ERROR_UNAUTHORIZED,
  ERROR_CONVERSATION_NOT_FOUND,
  ERROR_LAST_MESSAGE_NOT_USER,
  ERROR_INSUFFICIENT_BALANCE,
  ERROR_MODEL_NOT_FOUND,
  ERROR_DAILY_LIMIT_EXCEEDED,
} from './errors.js';

describe('error constants', () => {
  it('exports ERROR_UNAUTHORIZED with correct value', () => {
    expect(ERROR_UNAUTHORIZED).toBe('Unauthorized');
  });

  it('exports ERROR_CONVERSATION_NOT_FOUND with correct value', () => {
    expect(ERROR_CONVERSATION_NOT_FOUND).toBe('Conversation not found');
  });

  it('exports ERROR_LAST_MESSAGE_NOT_USER with correct value', () => {
    expect(ERROR_LAST_MESSAGE_NOT_USER).toBe('Last message must be from user');
  });

  it('exports ERROR_INSUFFICIENT_BALANCE with correct value', () => {
    expect(ERROR_INSUFFICIENT_BALANCE).toBe('Insufficient balance');
  });

  it('exports ERROR_MODEL_NOT_FOUND with correct value', () => {
    expect(ERROR_MODEL_NOT_FOUND).toBe('Model not found');
  });

  it('exports ERROR_DAILY_LIMIT_EXCEEDED with correct value', () => {
    expect(ERROR_DAILY_LIMIT_EXCEEDED).toBe('Daily message limit exceeded');
  });
});
