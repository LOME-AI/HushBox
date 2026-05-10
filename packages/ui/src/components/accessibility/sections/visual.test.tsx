import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { VisualSection } from './visual';
import { useA11yStore } from '../store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '../store/schema';

describe('VisualSection', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  describe('rendering', () => {
    it('renders the Visual section heading', () => {
      render(<VisualSection />);
      expect(screen.getByRole('heading', { name: /visual/i })).toBeInTheDocument();
    });

    it('renders the section element with aria-labelledby pointing to the heading', () => {
      const { container } = render(<VisualSection />);
      const section = container.querySelector('section');
      expect(section).not.toBeNull();
      const headingId = section?.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      const heading = screen.getByRole('heading', { name: /visual/i });
      expect(heading.id).toBe(headingId);
    });

    it('renders the Theme cycle button', () => {
      render(<VisualSection />);
      expect(screen.getByRole('button', { name: /theme.*system/i })).toBeInTheDocument();
    });

    it('renders the Contrast cycle button', () => {
      render(<VisualSection />);
      expect(screen.getByRole('button', { name: /contrast.*normal/i })).toBeInTheDocument();
    });

    it('renders the Saturation cycle button', () => {
      render(<VisualSection />);
      expect(screen.getByRole('button', { name: /saturation.*100/i })).toBeInTheDocument();
    });

    it('renders the Invert cycle button', () => {
      render(<VisualSection />);
      expect(screen.getByRole('button', { name: /invert.*off/i })).toBeInTheDocument();
    });

    it('renders the Highlight links switch', () => {
      render(<VisualSection />);
      expect(screen.getByRole('switch', { name: /highlight links/i })).toBeInTheDocument();
    });

    it('renders the colorblind simulate radiogroup with all 6 options', () => {
      render(<VisualSection />);
      const group = screen.getByRole('radiogroup', { name: /color vision.*simulate/i });
      const radios = group.querySelectorAll('[role="radio"]');
      expect(radios).toHaveLength(6);
    });

    it('renders the colorblind correct radiogroup with all 5 options', () => {
      render(<VisualSection />);
      const group = screen.getByRole('radiogroup', { name: /color vision.*correct/i });
      const radios = group.querySelectorAll('[role="radio"]');
      expect(radios).toHaveLength(5);
    });
  });

  describe('store integration', () => {
    it('clicking Theme cycles to the next value via store.update', async () => {
      const user = userEvent.setup();
      render(<VisualSection />);
      await user.click(screen.getByRole('button', { name: /theme.*system/i }));
      expect(useA11yStore.getState().theme).toBe('light');
    });

    it('clicking Contrast cycles to the next value via store.update', async () => {
      const user = userEvent.setup();
      render(<VisualSection />);
      await user.click(screen.getByRole('button', { name: /contrast.*normal/i }));
      expect(useA11yStore.getState().contrast).toBe('increased');
    });

    it('clicking Saturation cycles to the next value via store.update', async () => {
      const user = userEvent.setup();
      render(<VisualSection />);
      await user.click(screen.getByRole('button', { name: /saturation.*100/i }));
      expect(useA11yStore.getState().saturation).toBe('150');
    });

    it('clicking Invert toggles invert via store.update', async () => {
      const user = userEvent.setup();
      render(<VisualSection />);
      await user.click(screen.getByRole('button', { name: /invert.*off/i }));
      expect(useA11yStore.getState().invert).toBe(true);
    });

    it('toggling Highlight links updates the store', async () => {
      const user = userEvent.setup();
      render(<VisualSection />);
      await user.click(screen.getByRole('switch', { name: /highlight links/i }));
      expect(useA11yStore.getState().highlightLinks).toBe(true);
    });

    it('selecting a colorblind simulate option updates the store', async () => {
      const user = userEvent.setup();
      render(<VisualSection />);
      const group = screen.getByRole('radiogroup', { name: /color vision.*simulate/i });
      const protan = group.querySelector('[role="radio"][aria-checked="false"]');
      // first non-selected option is "Protan" (since "None" is the default)
      expect(protan).not.toBeNull();
      await user.click(protan!);
      expect(useA11yStore.getState().colorblindSimulate).toBe('protan');
    });

    it('selecting a colorblind correct option updates the store', async () => {
      const user = userEvent.setup();
      render(<VisualSection />);
      const group = screen.getByRole('radiogroup', { name: /color vision.*correct/i });
      const protan = group.querySelector('[role="radio"][aria-checked="false"]');
      expect(protan).not.toBeNull();
      await user.click(protan!);
      expect(useA11yStore.getState().colorblindCorrect).toBe('protan');
    });
  });

  describe('reactivity', () => {
    it('reflects current store state for Theme', () => {
      useA11yStore.setState({ theme: 'dark' });
      render(<VisualSection />);
      expect(screen.getByRole('button', { name: /theme.*dark/i })).toBeInTheDocument();
    });

    it('reflects current store state for the colorblind simulate selection', () => {
      useA11yStore.setState({ colorblindSimulate: 'tritan' });
      render(<VisualSection />);
      const group = screen.getByRole('radiogroup', { name: /color vision.*simulate/i });
      const tritan = group.querySelector('[role="radio"][aria-checked="true"]');
      expect(tritan?.textContent).toMatch(/tritan/i);
    });
  });
});
