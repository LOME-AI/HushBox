import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';

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

const { ttsLoadMock, ttsPreloadVoiceMock } = vi.hoisted(() => ({
  ttsLoadMock: vi.fn(
    (_voice: string, _onProgress?: (l: number, t: number) => void): Promise<void> =>
      Promise.resolve()
  ),
  ttsPreloadVoiceMock: vi.fn((_voice: string): Promise<void> => Promise.resolve()),
}));

vi.mock('../lib/tts-engine', () => ({
  TTS_VOICES: [
    { id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' },
    { id: 'am_michael', displayName: 'Michael', accent: 'American', gender: 'male' },
  ],
  getTtsService: (): {
    load: typeof ttsLoadMock;
    preloadVoice: typeof ttsPreloadVoiceMock;
  } => ({
    load: ttsLoadMock,
    preloadVoice: ttsPreloadVoiceMock,
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
  ttsLoadMock.mockReset();
  ttsLoadMock.mockImplementation(() => Promise.resolve());
  ttsPreloadVoiceMock.mockReset();
  ttsPreloadVoiceMock.mockImplementation(() => Promise.resolve());
});

function clickCard(title: string): void {
  const card = screen.getByRole('button', { name: new RegExp(`^${title}: `) });
  fireEvent.click(card);
}

describe('VisualSection', () => {
  it('renders only the three remaining visual cards', () => {
    render(<VisualSection />);
    for (const title of ['Contrast', 'Color intensity', 'Color-blindness filter']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
  });

  it('does not render removed cards (Reverse colors, Underline links)', () => {
    render(<VisualSection />);
    expect(screen.queryByRole('button', { name: /^Reverse colors/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Underline links/ })).toBeNull();
  });

  it('cycling Contrast calls update with the next value', () => {
    render(<VisualSection />);
    clickCard('Contrast');
    expect(storeState.update).toHaveBeenCalledWith({ contrast: 'increased' });
  });

  it('Color-blindness filter labels use technical term first', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, colorblindSimulate: 'protan' };
    render(<VisualSection />);
    expect(screen.getByText('Protanopia (red-blind)')).not.toBeNull();
  });
});

describe('TypographySection', () => {
  it('renders typography cards (no Align text left)', () => {
    render(<TypographySection />);
    for (const title of [
      'Text size',
      'Space between letters',
      'Space between lines',
      'Space between paragraphs',
      'Font',
    ]) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Align text left/ })).toBeNull();
  });

  it('cycling Text size updates fontSize', () => {
    render(<TypographySection />);
    clickCard('Text size');
    expect(storeState.update).toHaveBeenCalledWith({ fontSize: '112' });
  });

  it('default Font label is "Merriweather (default)"', () => {
    render(<TypographySection />);
    expect(screen.getByText('Merriweather (default)')).not.toBeNull();
  });
});

describe('ReadingAidsSection', () => {
  it('renders the two reading helpers (Page outline removed)', () => {
    render(<ReadingAidsSection />);
    for (const title of ['Magnifier lens', 'Reading band']) {
      expect(screen.getByRole('button', { name: new RegExp(`^${title}: `) })).not.toBeNull();
    }
    expect(screen.queryByRole('button', { name: /^Page outline/ })).toBeNull();
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

  it('clicking Focus ring color while thickness is Off also bumps thickness to Thin', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '0' };
    render(<PointerFocusSection />);
    clickCard('Focus ring color');
    expect(storeState.update).toHaveBeenCalledWith({ focusColor: 'magenta', focusWidth: '2' });
  });

  it('clicking Focus ring color while thickness is non-Off does NOT change thickness', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '4' };
    render(<PointerFocusSection />);
    clickCard('Focus ring color');
    expect(storeState.update).toHaveBeenCalledWith({ focusColor: 'magenta' });
  });

  it('toggling Focus glow ON while thickness is Off also bumps thickness to Thin', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '0', focusHalo: false };
    render(<PointerFocusSection />);
    clickCard('Focus glow');
    expect(storeState.update).toHaveBeenCalledWith({ focusHalo: true, focusWidth: '2' });
  });

  it('toggling Focus glow ON while thickness is already set does NOT touch thickness', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '4', focusHalo: false };
    render(<PointerFocusSection />);
    clickCard('Focus glow');
    expect(storeState.update).toHaveBeenCalledWith({ focusHalo: true });
  });

  it('toggling Focus glow OFF never bumps thickness', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, focusWidth: '0', focusHalo: true };
    render(<PointerFocusSection />);
    clickCard('Focus glow');
    expect(storeState.update).toHaveBeenCalledWith({ focusHalo: false });
  });
});

