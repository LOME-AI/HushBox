import { describe, it, expect } from 'vitest';
import {
  MESSAGE_ROLES,
  DEV_PASSWORD,
  DEV_EMAIL_DOMAIN,
  TEST_EMAIL_DOMAIN,
  STRONGEST_MODEL_ID,
  VALUE_MODEL_ID,
  LOME_FEE_RATE,
  FEATURE_FLAGS,
} from './constants.js';

describe('MESSAGE_ROLES', () => {
  it('contains user, assistant, and system roles', () => {
    expect(MESSAGE_ROLES).toEqual(['user', 'assistant', 'system']);
  });
});

describe('DEV_PASSWORD', () => {
  it('is a non-empty string', () => {
    expect(typeof DEV_PASSWORD).toBe('string');
    expect(DEV_PASSWORD.length).toBeGreaterThan(0);
  });

  it('has at least 8 characters for minimal security', () => {
    expect(DEV_PASSWORD.length).toBeGreaterThanOrEqual(8);
  });
});

describe('DEV_EMAIL_DOMAIN', () => {
  it('is dev.lome-chat.com', () => {
    expect(DEV_EMAIL_DOMAIN).toBe('dev.lome-chat.com');
  });
});

describe('TEST_EMAIL_DOMAIN', () => {
  it('is test.lome-chat.com', () => {
    expect(TEST_EMAIL_DOMAIN).toBe('test.lome-chat.com');
  });

  it('is different from DEV_EMAIL_DOMAIN', () => {
    expect(TEST_EMAIL_DOMAIN).not.toBe(DEV_EMAIL_DOMAIN);
  });
});

describe('STRONGEST_MODEL_ID', () => {
  it('is anthropic/claude-opus-4.5', () => {
    expect(STRONGEST_MODEL_ID).toBe('anthropic/claude-opus-4.5');
  });

  it('follows provider/model format', () => {
    expect(STRONGEST_MODEL_ID).toMatch(/^[a-z-]+\/[a-z0-9.-]+$/);
  });
});

describe('VALUE_MODEL_ID', () => {
  it('is deepseek/deepseek-r1', () => {
    expect(VALUE_MODEL_ID).toBe('deepseek/deepseek-r1');
  });

  it('follows provider/model format', () => {
    expect(VALUE_MODEL_ID).toMatch(/^[a-z-]+\/[a-z0-9.-]+$/);
  });

  it('is different from STRONGEST_MODEL_ID', () => {
    expect(VALUE_MODEL_ID).not.toBe(STRONGEST_MODEL_ID);
  });
});

describe('LOME_FEE_RATE', () => {
  it('is 0.15 (15%)', () => {
    expect(LOME_FEE_RATE).toBe(0.15);
  });

  it('is a positive number less than 1', () => {
    expect(LOME_FEE_RATE).toBeGreaterThan(0);
    expect(LOME_FEE_RATE).toBeLessThan(1);
  });
});

describe('FEATURE_FLAGS', () => {
  it('has PROJECTS_ENABLED flag', () => {
    expect(FEATURE_FLAGS).toHaveProperty('PROJECTS_ENABLED');
  });

  it('has PROJECTS_ENABLED as boolean', () => {
    expect(typeof FEATURE_FLAGS.PROJECTS_ENABLED).toBe('boolean');
  });
});
