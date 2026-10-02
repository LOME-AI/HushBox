import * as React from 'react';

import { cn } from '../../lib/utilities';
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
import type { AccessibilityHost } from './sections/host-layout';

interface AccessibilityPanelProps {
  /** `app` lays the grids out from the panel's own width; `site` keeps the sheet's viewport step. */
  host: AccessibilityHost;
}

/**
 * AccessibilityPanel — UI-only. All side effects (applying classes to <html>,
 * mounting magnifier/reading-guide/page-outline, media/mute pausers, font
 * loading) live in `A11yProvider` in
 * `packages/ui/src/components/accessibility/a11y-provider.tsx` and run
 * globally; the panel just renders the controls.
 */
export function AccessibilityPanel({ host }: Readonly<AccessibilityPanelProps>): React.JSX.Element {
  return (
    <div className={cn('flex flex-col gap-6 p-2', host === 'app' && '@container')}>
      <ProfilesSection host={host} />
      <VisualSection host={host} />
      <TypographySection host={host} />
      <ReadingAidsSection host={host} />
      <AudioSection />
      <MotionSection />
      <PointerFocusSection host={host} />
      <MetaSection host={host} />
    </div>
  );
}
