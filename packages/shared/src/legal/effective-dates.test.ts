// Each case stubs the environment and asks for a date, because the read happens
// when a date is asked for. The load-time case is the one that matters most and
// looks like the least: a plain-Node importer of the package barrel must reach
// these documents without an injected date existing at all.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { privacyPolicyEffectiveDate, termsOfServiceEffectiveDate } from './effective-dates.ts';

const PRIVACY_KEY = 'VITE_PRIVACY_POLICY_EFFECTIVE_DATE';
const TERMS_KEY = 'VITE_TERMS_OF_SERVICE_EFFECTIVE_DATE';

/** What a build that never declared the variable leaves behind. */
const UNDECLARED: string | undefined = undefined;

const INJECTED_PRIVACY_DATE = '2019-04-17';
const INJECTED_TERMS_DATE = '2021-11-02';

/**
 * The refusal reading `read` produces, as an Error. Read rather than matched: a
 * matcher handed to a throwing assertion is handed the error object, so a test
 * of its wording has to reach the message itself.
 */
function refusalFrom(read: () => string): Error {
  try {
    read();
  } catch (error: unknown) {
    return error as Error;
  }
  throw new Error('the date was answered, so there was no refusal to read');
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('the injected legal effective dates', () => {
  it('answers with the day the build injected for the Privacy Policy', () => {
    vi.stubEnv(PRIVACY_KEY, INJECTED_PRIVACY_DATE);

    expect(privacyPolicyEffectiveDate()).toBe(INJECTED_PRIVACY_DATE);
  });

  it('answers with the day the build injected for the Terms of Service', () => {
    vi.stubEnv(TERMS_KEY, INJECTED_TERMS_DATE);

    expect(termsOfServiceEffectiveDate()).toBe(INJECTED_TERMS_DATE);
  });

  it('keeps the two documents apart, so neither answers with the other document’s day', () => {
    vi.stubEnv(PRIVACY_KEY, INJECTED_PRIVACY_DATE);
    vi.stubEnv(TERMS_KEY, INJECTED_TERMS_DATE);

    expect(privacyPolicyEffectiveDate()).not.toBe(termsOfServiceEffectiveDate());
  });

  it('refuses a build that injected an empty value, naming the variable', () => {
    vi.stubEnv(PRIVACY_KEY, '');

    expect(refusalFrom(privacyPolicyEffectiveDate).message).toContain(PRIVACY_KEY);
  });

  it('refuses a build whose environment never declared the variable at all', () => {
    vi.stubEnv(PRIVACY_KEY, UNDECLARED);

    const refusal = refusalFrom(privacyPolicyEffectiveDate);

    expect(refusal.message).toContain(PRIVACY_KEY);
    expect(refusal.message).toContain('nothing at all');
  });

  it('refuses a value that is not written as a day, quoting what it carried', () => {
    vi.stubEnv(TERMS_KEY, 'the second of November');

    const refusal = refusalFrom(termsOfServiceEffectiveDate);

    expect(refusal.message).toContain(TERMS_KEY);
    expect(refusal.message).toContain('YYYY-MM-DD');
    expect(refusal.message).toContain('the second of November');
  });

  it('refuses a day-shaped value naming no calendar day, rather than rolling it into the next month', () => {
    vi.stubEnv(PRIVACY_KEY, '2019-02-30');

    const refusal = refusalFrom(privacyPolicyEffectiveDate);

    expect(refusal.message).toContain(PRIVACY_KEY);
    expect(refusal.message).toContain('2019-02-30');
    expect(refusal.message).toContain('calendar');
  });

  it('lets a plain-Node importer of the package barrel reach the documents with no date injected', async () => {
    vi.stubEnv(PRIVACY_KEY, UNDECLARED);
    vi.stubEnv(TERMS_KEY, UNDECLARED);
    vi.resetModules();

    const { PRIVACY_SECTIONS, PRIVACY_POLICY_META } = await import('./index.ts');

    expect(PRIVACY_SECTIONS.length).toBeGreaterThan(0);
    expect(refusalFrom(() => PRIVACY_POLICY_META.effectiveDate).message).toContain(PRIVACY_KEY);
  });

  it('refuses a month outside the calendar', () => {
    vi.stubEnv(TERMS_KEY, '2021-13-02');

    expect(refusalFrom(termsOfServiceEffectiveDate).message).toContain(TERMS_KEY);
  });
});
