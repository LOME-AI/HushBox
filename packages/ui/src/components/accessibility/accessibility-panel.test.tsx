import { render, screen, act } from '@testing-library/react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  applySettingsMock,
  installMediaPauserMock,
  installMutePauserMock,
  mediaPauserCleanup,
  mutePauserCleanup,
  magnifierMock,
  readingGuideMock,
  pageStructureMock,
  TTS_VOICES_MOCK,
} = vi.hoisted(() => ({
  applySettingsMock: vi.fn(),
  installMediaPauserMock: vi.fn(),
  installMutePauserMock: vi.fn(),
  mediaPauserCleanup: vi.fn(),
  mutePauserCleanup: vi.fn(),
  magnifierMock: vi.fn(),
  readingGuideMock: vi.fn(),
  pageStructureMock: vi.fn(),
  TTS_VOICES_MOCK: [
    { id: 'af_heart', displayName: 'Heart', accent: 'American', gender: 'female' },
    { id: 'am_michael', displayName: 'Michael', accent: 'American', gender: 'male' },
    { id: 'bf_emma', displayName: 'Emma', accent: 'British', gender: 'female' },
    { id: 'bm_george', displayName: 'George', accent: 'British', gender: 'male' },
    { id: 'af_nicole', displayName: 'Nicole', accent: 'American', gender: 'female' },
  ] as const,
}));

// The TTS engine pulls in kokoro-js / phonemizer, both of which evaluate large
// WASM modules at import time. Replace the module surface so the AudioSection
// (and therefore this panel) can be unit-tested without dragging the model in.
vi.mock('./lib/tts-engine', () => ({
  TTS_VOICES: TTS_VOICES_MOCK,
  getTtsService: () => ({
    load: vi.fn(),
    isLoaded: vi.fn().mockReturnValue(false),
    speak: vi.fn(),
    stop: vi.fn(),
    unlockAudio: vi.fn(),
  }),
}));

vi.mock('./lib/apply-settings', () => ({
  applySettings: applySettingsMock,
}));

vi.mock('./lib/media-pauser', () => ({
  installMediaPauser: installMediaPauserMock,
}));

vi.mock('./lib/mute', () => ({
  installMutePauser: installMutePauserMock,
}));

vi.mock('./sections/aids/magnifier', () => ({
  Magnifier: (props: { enabled?: boolean }): React.JSX.Element => {
    magnifierMock(props);
    return <div data-testid="mock-magnifier" />;
  },
}));

vi.mock('./sections/aids/reading-guide', () => ({
  ReadingGuide: (props: { enabled?: boolean }): React.JSX.Element => {
    readingGuideMock(props);
    return <div data-testid="mock-reading-guide" />;
  },
}));

vi.mock('./sections/aids/page-structure', () => ({
  PageStructure: (props: { enabled?: boolean }): React.JSX.Element => {
    pageStructureMock(props);
    return <div data-testid="mock-page-structure" />;
  },
}));

