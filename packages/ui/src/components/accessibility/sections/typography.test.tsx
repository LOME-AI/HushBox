import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { AccessibilityFont } from '../fonts/registry';

const activateFontMock = vi.fn<(id: AccessibilityFont['id']) => Promise<void>>(() =>
  Promise.resolve()
);

vi.mock('../lib/font-loader', () => ({
  activateFont: (id: AccessibilityFont['id']): Promise<void> => activateFontMock(id),
  _resetFontLoaderForTesting: vi.fn(),
}));

import { TypographySection } from './typography';
import { useA11yStore } from '../store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '../store/schema';
import { ACCESSIBILITY_FONTS } from '../fonts/registry';

describe('TypographySection', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
    activateFontMock.mockClear();
  });

  describe('rendering', () => {
    it('renders the Typography section heading', () => {
      render(<TypographySection />);
      expect(screen.getByRole('heading', { name: /typography/i })).toBeInTheDocument();
    });

    it('renders the section element with aria-labelledby pointing to the heading', () => {
      const { container } = render(<TypographySection />);
      const section = container.querySelector('section');
      expect(section).not.toBeNull();
      const headingId = section?.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      const heading = screen.getByRole('heading', { name: /typography/i });
      expect(heading.id).toBe(headingId);
    });

    it('renders the Font size cycle button', () => {
      render(<TypographySection />);
      expect(screen.getByRole('button', { name: /font size.*100/i })).toBeInTheDocument();
    });

    it('renders the Letter spacing cycle button', () => {
      render(<TypographySection />);
      expect(screen.getByRole('button', { name: /letter spacing/i })).toBeInTheDocument();
    });

    it('renders the Line height cycle button', () => {
      render(<TypographySection />);
      expect(screen.getByRole('button', { name: /line height.*1\.5/i })).toBeInTheDocument();
    });

    it('renders the Paragraph spacing cycle button', () => {
      render(<TypographySection />);
      expect(screen.getByRole('button', { name: /paragraph spacing/i })).toBeInTheDocument();
    });

    it('renders the Force left-align switch', () => {
      render(<TypographySection />);
      expect(screen.getByRole('switch', { name: /force left.?align/i })).toBeInTheDocument();
    });
  });

  describe('font picker', () => {
    it('renders one FontCard per registered accessibility font', () => {
      const { container } = render(<TypographySection />);
      const cards = container.querySelectorAll('[data-slot="font-card"]');
      expect(cards).toHaveLength(ACCESSIBILITY_FONTS.length);
    });

    it('renders the purpose text for every registered font', () => {
      render(<TypographySection />);
      for (const font of ACCESSIBILITY_FONTS) {
        expect(screen.getByText(font.purpose)).toBeInTheDocument();
      }
    });

    it('renders the display name for every registered font', () => {
      render(<TypographySection />);
      for (const font of ACCESSIBILITY_FONTS) {
        expect(screen.getByText(font.displayName)).toBeInTheDocument();
      }
    });

    it('marks the card matching fontFamily=system as selected by default', () => {
      const { container } = render(<TypographySection />);
      const selectedCards = container.querySelectorAll('[data-slot="font-card"][data-state="on"]');
      expect(selectedCards).toHaveLength(1);
      const systemFont = ACCESSIBILITY_FONTS.find((f) => f.id === 'system')!;
      expect(selectedCards[0]?.textContent).toContain(systemFont.purpose);
    });

    it('marks the card matching the current store fontFamily value as selected', () => {
      useA11yStore.setState({ fontFamily: 'lexend' });
      const { container } = render(<TypographySection />);
      const selectedCards = container.querySelectorAll('[data-slot="font-card"][data-state="on"]');
      expect(selectedCards).toHaveLength(1);
      expect(selectedCards[0]?.textContent).toContain('Lexend');
    });

    it('groups the font cards in a radiogroup labeled by a font-family heading', () => {
      render(<TypographySection />);
      const radiogroup = screen.getByRole('radiogroup', { name: /font family/i });
      expect(radiogroup).toBeInTheDocument();
    });
  });

  describe('font picker interactions', () => {
    it('clicking a non-system font card calls update with that font id', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      const atkinsonCard = screen.getByRole('button', { name: /low vision.*atkinson/i });
      await user.click(atkinsonCard);
      expect(useA11yStore.getState().fontFamily).toBe('atkinson');
    });

    it('clicking a non-system font card calls activateFont with that id', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      const atkinsonCard = screen.getByRole('button', { name: /low vision.*atkinson/i });
      await user.click(atkinsonCard);
      expect(activateFontMock).toHaveBeenCalledWith('atkinson');
    });

    it('clicking the system card sets fontFamily to system in the store', async () => {
      useA11yStore.setState({ fontFamily: 'lexend' });
      const user = userEvent.setup();
      render(<TypographySection />);
      const systemCard = screen.getByRole('button', { name: /site default.*merriweather/i });
      await user.click(systemCard);
      expect(useA11yStore.getState().fontFamily).toBe('system');
    });

    it('clicking the system card does NOT call activateFont', async () => {
      useA11yStore.setState({ fontFamily: 'lexend' });
      const user = userEvent.setup();
      render(<TypographySection />);
      const systemCard = screen.getByRole('button', { name: /site default.*merriweather/i });
      await user.click(systemCard);
      expect(activateFontMock).not.toHaveBeenCalled();
    });

    it('clicking the open-dyslexic card updates the store and calls activateFont', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      const card = screen.getByRole('button', { name: /dyslexia.*opendyslexic/i });
      await user.click(card);
      expect(useA11yStore.getState().fontFamily).toBe('open-dyslexic');
      expect(activateFontMock).toHaveBeenCalledWith('open-dyslexic');
    });

    it('clicking the lexend card updates the store and calls activateFont', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      const card = screen.getByRole('button', { name: /reading speed.*lexend/i });
      await user.click(card);
      expect(useA11yStore.getState().fontFamily).toBe('lexend');
      expect(activateFontMock).toHaveBeenCalledWith('lexend');
    });
  });

  describe('store integration', () => {
    it('clicking Font size cycles to the next value', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      await user.click(screen.getByRole('button', { name: /font size.*100/i }));
      expect(useA11yStore.getState().fontSize).toBe('125');
    });

    it('clicking Letter spacing cycles to the next value', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      await user.click(screen.getByRole('button', { name: /letter spacing/i }));
      expect(useA11yStore.getState().letterSpacing).toBe('0.05');
    });

    it('clicking Line height cycles to the next value', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      await user.click(screen.getByRole('button', { name: /line height.*1\.5/i }));
      expect(useA11yStore.getState().lineHeight).toBe('2.0');
    });

    it('clicking Paragraph spacing cycles to the next value', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      await user.click(screen.getByRole('button', { name: /paragraph spacing/i }));
      expect(useA11yStore.getState().paragraphSpacing).toBe('2');
    });

    it('toggling Force left-align updates the store', async () => {
      const user = userEvent.setup();
      render(<TypographySection />);
      await user.click(screen.getByRole('switch', { name: /force left.?align/i }));
      expect(useA11yStore.getState().forceLeftAlign).toBe(true);
    });
  });

  describe('reactivity', () => {
    it('reflects current store state for Font size', () => {
      useA11yStore.setState({ fontSize: '175' });
      render(<TypographySection />);
      expect(screen.getByRole('button', { name: /font size.*175/i })).toBeInTheDocument();
    });

    it('reflects current store state for Force left-align', () => {
      useA11yStore.setState({ forceLeftAlign: true });
      render(<TypographySection />);
      expect(screen.getByRole('switch', { name: /force left.?align/i })).toBeChecked();
    });
  });
});