describe('AudioSection', () => {
  it('renders Mute all sounds + Read chat replies aloud + disclaimer regardless of ttsEnabled', () => {
    render(<AudioSection />);
    expect(screen.getByRole('button', { name: /^Mute all sounds: / })).not.toBeNull();
    expect(screen.getByRole('button', { name: /^Read chat replies aloud: / })).not.toBeNull();
    expect(screen.getByText(/88 MB, one-time download/)).not.toBeNull();
    expect(
      screen.getByText(/Runs entirely on your device\. No audio or text ever leaves this device/)
    ).not.toBeNull();
  });

  it('does NOT render the old "Turn on read-aloud" gate button', () => {
    render(<AudioSection />);
    expect(screen.queryByText(/Turn on read-aloud/)).toBeNull();
  });

  it('renders the same controls when ttsEnabled is already true', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: true };
    render(<AudioSection />);
    expect(screen.getByRole('button', { name: /^Read chat replies aloud: / })).not.toBeNull();
    expect(screen.getByText(/88 MB, one-time download/)).not.toBeNull();
  });

  it('does not render placeholder "Read page" / "Read selection" buttons', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: true };
    render(<AudioSection />);
    expect(screen.queryByText('Read page')).toBeNull();
    expect(screen.queryByText('Read selection')).toBeNull();
  });

  it('voice selector trigger uses the widened (twice as wide) class', () => {
    const { container } = render(<AudioSection />);
    const trigger = container.querySelector('[aria-labelledby="a11y-voice-label"]');
    expect(trigger).not.toBeNull();
    expect(trigger?.className).toContain('w-[22rem]');
  });

  it('first-time enable: loads the model with the currently selected voice so its embedding warms up', async () => {
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: false,
      ttsVoice: 'am_michael',
    };
    render(<AudioSection />);
    fireEvent.click(screen.getByRole('button', { name: /^Read chat replies aloud: / }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ttsLoadMock).toHaveBeenCalledTimes(1);
    expect(ttsLoadMock.mock.calls[0]![0]).toBe('am_michael');
  });

  it('voice change after TTS is enabled triggers preloadVoice() so the new embedding is fetched up front', async () => {
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: true,
      ttsVoice: 'af_heart',
    };
    const { rerender } = render(<AudioSection />);
    expect(ttsPreloadVoiceMock).not.toHaveBeenCalled();
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: true,
      ttsVoice: 'am_michael',
    };
    rerender(<AudioSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ttsPreloadVoiceMock).toHaveBeenCalledTimes(1);
    expect(ttsPreloadVoiceMock).toHaveBeenLastCalledWith('am_michael');
  });

  it('voice change before TTS is enabled does NOT call preloadVoice()', async () => {
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: false,
      ttsVoice: 'af_heart',
    };
    const { rerender } = render(<AudioSection />);
    storeState.prefs = {
      ...ACCESSIBILITY_PREFERENCES_DEFAULTS,
      ttsEnabled: false,
      ttsVoice: 'am_michael',
    };
    rerender(<AudioSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(ttsPreloadVoiceMock).not.toHaveBeenCalled();
  });

  it('download-size disclosure shows the q8/WASM size (~88 MB) unconditionally', async () => {
    render(<AudioSection />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByText(/88 MB, one-time download/)).not.toBeNull();
    expect(screen.queryByText(/330 MB/)).toBeNull();
  });

  it('mid-download, shows bytes loaded/total, speed, and ETA derived from progress callbacks', async () => {
    let capturedOnProgress: ((loaded: number, total: number) => void) | undefined;
    ttsLoadMock.mockImplementation(
      (_voice: string, onProgress?: (l: number, t: number) => void): Promise<void> => {
        capturedOnProgress = onProgress;
        // Never resolves — we want to inspect the mid-download UI.
        return new Promise<void>(() => {});
      }
    );

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date(1_700_000_000_000));

      storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, ttsEnabled: false };
      render(<AudioSection />);
      fireEvent.click(screen.getByRole('button', { name: /^Read chat replies aloud: / }));

      // Flush the microtask that invokes load() inside the handler.
      await act(async () => {
        await Promise.resolve();
      });
      expect(capturedOnProgress).toBeDefined();

      const MB = 1_048_576;
      act(() => {
        capturedOnProgress!(0, 88 * MB);
      });
      vi.setSystemTime(new Date(1_700_000_001_000));
      act(() => {
        capturedOnProgress!(4 * MB, 88 * MB);
      });

      expect(screen.getByText(/4\.0 \/ 88 MB/)).not.toBeNull();
      expect(screen.getByText(/4\.0 MB\/s/)).not.toBeNull();
      expect(screen.getByText(/21s left/)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
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
  it('renders all five profile entries plus a Default entry', () => {
    render(<ProfilesSection />);
    const buttons = screen.getAllByRole('button');
    expect(buttons.length).toBeGreaterThanOrEqual(6);
  });

  it('renders a Default quick-start button as the first entry', () => {
    render(<ProfilesSection />);
    const first = screen.getAllByRole('button')[0]!;
    expect(first.textContent).toContain('Default');
  });

  it('clicking the Default button calls reset() only (no update)', () => {
    render(<ProfilesSection />);
    const first = screen.getAllByRole('button')[0]!;
    fireEvent.click(first);
    expect(storeState.reset).toHaveBeenCalledTimes(1);
    expect(storeState.update).not.toHaveBeenCalled();
  });

  it('clicking a profile calls reset() then update(profile.preset)', () => {
    render(<ProfilesSection />);
    // Default is index 0; first real profile is index 1.
    const firstProfile = screen.getAllByRole('button')[1]!;
    fireEvent.click(firstProfile);
    expect(storeState.reset).toHaveBeenCalledTimes(1);
    expect(storeState.update).toHaveBeenCalledTimes(1);
    const passed = (storeState.update as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(Object.keys(passed as Record<string, unknown>).length).toBeGreaterThanOrEqual(
      Object.keys(ACCESSIBILITY_PREFERENCES_DEFAULTS).length
    );
  });

  it('every quick-start button uses cursor-pointer', () => {
    render(<ProfilesSection />);
    for (const button of screen.getAllByRole('button')) {
      expect(button.className).toContain('cursor-pointer');
    }
  });
});
