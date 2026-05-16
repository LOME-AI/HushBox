import * as React from 'react';

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

/**
 * AccessibilityPanel — UI-only. All side effects (applying classes to <html>,
 * mounting magnifier/reading-guide/page-outline, media/mute pausers, font
 * loading) live in {@link A11yProvider} and run globally; the panel just
 * renders the controls.
 */
export function AccessibilityPanel(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-6 p-2">
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
