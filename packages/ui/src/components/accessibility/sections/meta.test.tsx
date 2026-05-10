import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MetaSection } from './meta';
import { useA11yStore } from '../store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '../store/schema';

interface MqlMock {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function installMatchMedia(matchMap: Record<string, boolean>): void {
  const mockMatchMedia = vi.fn((query: string): MqlMock => {
    const matches = matchMap[query] ?? false;
    return {
      matches,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
  });
  vi.stubGlobal('matchMedia', mockMatchMedia);
}

describe('MetaSection', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
    installMatchMedia({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('rendering', () => {
    it('renders the Reset to defaults button', () => {
      render(<MetaSection />);
      expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeInTheDocument();
    });

    it('renders the Reset to OS preferences button', () => {
      render(<MetaSection />);
      expect(screen.getByRole('button', { name: /reset to os preferences/i })).toBeInTheDocument();
    });
  });

  describe('Reset to defaults', () => {
    it('clicking Reset to defaults restores all values to defaults', async () => {
      const user = userEvent.setup();
      useA11yStore.setState({
        theme: 'dark',
        contrast: 'high',
        fontSize: '200',
        invert: true,
      });
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to defaults/i }));

      const state = useA11yStore.getState();
      expect(state.theme).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.theme);
      expect(state.contrast).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.contrast);
      expect(state.fontSize).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.fontSize);
      expect(state.invert).toBe(ACCESSIBILITY_PREFERENCES_DEFAULTS.invert);
    });
  });

  describe('Reset to OS preferences', () => {
    it('applies OS dark scheme preference to theme', async () => {
      installMatchMedia({ '(prefers-color-scheme: dark)': true });
      const user = userEvent.setup();
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to os preferences/i }));
      expect(useA11yStore.getState().theme).toBe('dark');
    });

    it('applies OS light scheme preference to theme', async () => {
      installMatchMedia({ '(prefers-color-scheme: light)': true });
      const user = userEvent.setup();
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to os preferences/i }));
      expect(useA11yStore.getState().theme).toBe('light');
    });

    it('falls back to system theme when no OS color-scheme preference is set', async () => {
      installMatchMedia({});
      const user = userEvent.setup();
      useA11yStore.setState({ theme: 'dark' });
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to os preferences/i }));
      expect(useA11yStore.getState().theme).toBe('system');
    });

    it('forces stopAnimations to "force-on" when OS prefers reduced motion', async () => {
      installMatchMedia({ '(prefers-reduced-motion: reduce)': true });
      const user = userEvent.setup();
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to os preferences/i }));
      expect(useA11yStore.getState().stopAnimations).toBe('force-on');
    });

    it('keeps stopAnimations at "system" when OS does not prefer reduced motion', async () => {
      installMatchMedia({});
      const user = userEvent.setup();
      useA11yStore.setState({ stopAnimations: 'force-on' });
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to os preferences/i }));
      expect(useA11yStore.getState().stopAnimations).toBe('system');
    });

    it('applies high contrast when OS prefers more contrast', async () => {
      installMatchMedia({ '(prefers-contrast: more)': true });
      const user = userEvent.setup();
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to os preferences/i }));
      expect(useA11yStore.getState().contrast).toBe('high');
    });

    it('applies low contrast when OS prefers less contrast', async () => {
      installMatchMedia({ '(prefers-contrast: less)': true });
      const user = userEvent.setup();
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to os preferences/i }));
      expect(useA11yStore.getState().contrast).toBe('low');
    });

    it('keeps contrast at normal when OS does not signal a contrast preference', async () => {
      installMatchMedia({});
      const user = userEvent.setup();
      useA11yStore.setState({ contrast: 'high' });
      render(<MetaSection />);
      await user.click(screen.getByRole('button', { name: /reset to os preferences/i }));
      expect(useA11yStore.getState().contrast).toBe('normal');
    });
  });
});
