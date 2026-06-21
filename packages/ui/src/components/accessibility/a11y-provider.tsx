import * as React from 'react';

import { useReducedMotion } from '../../hooks/use-reduced-motion';
import { activateFont } from './lib/font-loader';
import { applySettings } from './lib/apply-settings';
import { installMediaPauser } from './lib/media-pauser';
import { installMutePauser } from './lib/mute';
import { installReducedMotionClass } from './lib/reduced-motion-broadcaster';
import { SvgColorblindDefs } from './lib/svg-colorblind-defs';
import { Magnifier } from './sections/aids/magnifier';
import { ReadingGuide } from './sections/aids/reading-guide';
import { useA11yStore } from './store';

interface A11yProviderProps {
  readonly children?: React.ReactNode;
}

/**
 * Mount once near the root of the app (or marketing site). Subscribes to the
 * accessibility store and:
 *  - mirrors every setting change to `<html>` via {@link applySettings}
 *  - installs the global side-effect hooks (media-pauser, mute-pauser)
 *  - mounts the visual aids (magnifier, reading guide) so they track the
 *    cursor over the whole page — not just the panel
 *  - lazy-loads the chosen custom font when the user picks one
 *  - injects the SVG `<defs>` used by the colorblind-filter CSS
 */
export function A11yProvider({ children }: Readonly<A11yProviderProps>): React.JSX.Element {
  const prefs = useA11yStore();
  const reducedMotion = useReducedMotion();

  React.useEffect(() => {
    applySettings(prefs);
  }, [prefs]);

  React.useEffect(() => {
    if (prefs.fontFamily === 'system') {
      void activateFont('system');
    } else {
      void activateFont(prefs.fontFamily);
    }
  }, [prefs.fontFamily]);

  React.useEffect(() => installReducedMotionClass(), []);

  React.useEffect(() => {
    if (!reducedMotion) return;
    return installMediaPauser();
  }, [reducedMotion]);

  React.useEffect(() => {
    if (!prefs.muteSounds) return;
    // TTS read-aloud is intentionally exempt from "Mute all sounds": muting only
    // silences <audio>/<video> media. The mute pauser's `onMute` hook (which would
    // cancel in-flight TTS) is deliberately left unwired by design, so toggling
    // mute never interrupts speech the user explicitly started.
    return installMutePauser();
  }, [prefs.muteSounds]);

  return (
    <>
      <SvgColorblindDefs />
      {prefs.magnifier && <Magnifier enabled />}
      {prefs.readingGuide && <ReadingGuide enabled />}
      {children}
    </>
  );
}
