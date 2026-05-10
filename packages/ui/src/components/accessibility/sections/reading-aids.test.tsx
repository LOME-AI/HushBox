import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { ReadingAidsSection } from './reading-aids';
import { useA11yStore } from '../store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '../store/schema';

describe('ReadingAidsSection', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  describe('rendering', () => {
    it('renders the Reading aids section heading', () => {
      render(<ReadingAidsSection />);
      expect(screen.getByRole('heading', { name: /reading aids/i })).toBeInTheDocument();
    });

    it('renders the section element with aria-labelledby pointing to the heading', () => {
      const { container } = render(<ReadingAidsSection />);
      const section = container.querySelector('section');
      const headingId = section?.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      const heading = screen.getByRole('heading', { name: /reading aids/i });
      expect(heading.id).toBe(headingId);
    });

    it('renders the Magnifier switch', () => {
      render(<ReadingAidsSection />);
      expect(screen.getByRole('switch', { name: /magnifier/i })).toBeInTheDocument();
    });

    it('renders the Reading guide switch', () => {
      render(<ReadingAidsSection />);
      expect(screen.getByRole('switch', { name: /reading guide/i })).toBeInTheDocument();
    });

    it('renders the Reader view switch', () => {
      render(<ReadingAidsSection />);
      expect(screen.getByRole('switch', { name: /reader view/i })).toBeInTheDocument();
    });

    it('renders the Page structure switch', () => {
      render(<ReadingAidsSection />);
      expect(screen.getByRole('switch', { name: /page structure/i })).toBeInTheDocument();
    });

    it('renders the Hide images switch', () => {
      render(<ReadingAidsSection />);
      expect(screen.getByRole('switch', { name: /hide images/i })).toBeInTheDocument();
    });
  });

  describe('store integration', () => {
    it('toggling Magnifier updates the store', async () => {
      const user = userEvent.setup();
      render(<ReadingAidsSection />);
      await user.click(screen.getByRole('switch', { name: /magnifier/i }));
      expect(useA11yStore.getState().magnifier).toBe(true);
    });

    it('toggling Reading guide updates the store', async () => {
      const user = userEvent.setup();
      render(<ReadingAidsSection />);
      await user.click(screen.getByRole('switch', { name: /reading guide/i }));
      expect(useA11yStore.getState().readingGuide).toBe(true);
    });

    it('toggling Reader view updates the store', async () => {
      const user = userEvent.setup();
      render(<ReadingAidsSection />);
      await user.click(screen.getByRole('switch', { name: /reader view/i }));
      expect(useA11yStore.getState().readerView).toBe(true);
    });

    it('toggling Page structure updates the store', async () => {
      const user = userEvent.setup();
      render(<ReadingAidsSection />);
      await user.click(screen.getByRole('switch', { name: /page structure/i }));
      expect(useA11yStore.getState().pageStructure).toBe(true);
    });

    it('toggling Hide images updates the store', async () => {
      const user = userEvent.setup();
      render(<ReadingAidsSection />);
      await user.click(screen.getByRole('switch', { name: /hide images/i }));
      expect(useA11yStore.getState().hideImages).toBe(true);
    });
  });

  describe('reactivity', () => {
    it('reflects current store state for Magnifier', () => {
      useA11yStore.setState({ magnifier: true });
      render(<ReadingAidsSection />);
      expect(screen.getByRole('switch', { name: /magnifier/i })).toBeChecked();
    });
  });
});
