import * as React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ACCESSIBILITY_PREFERENCES_DEFAULTS, type AccessibilityPreferences } from '@hushbox/shared';

const storeState: { prefs: AccessibilityPreferences } = {
  prefs: { ...ACCESSIBILITY_PREFERENCES_DEFAULTS },
};

vi.mock('./store', () => ({
  useA11yStore: <T,>(selector?: (state: AccessibilityPreferences) => T): T => {
    return selector === undefined ? (storeState.prefs as unknown as T) : selector(storeState.prefs);
  },
}));

const applySettingsSpy = vi.fn();
vi.mock('./lib/apply-settings', () => ({
  applySettings: (prefs: AccessibilityPreferences) => {
    applySettingsSpy(prefs);
  },
}));

const installMediaPauserSpy = vi.fn().mockReturnValue(() => {});
const installMutePauserSpy = vi.fn().mockReturnValue(() => {});
vi.mock('./lib/media-pauser', () => ({
  installMediaPauser: (): (() => void) => installMediaPauserSpy(),
}));
vi.mock('./lib/mute', () => ({
  installMutePauser: (): (() => void) => installMutePauserSpy(),
}));

const activateFontSpy = vi.fn().mockResolvedValue(true);
vi.mock('./lib/font-loader', () => ({
  activateFont: (id: string): Promise<void> => {
    activateFontSpy(id);
    return Promise.resolve();
  },
}));

vi.mock('./lib/svg-colorblind-defs', () => ({
  SvgColorblindDefs: (): React.JSX.Element => <svg data-testid="cb-defs" />,
}));

vi.mock('./sections/aids/magnifier', () => ({
  Magnifier: ({ enabled }: { enabled: boolean }): React.JSX.Element | null =>
    enabled ? <div data-testid="magnifier" /> : null,
}));
vi.mock('./sections/aids/reading-guide', () => ({
  ReadingGuide: ({ enabled }: { enabled: boolean }): React.JSX.Element | null =>
    enabled ? <div data-testid="reading-guide" /> : null,
}));

import { A11yProvider } from './a11y-provider';

beforeEach(() => {
  storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS };
  applySettingsSpy.mockReset();
  installMediaPauserSpy.mockClear();
  installMutePauserSpy.mockClear();
  activateFontSpy.mockReset();
});

describe('A11yProvider', () => {
  it('renders children', () => {
    render(
      <A11yProvider>
        <span data-testid="child">hi</span>
      </A11yProvider>
    );
    expect(screen.getByTestId('child')).not.toBeNull();
  });

  it('calls applySettings with the current preferences on mount', () => {
    render(<A11yProvider />);
    expect(applySettingsSpy).toHaveBeenCalledWith(ACCESSIBILITY_PREFERENCES_DEFAULTS);
  });

  it('renders the SVG colorblind defs', () => {
    render(<A11yProvider />);
    expect(screen.getByTestId('cb-defs')).not.toBeNull();
  });

  it('does not mount aids by default', () => {
    render(<A11yProvider />);
    expect(screen.queryByTestId('magnifier')).toBeNull();
    expect(screen.queryByTestId('reading-guide')).toBeNull();
  });

  it('mounts the magnifier when prefs.magnifier is true', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, magnifier: true };
    render(<A11yProvider />);
    expect(screen.getByTestId('magnifier')).not.toBeNull();
  });

  it('mounts the reading guide when prefs.readingGuide is true', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, readingGuide: true };
    render(<A11yProvider />);
    expect(screen.getByTestId('reading-guide')).not.toBeNull();
  });

  it('installs the media pauser when stopAnimations is true', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, stopAnimations: true };
    render(<A11yProvider />);
    expect(installMediaPauserSpy).toHaveBeenCalledTimes(1);
  });

  it('does not install the media pauser when stopAnimations is false', () => {
    render(<A11yProvider />);
    expect(installMediaPauserSpy).not.toHaveBeenCalled();
  });

  it('installs the mute pauser when muteSounds is true', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, muteSounds: true };
    render(<A11yProvider />);
    expect(installMutePauserSpy).toHaveBeenCalledTimes(1);
  });

  it('activates the system font when fontFamily is "system"', () => {
    render(<A11yProvider />);
    expect(activateFontSpy).toHaveBeenCalledWith('system');
  });

  it('activates the chosen custom font when fontFamily is non-system', () => {
    storeState.prefs = { ...ACCESSIBILITY_PREFERENCES_DEFAULTS, fontFamily: 'atkinson' };
    render(<A11yProvider />);
    expect(activateFontSpy).toHaveBeenCalledWith('atkinson');
  });
});