interface MqlMock {
  matches: boolean;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

function installMatchMedia(matchMap: Record<string, boolean> = {}): void {
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

import * as React from 'react';
import { AccessibilityPanel } from './accessibility-panel';
import { useA11yStore } from './store';
import { ACCESSIBILITY_PREFERENCES_DEFAULTS } from './store/schema';

describe('AccessibilityPanel', () => {
  beforeEach(() => {
    globalThis.window.localStorage.clear();
    useA11yStore.setState({ ...ACCESSIBILITY_PREFERENCES_DEFAULTS });
    applySettingsMock.mockReset();
    installMediaPauserMock.mockReset();
    installMutePauserMock.mockReset();
    mediaPauserCleanup.mockReset();
    mutePauserCleanup.mockReset();
    magnifierMock.mockReset();
    readingGuideMock.mockReset();
    pageStructureMock.mockReset();
    installMediaPauserMock.mockReturnValue(mediaPauserCleanup);
    installMutePauserMock.mockReturnValue(mutePauserCleanup);
    installMatchMedia({});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('section composition', () => {
    it('renders the Profiles section', () => {
      render(<AccessibilityPanel />);
      expect(screen.getByRole('heading', { name: /profiles/i })).toBeInTheDocument();
    });

    it('renders the Visual section', () => {
      render(<AccessibilityPanel />);
      expect(screen.getByRole('heading', { name: /visual/i })).toBeInTheDocument();
    });

    it('renders the Typography section', () => {
      render(<AccessibilityPanel />);
      expect(screen.getByRole('heading', { name: /typography/i })).toBeInTheDocument();
    });

    it('renders the Reading aids section', () => {
      render(<AccessibilityPanel />);
      expect(screen.getByRole('heading', { name: /reading aids/i })).toBeInTheDocument();
    });

    it('renders the Audio section', () => {
      render(<AccessibilityPanel />);
      expect(screen.getByRole('heading', { name: /audio/i })).toBeInTheDocument();
    });

    it('renders the Motion section', () => {
      render(<AccessibilityPanel />);
      expect(screen.getByRole('heading', { name: /motion/i })).toBeInTheDocument();
    });

    it('renders the Pointer & focus section', () => {
      render(<AccessibilityPanel />);
      expect(screen.getByRole('heading', { name: /pointer.*focus/i })).toBeInTheDocument();
    });

    it('renders the Meta (Reset) section', () => {
      render(<AccessibilityPanel />);
      expect(screen.getByRole('button', { name: /reset to defaults/i })).toBeInTheDocument();
    });

    it('renders sections in the canonical order: Profiles, Visual, Typography, Reading aids, Audio, Motion, Pointer & focus, Meta', () => {
      const { container } = render(<AccessibilityPanel />);
      const sections = [...container.querySelectorAll('section')];
      const headingTexts = sections.map(
        (s) => s.querySelector('h2')?.textContent.toLowerCase().trim() ?? ''
      );
      // Pointer & focus uses HTML entity for ampersand, normalize for comparison
      expect(headingTexts.length).toBeGreaterThanOrEqual(8);
      expect(headingTexts[0]).toMatch(/profiles/);
      expect(headingTexts[1]).toMatch(/visual/);
      expect(headingTexts[2]).toMatch(/typography/);
      expect(headingTexts[3]).toMatch(/reading aids/);
      expect(headingTexts[4]).toMatch(/audio/);
      expect(headingTexts[5]).toMatch(/motion/);
      expect(headingTexts[6]).toMatch(/pointer/);
      // Meta section uses sr-only "Reset" heading; index 7
      expect(headingTexts[7]).toMatch(/reset/);
    });
  });

  describe('SvgColorblindDefs', () => {
    it('mounts the SVG colorblind defs once', () => {
      const { container } = render(<AccessibilityPanel />);
      const filters = container.querySelectorAll('filter');
      expect(filters.length).toBeGreaterThan(0);
    });

    it('includes the protan colorblind filter', () => {
      const { container } = render(<AccessibilityPanel />);
      expect(container.querySelector('filter#a11y-cb-protan')).not.toBeNull();
    });

    it('includes the deutan, tritan, achroma, and achromatomaly filters', () => {
      const { container } = render(<AccessibilityPanel />);
      expect(container.querySelector('filter#a11y-cb-deutan')).not.toBeNull();
      expect(container.querySelector('filter#a11y-cb-tritan')).not.toBeNull();
      expect(container.querySelector('filter#a11y-cb-achroma')).not.toBeNull();
      expect(container.querySelector('filter#a11y-cb-achromatomaly')).not.toBeNull();
    });
  });

  describe('applySettings wiring', () => {
    it('calls applySettings on mount with the current store state', () => {
      render(<AccessibilityPanel />);
      expect(applySettingsMock).toHaveBeenCalled();
      const lastCall = applySettingsMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject(ACCESSIBILITY_PREFERENCES_DEFAULTS);
    });

    it('re-applies settings when the store updates', () => {
      render(<AccessibilityPanel />);
      applySettingsMock.mockClear();
      act(() => {
        useA11yStore.setState({ theme: 'dark' });
      });
      expect(applySettingsMock).toHaveBeenCalled();
      const lastCall = applySettingsMock.mock.calls.at(-1);
      expect(lastCall?.[0]).toMatchObject({ theme: 'dark' });
    });
  });

  describe('aid components', () => {
    it('does not mount the Magnifier when store.magnifier is false', () => {
      render(<AccessibilityPanel />);
      expect(screen.queryByTestId('mock-magnifier')).toBeNull();
    });

    it('mounts the Magnifier when store.magnifier is true', () => {
      useA11yStore.setState({ magnifier: true });
      render(<AccessibilityPanel />);
      expect(screen.getByTestId('mock-magnifier')).toBeInTheDocument();
    });

    it('does not mount the ReadingGuide when store.readingGuide is false', () => {
      render(<AccessibilityPanel />);
      expect(screen.queryByTestId('mock-reading-guide')).toBeNull();
    });

    it('mounts the ReadingGuide when store.readingGuide is true', () => {
      useA11yStore.setState({ readingGuide: true });
      render(<AccessibilityPanel />);
      expect(screen.getByTestId('mock-reading-guide')).toBeInTheDocument();
    });

    it('does not mount the PageStructure when store.pageStructure is false', () => {
      render(<AccessibilityPanel />);
      expect(screen.queryByTestId('mock-page-structure')).toBeNull();
    });

    it('mounts the PageStructure when store.pageStructure is true', () => {
      useA11yStore.setState({ pageStructure: true });
      render(<AccessibilityPanel />);
      expect(screen.getByTestId('mock-page-structure')).toBeInTheDocument();
    });

    it('mounts and unmounts the Magnifier reactively when store toggles', () => {
      const { rerender } = render(<AccessibilityPanel />);
      expect(screen.queryByTestId('mock-magnifier')).toBeNull();
      act(() => {
        useA11yStore.setState({ magnifier: true });
      });
      rerender(<AccessibilityPanel />);
      expect(screen.getByTestId('mock-magnifier')).toBeInTheDocument();
      act(() => {
        useA11yStore.setState({ magnifier: false });
      });
      rerender(<AccessibilityPanel />);
      expect(screen.queryByTestId('mock-magnifier')).toBeNull();
    });
  });

  describe('media pauser', () => {
    it('does not install the media pauser when stopAnimations is system and OS does not prefer reduced motion', () => {
      installMatchMedia({});
      render(<AccessibilityPanel />);
      expect(installMediaPauserMock).not.toHaveBeenCalled();
    });

    it('installs the media pauser when stopAnimations is force-on', () => {
      useA11yStore.setState({ stopAnimations: 'force-on' });
      render(<AccessibilityPanel />);
      expect(installMediaPauserMock).toHaveBeenCalledTimes(1);
    });

    it('installs the media pauser when stopAnimations is system and OS prefers reduced motion', () => {
      installMatchMedia({ '(prefers-reduced-motion: reduce)': true });
      render(<AccessibilityPanel />);
      expect(installMediaPauserMock).toHaveBeenCalledTimes(1);
    });

    it('does not install the media pauser when stopAnimations is force-off, even if OS prefers reduced motion', () => {
      installMatchMedia({ '(prefers-reduced-motion: reduce)': true });
      useA11yStore.setState({ stopAnimations: 'force-off' });
      render(<AccessibilityPanel />);
      expect(installMediaPauserMock).not.toHaveBeenCalled();
    });

    it('runs the media pauser cleanup on unmount', () => {
      useA11yStore.setState({ stopAnimations: 'force-on' });
      const { unmount } = render(<AccessibilityPanel />);
      expect(installMediaPauserMock).toHaveBeenCalledTimes(1);
      unmount();
      expect(mediaPauserCleanup).toHaveBeenCalledTimes(1);
    });

    it('runs the media pauser cleanup when stopAnimations is toggled off', () => {
      useA11yStore.setState({ stopAnimations: 'force-on' });
      render(<AccessibilityPanel />);
      expect(installMediaPauserMock).toHaveBeenCalledTimes(1);
      act(() => {
        useA11yStore.setState({ stopAnimations: 'force-off' });
      });
      expect(mediaPauserCleanup).toHaveBeenCalledTimes(1);
    });
  });

  describe('mute pauser', () => {
    it('does not install the mute pauser when muteSounds is false', () => {
      render(<AccessibilityPanel />);
      expect(installMutePauserMock).not.toHaveBeenCalled();
    });

    it('installs the mute pauser when muteSounds is true', () => {
      useA11yStore.setState({ muteSounds: true });
      render(<AccessibilityPanel />);
      expect(installMutePauserMock).toHaveBeenCalledTimes(1);
    });

    it('runs the mute pauser cleanup on unmount', () => {
      useA11yStore.setState({ muteSounds: true });
      const { unmount } = render(<AccessibilityPanel />);
      expect(installMutePauserMock).toHaveBeenCalledTimes(1);
      unmount();
      expect(mutePauserCleanup).toHaveBeenCalledTimes(1);
    });

    it('runs the mute pauser cleanup when muteSounds is toggled off', () => {
      useA11yStore.setState({ muteSounds: true });
      render(<AccessibilityPanel />);
      expect(installMutePauserMock).toHaveBeenCalledTimes(1);
      act(() => {
        useA11yStore.setState({ muteSounds: false });
      });
      expect(mutePauserCleanup).toHaveBeenCalledTimes(1);
    });
  });
});
