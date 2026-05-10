import * as React from 'react';

import { useOsPreferences } from './hooks/use-os-preferences';
import { applySettings } from './lib/apply-settings';
import { installMediaPauser } from './lib/media-pauser';
import { installMutePauser } from './lib/mute';
import { SvgColorblindDefs } from './lib/svg-colorblind-defs';
import { Magnifier } from './sections/aids/magnifier';
import { PageStructure } from './sections/aids/page-structure';
import { ReadingGuide } from './sections/aids/reading-guide';
import {
  AudioSection,
  MetaSection,
  MotionSection,
  PointerFocusSection,
  ProfilesSection,
  ReadingAidsSection,
  TypographySection,
  VisualSection,
} from './sections';
import { useA11yStore } from './store';

/**
 * AccessibilityPanel — the shared inner content of both the marketing widget
 * and the authenticated /accessibility page. Subscribes to the Zustand store,
 * mirrors every change to the document root via {@link applySettings}, mounts
 * the colorblind SVG filter defs, conditionally mounts the visual aids
 * (Magnifier, ReadingGuide, PageStructure), conditionally installs the
 * media-pauser and mute-pauser side effects, and renders all eight sections in
 * a flat scrollable list.
 *
 * The panel itself is presentation-only: every interactive control is owned by
 * its respective section component. There are no accordions, no collapsibles,
 * no search box, and no "About" link.
 */
export function AccessibilityPanel(): React.JSX.Element {
  const state = useA11yStore();
  const osPreferences = useOsPreferences();

  React.useEffect(() => {
    applySettings(state);
  }, [state]);

  const motionStopped =
    state.stopAnimations === 'force-on' ||
    (state.stopAnimations === 'system' && osPreferences.reducedMotion);

  React.useEffect(() => {
    if (!motionStopped) return;
    return installMediaPauser();
  }, [motionStopped]);

  const muteSounds = state.muteSounds;

  React.useEffect(() => {
    if (!muteSounds) return;
    return installMutePauser();
  }, [muteSounds]);

  return (
    <div className="flex flex-col gap-4 p-2">
      <SvgColorblindDefs />
      {state.magnifier && <Magnifier enabled />}
      {state.readingGuide && <ReadingGuide enabled />}
      {state.pageStructure && <PageStructure enabled />}
      <ProfilesSection />
      <VisualSection />
      <TypographySection />
      <ReadingAidsSection />
      <AudioSection />
      <MotionSection />
      <PointerFocusSection />
      <MetaSection />
    </div>
  );
}
