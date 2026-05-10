import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, beforeEach } from 'vitest';
import { ProfilesSection } from './profiles';
import { useA11yStore } from '../store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from '../store/schema';
import { ACCESSIBILITY_PROFILES, getProfile } from '../lib/profiles';

describe('ProfilesSection', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
  });

  describe('rendering', () => {
    it('renders the Profiles section heading', () => {
      render(<ProfilesSection />);
      expect(screen.getByRole('heading', { name: /profiles/i })).toBeInTheDocument();
    });

    it('renders the section element with aria-labelledby pointing to the heading', () => {
      const { container } = render(<ProfilesSection />);
      const section = container.querySelector('section');
      const headingId = section?.getAttribute('aria-labelledby');
      expect(headingId).toBeTruthy();
      const heading = screen.getByRole('heading', { name: /profiles/i });
      expect(heading.id).toBe(headingId);
    });

    it('renders one button per ACCESSIBILITY_PROFILES entry', () => {
      render(<ProfilesSection />);
      for (const profile of ACCESSIBILITY_PROFILES) {
        expect(
          screen.getByRole('button', { name: new RegExp(profile.label, 'i') })
        ).toBeInTheDocument();
      }
    });

    it('renders the profile description for each profile', () => {
      render(<ProfilesSection />);
      for (const profile of ACCESSIBILITY_PROFILES) {
        expect(screen.getByText(profile.description)).toBeInTheDocument();
      }
    });
  });

  describe('store integration', () => {
    it('clicking a profile merges its preset into the store', async () => {
      const user = userEvent.setup();
      render(<ProfilesSection />);

      const visionProfile = getProfile('vision-friendly');
      expect(visionProfile).toBeDefined();
      await user.click(screen.getByRole('button', { name: new RegExp(visionProfile!.label, 'i') }));

      const state = useA11yStore.getState();
      // From the vision-friendly preset
      expect(state.contrast).toBe('high');
      expect(state.fontSize).toBe('150');
      expect(state.focusWidth).toBe('4');
      expect(state.focusHalo).toBe(true);
      expect(state.cursorSize).toBe('large');
    });

    it('preserves store fields not present in the preset', async () => {
      const user = userEvent.setup();
      useA11yStore.setState({ muteSounds: true });
      render(<ProfilesSection />);

      const visionProfile = getProfile('vision-friendly');
      await user.click(screen.getByRole('button', { name: new RegExp(visionProfile!.label, 'i') }));

      // muteSounds is not in vision-friendly preset; should remain true
      expect(useA11yStore.getState().muteSounds).toBe(true);
    });
  });
});
