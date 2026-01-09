import { describe, it, expect } from 'vitest';
import {
  MESSAGE_ROLES,
  DEV_PASSWORD,
  DEV_EMAIL_DOMAIN,
  TEST_EMAIL_DOMAIN,
  STRONGEST_MODEL_ID,
  VALUE_MODEL_ID,
  LOME_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  TOTAL_FEE_RATE,
  FEATURE_FLAGS,
  CHARACTERS_PER_KILOBYTE,
  KILOBYTES_PER_GIGABYTE,
  MONTHLY_COST_PER_GB,
  MONTHS_PER_YEAR,
  STORAGE_YEARS,
  STORAGE_COST_PER_CHARACTER,
  STORAGE_COST_PER_1K_CHARS,
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

describe('Fee Structure', () => {
  describe('LOME_FEE_RATE', () => {
    it('is 0.05 (5%)', () => {
      expect(LOME_FEE_RATE).toBe(0.05);
    });

    it('is a positive number less than 1', () => {
      expect(LOME_FEE_RATE).toBeGreaterThan(0);
      expect(LOME_FEE_RATE).toBeLessThan(1);
    });
  });

  describe('CREDIT_CARD_FEE_RATE', () => {
    it('is 0.045 (4.5%)', () => {
      expect(CREDIT_CARD_FEE_RATE).toBe(0.045);
    });

    it('is a positive number less than 1', () => {
      expect(CREDIT_CARD_FEE_RATE).toBeGreaterThan(0);
      expect(CREDIT_CARD_FEE_RATE).toBeLessThan(1);
    });
  });

  describe('PROVIDER_FEE_RATE', () => {
    it('is 0.055 (5.5%)', () => {
      expect(PROVIDER_FEE_RATE).toBe(0.055);
    });

    it('is a positive number less than 1', () => {
      expect(PROVIDER_FEE_RATE).toBeGreaterThan(0);
      expect(PROVIDER_FEE_RATE).toBeLessThan(1);
    });
  });

  describe('TOTAL_FEE_RATE', () => {
    it('is sum of all individual fees', () => {
      expect(TOTAL_FEE_RATE).toBe(LOME_FEE_RATE + CREDIT_CARD_FEE_RATE + PROVIDER_FEE_RATE);
    });

    it('equals 0.15 (15%)', () => {
      expect(TOTAL_FEE_RATE).toBe(0.15);
    });
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

describe('Storage Fee Constants', () => {
  describe('base constants', () => {
    it('defines CHARACTERS_PER_KILOBYTE as 1000', () => {
      expect(CHARACTERS_PER_KILOBYTE).toBe(1000);
    });

    it('defines KILOBYTES_PER_GIGABYTE as 1000000', () => {
      expect(KILOBYTES_PER_GIGABYTE).toBe(1000000);
    });

    it('defines MONTHLY_COST_PER_GB as 0.5', () => {
      expect(MONTHLY_COST_PER_GB).toBe(0.5);
    });

    it('defines MONTHS_PER_YEAR as 12', () => {
      expect(MONTHS_PER_YEAR).toBe(12);
    });

    it('defines STORAGE_YEARS as 50', () => {
      expect(STORAGE_YEARS).toBe(50);
    });
  });

  describe('STORAGE_COST_PER_CHARACTER', () => {
    it('derives from base constants', () => {
      const expectedCostPerCharacter =
        (MONTHLY_COST_PER_GB * MONTHS_PER_YEAR * STORAGE_YEARS) /
        (CHARACTERS_PER_KILOBYTE * KILOBYTES_PER_GIGABYTE);

      expect(STORAGE_COST_PER_CHARACTER).toBe(expectedCostPerCharacter);
    });

    it('equals $0.0000003 per character', () => {
      expect(STORAGE_COST_PER_CHARACTER).toBeCloseTo(0.0000003, 10);
    });

    it('calculates to $0.0003 per 1k characters', () => {
      const costPer1kChars = STORAGE_COST_PER_CHARACTER * 1000;
      expect(costPer1kChars).toBeCloseTo(0.0003, 10);
    });

    it('allows 16k+ 200-character messages for $1', () => {
      const dollarsAvailable = 1;
      const charsPerMessage = 200;
      const totalChars = dollarsAvailable / STORAGE_COST_PER_CHARACTER;
      const messageCount = totalChars / charsPerMessage;

      expect(messageCount).toBeGreaterThan(16000);
    });
  });

  describe('STORAGE_COST_PER_1K_CHARS', () => {
    it('equals STORAGE_COST_PER_CHARACTER * 1000', () => {
      expect(STORAGE_COST_PER_1K_CHARS).toBe(STORAGE_COST_PER_CHARACTER * 1000);
    });

    it('equals $0.0003', () => {
      expect(STORAGE_COST_PER_1K_CHARS).toBeCloseTo(0.0003, 10);
    });
  });
});
