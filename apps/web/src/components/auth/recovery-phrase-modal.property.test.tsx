import { render, screen, within } from '@testing-library/react';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROPERTY_TEST_RUNS, PROPERTY_TEST_SEED } from '@hushbox/shared/property-tests';
import { RecoveryPhraseModal } from './recovery-phrase-modal';

vi.mock('@hushbox/crypto', () => ({
  regenerateRecoveryPhrase: () =>
    Promise.resolve({
      recoveryPhrase: 'apple brave candy delta eagle frost globe happy ivory joker kite lemon',
      recoveryWrappedPrivateKey: new Uint8Array([10, 20, 30, 40, 50]),
      recoveryPublicKey: new Uint8Array([60, 70, 80, 90, 100]),
    }),
}));

vi.mock('@/lib/auth/auth', () => ({
  useAuthStore: { getState: () => ({ privateKey: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }) },
  saveRecoveryMaterial: () => Promise.resolve({ success: true }),
}));

vi.mock('@/capacitor/platform', () => ({
  isNative: () => false,
  getPlatform: () => 'web',
}));

/** Engines lay text and boxes out in whole steps of this fraction of a pixel (Chromium, WebKit). */
const LAYOUT_UNITS_PER_PX = 64;

/** The significant digits a computed `width` is serialized with. */
const SERIALIZED_DIGITS = 6;

/**
 * `layoutReading`: one reading of the list as an engine reports it. Each character is laid out
 * at a whole number of layout units, each item at a whole number of layout units whose computed
 * `width` carries six significant digits, and everything is drawn at an ancestor's scale.
 */
const layoutReading = fc.record({
  /**
   * Every scale in (0, 1] whose product with a width is still a normal double; below 2^-1000 a
   * scaled width underflows, and no engine draws at such a scale.
   */
  scale: fc.double({ min: 2 ** -1000, max: 1, noNaN: true }),
  characterUnits: fc.integer({ min: 1, max: 32 * LAYOUT_UNITS_PER_PX }),
  itemUnits: fc.integer({ min: 64 * LAYOUT_UNITS_PER_PX, max: 800 * LAYOUT_UNITS_PER_PX }),
});

describe('word list column floor (property)', () => {
  const layout = { characterWidth: 10, itemWidth: 200, scale: 1 };
  const itemWidth = document.createElement('style');

  beforeEach(() => {
    document.head.append(itemWidth);
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Range
    ): DOMRect {
      return new DOMRect(0, 0, this.toString().length * layout.characterWidth * layout.scale, 20);
    });
    const elementRect = HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: HTMLElement
    ): DOMRect {
      return this instanceof HTMLLIElement
        ? new DOMRect(0, 0, layout.itemWidth * layout.scale, 20)
        : elementRect.call(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    itemWidth.remove();
  });

  it('floors every scaled, serialized layoutReading at the unscaled widest word rounded up', async () => {
    render(<RecoveryPhraseModal open onOpenChange={vi.fn()} onSuccess={vi.fn()} />);
    const list = await screen.findByRole('list', { name: 'Recovery phrase' });
    const longest = Math.max(
      ...within(list)
        .getAllByRole('listitem')
        .map((item) => item.textContent.length)
    );

    fc.assert(
      fc.property(layoutReading, ({ scale, characterUnits, itemUnits }) => {
        layout.scale = scale;
        layout.characterWidth = characterUnits / LAYOUT_UNITS_PER_PX;
        layout.itemWidth = itemUnits / LAYOUT_UNITS_PER_PX;
        const serialized = Number(layout.itemWidth.toPrecision(SERIALIZED_DIGITS));
        itemWidth.textContent = `li { width: ${String(serialized)}px; }`;

        globalThis.dispatchEvent(new Event('resize'));

        expect(list.style.getPropertyValue('--phrase-word')).toBe(
          `${String(Math.ceil(longest * layout.characterWidth))}px`
        );
      }),
      { seed: PROPERTY_TEST_SEED, numRuns: PROPERTY_TEST_RUNS }
    );
  });
});
