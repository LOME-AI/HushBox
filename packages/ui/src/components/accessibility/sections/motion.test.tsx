import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { MotionSection } from './motion';
import { useA11yStore } from '../store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '../store/schema';

describe('MotionSection', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  describe('rendering', () => {
    it('renders the Motion section heading', () => {
      render(<MotionSection />);
      expect(screen.getByRole('heading', { name: /motion/i })).toBeInTheDocument();
    });

    it('renders the section element with aria-labelledby pointing to the heading', () => {
      const { container } = render(<MotionSection />);
      const section = container.querySelector('section');
      const headingId = section?.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      const heading = screen.getByRole('heading', { name: /motion/i });
      expect(heading.id).toBe(headingId);
    });

    it('renders the Stop animations cycle button starting at System', () => {
      render(<MotionSection />);
      expect(screen.getByRole('button', { name: /stop animations.*system/i })).toBeInTheDocument();
    });
  });

  describe('store integration', () => {
    it('clicking Stop animations cycles to "force on"', async () => {
      const user = userEvent.setup();
      render(<MotionSection />);
      await user.click(screen.getByRole('button', { name: /stop animations.*system/i }));
      expect(useA11yStore.getState().stopAnimations).toBe('force-on');
    });

    it('cycles through all three states (system → force-on → force-off → system)', async () => {
      const user = userEvent.setup();
      render(<MotionSection />);

      const button = screen.getByRole('button', { name: /stop animations/i });
      await user.click(button);
      expect(useA11yStore.getState().stopAnimations).toBe('force-on');

      await user.click(button);
      expect(useA11yStore.getState().stopAnimations).toBe('force-off');

      await user.click(button);
      expect(useA11yStore.getState().stopAnimations).toBe('system');
    });
  });

  describe('reactivity', () => {
    it('reflects current store state for Stop animations', () => {
      useA11yStore.setState({ stopAnimations: 'force-off' });
      render(<MotionSection />);
      expect(
        screen.getByRole('button', { name: /stop animations.*force off/i })
      ).toBeInTheDocument();
    });
  });
});
