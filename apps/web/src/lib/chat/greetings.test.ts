import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HOUR_MS, TEST_LOCAL_DAY_START, setClock } from '@hushbox/shared/test-time';
import { getGreeting } from './greetings';

/** Drives the greeting picker to a chosen entry; index 0 keeps every other test stable. */
const pick = vi.hoisted(() => ({ index: 0 }));

vi.mock('@hushbox/shared', async (importOriginal) => {
  const original = await importOriginal<typeof import('@hushbox/shared')>();
  return {
    ...original,
    getSecureRandomElement: <T>(array: readonly T[]): T =>
      array[Math.min(pick.index, array.length - 1)] as T,
  };
});

describe('getGreeting', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('when not authenticated', () => {
    it('returns a greeting with title and subtitle', () => {
      const greeting = getGreeting(false);
      expect(greeting).toHaveProperty('title');
      expect(greeting).toHaveProperty('subtitle');
      expect(typeof greeting.title).toBe('string');
      expect(typeof greeting.subtitle).toBe('string');
    });

    it('returns welcome-themed greeting', () => {
      const greeting = getGreeting(false);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('welcome') ||
          combinedText.includes('ready') ||
          combinedText.includes('journey') ||
          combinedText.includes('start')
      ).toBe(true);
    });
  });

  describe('when authenticated', () => {
    describe('morning — from 5 AM until noon', () => {
      it('returns morning greeting at 6 AM', () => {
        setClock(TEST_LOCAL_DAY_START + 6 * HOUR_MS);
        const greeting = getGreeting(true);
        expect(greeting).toHaveProperty('title');
        expect(greeting).toHaveProperty('subtitle');
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('morning') ||
            combinedText.includes('rise') ||
            combinedText.includes('dawn') ||
            combinedText.includes('early')
        ).toBe(true);
      });

      it('returns morning greeting at 11 AM', () => {
        setClock(TEST_LOCAL_DAY_START + 11 * HOUR_MS);
        const greeting = getGreeting(true);
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('morning') ||
            combinedText.includes('rise') ||
            combinedText.includes('dawn') ||
            combinedText.includes('early')
        ).toBe(true);
      });
    });

    describe('afternoon (12 PM - 4:59 PM)', () => {
      it('returns afternoon greeting at 2 PM', () => {
        setClock(TEST_LOCAL_DAY_START + 14 * HOUR_MS);
        const greeting = getGreeting(true);
        expect(greeting).toHaveProperty('title');
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('afternoon') ||
            combinedText.includes('midday') ||
            combinedText.includes('daydream')
        ).toBe(true);
      });

      it('returns afternoon greeting at 4 PM', () => {
        setClock(TEST_LOCAL_DAY_START + 16 * HOUR_MS);
        const greeting = getGreeting(true);
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('afternoon') ||
            combinedText.includes('midday') ||
            combinedText.includes('daydream')
        ).toBe(true);
      });
    });

    describe('evening (5 PM - 8:59 PM)', () => {
      it('returns evening greeting at 6 PM', () => {
        setClock(TEST_LOCAL_DAY_START + 18 * HOUR_MS);
        const greeting = getGreeting(true);
        expect(greeting).toHaveProperty('title');
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('evening') ||
            combinedText.includes('sunset') ||
            combinedText.includes('twilight')
        ).toBe(true);
      });

      it('returns evening greeting at 8 PM', () => {
        setClock(TEST_LOCAL_DAY_START + 20 * HOUR_MS);
        const greeting = getGreeting(true);
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('evening') ||
            combinedText.includes('sunset') ||
            combinedText.includes('twilight')
        ).toBe(true);
      });
    });

    describe('night (9 PM - 4:59 AM)', () => {
      it('returns night greeting at 10 PM', () => {
        setClock(TEST_LOCAL_DAY_START + 22 * HOUR_MS);
        const greeting = getGreeting(true);
        expect(greeting).toHaveProperty('title');
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('night') ||
            combinedText.includes('midnight') ||
            combinedText.includes('moon') ||
            combinedText.includes('star') ||
            combinedText.includes('nocturnal')
        ).toBe(true);
      });

      it('returns night greeting at 2 AM', () => {
        setClock(TEST_LOCAL_DAY_START + 2 * HOUR_MS);
        const greeting = getGreeting(true);
        const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
        expect(
          combinedText.includes('night') ||
            combinedText.includes('midnight') ||
            combinedText.includes('moon') ||
            combinedText.includes('star') ||
            combinedText.includes('nocturnal')
        ).toBe(true);
      });
    });
  });

  describe('boundary conditions', () => {
    it('5 AM is morning', () => {
      setClock(TEST_LOCAL_DAY_START + 5 * HOUR_MS);
      const greeting = getGreeting(true);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('morning') ||
          combinedText.includes('rise') ||
          combinedText.includes('dawn') ||
          combinedText.includes('early')
      ).toBe(true);
    });

    it('12 PM is afternoon', () => {
      setClock(TEST_LOCAL_DAY_START + 12 * HOUR_MS);
      const greeting = getGreeting(true);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('afternoon') ||
          combinedText.includes('midday') ||
          combinedText.includes('daydream')
      ).toBe(true);
    });

    it('5 PM is evening', () => {
      setClock(TEST_LOCAL_DAY_START + 17 * HOUR_MS);
      const greeting = getGreeting(true);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('evening') ||
          combinedText.includes('sunset') ||
          combinedText.includes('twilight')
      ).toBe(true);
    });

    it('9 PM is night', () => {
      setClock(TEST_LOCAL_DAY_START + 21 * HOUR_MS);
      const greeting = getGreeting(true);
      const combinedText = (greeting.title + greeting.subtitle).toLowerCase();
      expect(
        combinedText.includes('night') ||
          combinedText.includes('midnight') ||
          combinedText.includes('moon') ||
          combinedText.includes('star') ||
          combinedText.includes('nocturnal')
      ).toBe(true);
    });
  });

  describe('copy', () => {
    afterEach(() => {
      pick.index = 0;
    });

    it('offers no greeting text containing a long dash', () => {
      const longDashes = ['\u2014', '\u2013'];
      const hoursCoveringEveryBucket = [6, 14, 18, 22];
      const texts: string[] = [];

      for (let index = 0; index < 5; index += 1) {
        pick.index = index;
        const greetings = [getGreeting(false)];
        for (const hour of hoursCoveringEveryBucket) {
          setClock(TEST_LOCAL_DAY_START + hour * HOUR_MS);
          greetings.push(getGreeting(true));
        }
        texts.push(...greetings.flatMap((greeting) => [greeting.title, greeting.subtitle]));
      }

      for (const text of texts) {
        for (const dash of longDashes) {
          expect(text).not.toContain(dash);
        }
      }
    });
  });
});
