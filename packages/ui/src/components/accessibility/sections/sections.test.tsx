import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { ACCESSIBILITY_PREFERENCES_DEFAULTS, type AccessibilityPreferences } from '@hushbox/shared';

const storeState: {
  prefs: AccessibilityPreferences;
  update: (changes: Partial<AccessibilityPreferences>) => void;
  reset: () => void;
} = {
  prefs: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS },
  update: vi.fn(),
  reset: vi.fn(),
};

vi.mock('../store', () => ({
  useA11yStore: <T,>(
    selector: (
      state: AccessibilityPreferences & {
        update: (changes: Partial<AccessibilityPreferences>) => void;
        reset: () => void;
      }
    ) => T
  ): T =>
    selector({
      ...storeState.prefs,
      update: storeState.update,
      reset: storeState.reset,
    }),
}));

vi.mock('../../../hooks/use-is-touch-device', () => ({
  useIsTouchDevice: (): boolean => false,
}));

vi.mock('../lib/font-loader', () => ({
  activateFont: vi.fn().mockResolvedValue(true),
}));

vi.mock('../lib/tts-engine', () => ({
  TTS_VOICES: [{ id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' }],
  getTtsService: (): { load: () => Promise<void> } => ({
    load: async () => {
      await Promise.resolve();
    },
  }),
}));

import { VisualSection } from './visual';
import { TypographySection } from './typography';
import { ReadingAidsSection } from './reading-aids';
import { MotionSection } from './motion';
import { PointerFocusSection } from './pointer-focus';
import { AudioSection } from './audio';
import { MetaSection } from './meta';
import { ProfilesSection } from './profiles';

beforeEach(() => {
  storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS };
  (storeState.update as ReturnType<typeof vi.fn>).mockReset();
  (storeState.reset as ReturnType<typeof vi.fn>).mockReset();
});

function clickCard(title: string): void {
  const card = screen.getByRole('button', { name: new RegExp(`^${title}: `) });
  fireEvent.click(card);
}

describe('VisualSection', () => {
  it('renders one card per visual setting', () => {
    render(<VisualSection />);
    for (const title of [
      'Contrast',
      'Color intensity',
      'Reverse colors',
      'Underline links',
      'Color-blindness filter',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
  });

  it('cycling Contrast calls update with the next value', () => {
    render(<VisualSection />);
    clickCard('Contrast');
    expect(storeState.update).toHaveBeenCalledWith({ contrast: 'increased' });
  });

  it('toggling Reverse colors maps off→on to a boolean update', () => {
    render(<VisualSection />);
    clickCard('Reverse colors');
    expect(storeState.update).toHaveBeenCalledWith({ invert: true });
  });

  it('toggling Underline links maps off→on to a boolean update', () => {
    render(<VisualSection />);
    clickCard('Underline links');
    expect(storeState.update).toHaveBeenCalledWith({ highlightLinks: true });
  });
});

describe('TypographySection', () => {
  it('renders all typography cards including Font', () => {
    render(<TypographySection />);
    for (const title of [
      'Text size',
      'Space between letters',
      'Space between lines',
      'Space between paragraphs',
      'Align text left',
      'Font',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
  });

  it('cycling Text size updates fontSize', () => {
    render(<TypographySection />);
    clickCard('Text size');
    expect(storeState.update).toHaveBeenCalledWith({ fontSize: '125' });
  });
});

describe('ReadingAidsSection', () => {
  it('renders the three reading helpers', () => {
    render(<ReadingAidsSection />);
    for (const title of ['Magnifier lens', 'Reading band', 'Page outline']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
  });

  it('does not render the removed Hide images card', () => {
    render(<ReadingAidsSection />);
    expect(screen.queryByRole('button', { name: /Hide images/ })).toBeNull();
  });

  it('toggling Magnifier lens calls update with magnifier:true', () => {
    render(<ReadingAidsSection />);
    clickCard('Magnifier lens');
    expect(storeState.update).toHaveBeenCalledWith({ magnifier: true });
  });
});

describe('MotionSection', () => {
  it('renders a single Animations card', () => {
    render(<MotionSection />);
    expect(screen.getByRole('button', { name: /^Animations: / })).not.toBeNull();
  });

  it('toggling Animations (Allow → Stop) writes stopAnimations:true', () => {
    render(<MotionSection />);
    clickCard('Animations');
    expect(storeState.update).toHaveBeenCalledWith({ stopAnimations: true });
  });
});

describe('PointerFocusSection', () => {
  it('renders the pointer and focus cards (non-touch device)', () => {
    render(<PointerFocusSection />);
    for (const title of [
      'Pointer size',
      'Pointer color',
      'Focus ring thickness',
      'Focus ring color',
      'Focus glow',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
  });

  it('Pointer color only offers black / white (no system)', () => {
    render(<PointerFocusSection />);
    const button = screen.getByRole('button', { name: /^Pointer color: / });
    expect(button.getAttribute('aria-label')).toMatch(/Black|White/);
  });

  it('cycling Pointer color from black goes to white', () => {
    render(<PointerFocusSection />);
    clickCard('Pointer color');
    expect(storeState.update).toHaveBeenCalledWith({ cursorColor: 'white' });
  });
});

describe('AudioSection', () => {
  it('renders Mute all sounds card and TTS gate when ttsEnabled is false', () => {
    render(<AudioSection />);
    expect(screen.getByRole('button', { name: /^Mute all sounds: / })).not.toBeNull();
    expect(screen.getByText(/Turn on read-aloud/)).not.toBeNull();
  });

  it('renders read-aloud controls when ttsEnabled is true', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: true };
    render(<AudioSection />);
    expect(screen.getByRole('button', { name: /^Read chat replies aloud: / })).not.toBeNull();
  });

  it('does not render placeholder "Read page" / "Read selection" buttons', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: true };
    render(<AudioSection />);
    expect(screen.queryByText('Read page')).toBeNull();
    expect(screen.queryByText('Read selection')).toBeNull();
  });
});

describe('MetaSection', () => {
  it('renders a reset-to-defaults button', () => {
    render(<MetaSection />);
    expect(screen.getByRole('button', { name: /Reset all to defaults/ })).not.toBeNull();
  });

  it('does NOT render a Reset to OS preferences button', () => {
    render(<MetaSection />);
    expect(screen.queryByRole('button', { name: /OS preferences/i })).toBeNull();
  });

  it('clicking Reset all to defaults invokes the store reset', () => {
    render(<MetaSection />);
    fireEvent.click(screen.getByRole('button', { name: /Reset all to defaults/ }));
    expect(storeState.reset).toHaveBeenCalledTimes(1);
  });
});

describe('ProfilesSection', () => {
  it('renders all five profile entries', () => {
    render(<ProfilesSection />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(5);
  });

  it('clicking a profile calls reset() then update(profile.preset)', () => {
    render(<ProfilesSection />);
    const firstProfile = screen.getAllByRole('button')[0]!;
    fireEvent.click(firstProfile);
    expect(storeState.reset).toHaveBeenCalledTimes(1);
    expect(storeState.update).toHaveBeenCalledTimes(1);
    const passed = (storeState.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(Object.keys(passed as Record<string, unknown>).length).toBeGreaterThanOrEqual(
      Object.keys(ACCESSIBILITY_PREFERENCES_DEFAULTS).length
    );
  });
});
