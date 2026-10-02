import { describe, it, expect } from 'vitest';
import {
  DEV_PASSWORD,
  FEATURE_FLAGS,
  DEV_EMAIL_DOMAIN,
  TEST_EMAIL_DOMAIN,
  LINK_CREDENTIAL_HEADER,
  MAX_CONVERSATION_MEMBERS,
  LEGAL_CONTACT_EMAIL,
  MEDIA_DOWNLOAD_URL_TTL_SECONDS,
  INPUTS_PREFIX,
  DELETE_ACCOUNT_CONFIRMATION_PHRASE,
  MIN_PASSWORD_LENGTH,
  MIN_DEPOSIT_USD,
  MAX_DEPOSIT_USD,
  UPGRADE_TICKET_PARAM,
} from './constants.ts';

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
  it('is dev.hushbox.ai', () => {
    expect(DEV_EMAIL_DOMAIN).toBe('dev.hushbox.ai');
  });
});

describe('TEST_EMAIL_DOMAIN', () => {
  it('is test.hushbox.ai', () => {
    expect(TEST_EMAIL_DOMAIN).toBe('test.hushbox.ai');
  });

  it('is different from DEV_EMAIL_DOMAIN', () => {
    expect(TEST_EMAIL_DOMAIN).not.toBe(DEV_EMAIL_DOMAIN);
  });
});

describe('MAX_CONVERSATION_MEMBERS', () => {
  it('equals 100', () => {
    expect(MAX_CONVERSATION_MEMBERS).toBe(100);
  });
});

describe('LINK_CREDENTIAL_HEADER', () => {
  /**
   * Copies the type system cannot reach restate this value — notably the inline-literal arm of
   * `packages/config/arch/rules/public-routes-prove-authorization.rule.ts`, which cannot import
   * it — so a rename is a coordinated cross-package migration rather than an edit.
   */
  it('is the value restated by copies the type system cannot reach', () => {
    expect(LINK_CREDENTIAL_HEADER).toBe('x-link-auth');
  });
});

describe('UPGRADE_TICKET_PARAM', () => {
  /**
   * The web client appends it and the API reads it, both through this constant; a test that
   * watches the upgrade URL from outside either package names the literal.
   */
  it('names the query parameter a link guest socket upgrade carries its ticket in', () => {
    expect(UPGRADE_TICKET_PARAM).toBe('ticket');
  });
});

describe('Legal Constants', () => {
  describe('LEGAL_CONTACT_EMAIL', () => {
    it('is legal@hushbox.ai', () => {
      expect(LEGAL_CONTACT_EMAIL).toBe('legal@hushbox.ai');
    });
  });
});

describe('MEDIA_DOWNLOAD_URL_TTL_SECONDS', () => {
  it('is 300 seconds (5 minutes)', () => {
    expect(MEDIA_DOWNLOAD_URL_TTL_SECONDS).toBe(300);
  });

  it('is a positive integer', () => {
    expect(Number.isInteger(MEDIA_DOWNLOAD_URL_TTL_SECONDS)).toBe(true);
    expect(MEDIA_DOWNLOAD_URL_TTL_SECONDS).toBeGreaterThan(0);
  });
});

describe('DELETE_ACCOUNT_CONFIRMATION_PHRASE', () => {
  it('is "delete my account"', () => {
    expect(DELETE_ACCOUNT_CONFIRMATION_PHRASE).toBe('delete my account');
  });

  it('is already lowercase and trimmed', () => {
    expect(DELETE_ACCOUNT_CONFIRMATION_PHRASE).toBe(
      DELETE_ACCOUNT_CONFIRMATION_PHRASE.trim().toLowerCase()
    );
  });

  describe('MIN_PASSWORD_LENGTH', () => {
    it('is 8', () => {
      expect(MIN_PASSWORD_LENGTH).toBe(8);
    });
  });

  describe('MIN_DEPOSIT_USD', () => {
    it('is $5', () => {
      expect(MIN_DEPOSIT_USD).toBe(5);
    });
  });

  describe('MAX_DEPOSIT_USD', () => {
    it('is $1000', () => {
      expect(MAX_DEPOSIT_USD).toBe(1000);
    });

    it('is above the minimum deposit', () => {
      expect(MAX_DEPOSIT_USD).toBeGreaterThan(MIN_DEPOSIT_USD);
    });
  });
});

describe('FEATURE_FLAGS', () => {
  it('refuses a write to one of its fields', () => {
    // The readonly declaration makes the assignment a compile error; this cast reaches past
    // the type system to prove the runtime object refuses the write as well.
    const escaped = FEATURE_FLAGS as { SETTINGS_ENABLED: boolean };
    expect(() => {
      escaped.SETTINGS_ENABLED = false;
    }).toThrow(TypeError);
    expect(FEATURE_FLAGS.SETTINGS_ENABLED).toBe(true);
  });
});

describe('INPUTS_PREFIX', () => {
  it('is the inputs/ staging key prefix', () => {
    expect(INPUTS_PREFIX).toBe('inputs/');
  });

  it('ends with a slash so it can be concatenated with a key segment', () => {
    expect(INPUTS_PREFIX.endsWith('/')).toBe(true);
  });
});
