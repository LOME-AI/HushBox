import { describe, it, expect } from 'vitest';
import {
  PRIVACY_POLICY_META,
  PRIVACY_SECTIONS,
  TERMS_OF_SERVICE_META,
  TERMS_SECTIONS,
} from './index.js';
import type { LegalSection } from './types.js';
import {
  PRIVACY_POLICY_EFFECTIVE_DATE,
  TERMS_OF_SERVICE_EFFECTIVE_DATE,
  PRIVACY_CONTACT_EMAIL,
  BILLING_CONTACT_EMAIL,
  TOTAL_FEE_RATE,
  HUSHBOX_FEE_RATE,
  CREDIT_CARD_FEE_RATE,
  PROVIDER_FEE_RATE,
  STORAGE_COST_PER_1K_CHARS,
} from '../constants.js';

function assertValidSections(sections: LegalSection[]): void {
  const ids = sections.map((s) => s.id);
  const uniqueIds = new Set(ids);

  it('has no duplicate IDs', () => {
    expect(ids.length).toBe(uniqueIds.size);
  });

  for (const section of sections) {
    describe(section.id, () => {
      it('has a non-empty title', () => {
        expect(section.title.length).toBeGreaterThan(0);
      });

      it('has a non-empty simplyPut summary', () => {
        expect(section.simplyPut.length).toBeGreaterThan(0);
      });

      it('has at least one point', () => {
        expect(section.points.length).toBeGreaterThan(0);
      });

      it('has non-empty points', () => {
        for (const point of section.points) {
          expect(point.length).toBeGreaterThan(0);
        }
      });

      it('has an id matching kebab-case format', () => {
        expect(section.id).toMatch(/^[a-z][a-z0-9-]*$/);
      });
    });
  }
}

describe('Privacy Policy', () => {
  describe('PRIVACY_POLICY_META', () => {
    it('has the correct title', () => {
      expect(PRIVACY_POLICY_META.title).toBe('Privacy Policy');
    });

    it('uses the effective date from constants', () => {
      expect(PRIVACY_POLICY_META.effectiveDate).toBe(PRIVACY_POLICY_EFFECTIVE_DATE);
    });

    it('uses the privacy contact email from constants', () => {
      expect(PRIVACY_POLICY_META.contactEmail).toBe(PRIVACY_CONTACT_EMAIL);
    });
  });

  describe('PRIVACY_SECTIONS', () => {
    it('has exactly 9 sections', () => {
      expect(PRIVACY_SECTIONS).toHaveLength(9);
    });

    it('starts with data-collection section', () => {
      expect(PRIVACY_SECTIONS[0]!.id).toBe('data-collection');
    });

    it('ends with contact section', () => {
      expect(PRIVACY_SECTIONS.at(-1)!.id).toBe('contact');
    });

    it('includes encryption-security section', () => {
      const section = PRIVACY_SECTIONS.find((s) => s.id === 'encryption-security');
      expect(section).toBeDefined();
    });

    assertValidSections(PRIVACY_SECTIONS);
  });

  describe('content constraints', () => {
    it('does not mention iron-session', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('iron-session');
    });

    it('does not mention PostHog', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('posthog');
    });

    it('does not promise data export', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('export your data');
    });

    it('does not promise account deletion', () => {
      const allText = PRIVACY_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(
        ' '
      );
      expect(allText.toLowerCase()).not.toContain('delete your account');
    });
  });
});

describe('Terms of Service', () => {
  describe('TERMS_OF_SERVICE_META', () => {
    it('has the correct title', () => {
      expect(TERMS_OF_SERVICE_META.title).toBe('Terms of Service');
    });

    it('uses the effective date from constants', () => {
      expect(TERMS_OF_SERVICE_META.effectiveDate).toBe(TERMS_OF_SERVICE_EFFECTIVE_DATE);
    });

    it('uses the billing contact email from constants', () => {
      expect(TERMS_OF_SERVICE_META.contactEmail).toBe(BILLING_CONTACT_EMAIL);
    });
  });

  describe('TERMS_SECTIONS', () => {
    it('has exactly 13 sections', () => {
      expect(TERMS_SECTIONS).toHaveLength(13);
    });

    it('starts with acceptance section', () => {
      expect(TERMS_SECTIONS[0]!.id).toBe('acceptance');
    });

    it('ends with changes section', () => {
      expect(TERMS_SECTIONS.at(-1)!.id).toBe('changes');
    });

    it('includes intellectual-property section', () => {
      const section = TERMS_SECTIONS.find((s) => s.id === 'intellectual-property');
      expect(section).toBeDefined();
    });

    assertValidSections(TERMS_SECTIONS);
  });

  describe('content constraints', () => {
    it('does not mention OpenRouter by name', () => {
      const allText = TERMS_SECTIONS.flatMap((s) => [s.title, s.simplyPut, ...s.points]).join(' ');
      expect(allText.toLowerCase()).not.toContain('openrouter');
    });

    it('disclaims ownership of AI outputs in IP section', () => {
      const ipSection = TERMS_SECTIONS.find((s) => s.id === 'intellectual-property');
      expect(ipSection).toBeDefined();
      const allPoints = ipSection!.points.join(' ').toLowerCase();
      expect(allPoints).toContain('never claim ownership');
    });

    it('states no refunds in payment section', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ').toLowerCase();
      expect(allPoints).toContain('final');
    });

    it('references fee rate from constants', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      const totalFeePercent = `${String(TOTAL_FEE_RATE * 100)}%`;
      expect(allPoints).toContain(totalFeePercent);
    });

    it('references individual fee rates from constants', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).toContain(`${String(HUSHBOX_FEE_RATE * 100)}%`);
      expect(allPoints).toContain(`${String(CREDIT_CARD_FEE_RATE * 100)}%`);
      expect(allPoints).toContain(`${String(PROVIDER_FEE_RATE * 100)}%`);
    });

    it('references storage cost from constants', () => {
      const paymentSection = TERMS_SECTIONS.find((s) => s.id === 'payment-terms');
      expect(paymentSection).toBeDefined();
      const allPoints = paymentSection!.points.join(' ');
      expect(allPoints).toContain(`$${String(STORAGE_COST_PER_1K_CHARS)}`);
    });

    it('specifies Indiana as governing law', () => {
      const govSection = TERMS_SECTIONS.find((s) => s.id === 'governing-law');
      expect(govSection).toBeDefined();
      const allPoints = govSection!.points.join(' ');
      expect(allPoints).toContain('Indiana');
    });
  });
});
