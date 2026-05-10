import * as React from 'react';

import { cn } from '../../../lib/utilities';
import { useOsPreferences, type OsPreferences } from '../hooks/use-os-preferences';
import { useA11yStore } from '../store';
import type { AccessibilityPreferences } from '../store/schema';

const BUTTON_CLASSES = cn(
  'border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:border-ring focus-visible:ring-ring/50 inline-flex items-center justify-center rounded-md border px-3 py-2 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px]'
);

function osPreferencesToStorePatch(prefs: OsPreferences): Partial<AccessibilityPreferences> {
  const patch: Partial<AccessibilityPreferences> = {
    theme: prefs.colorScheme ?? 'system',
    stopAnimations: prefs.reducedMotion ? 'force-on' : 'system',
  };
  if (prefs.contrast === 'more') {
    patch.contrast = 'high';
  } else if (prefs.contrast === 'less') {
    patch.contrast = 'low';
  } else {
    patch.contrast = 'normal';
  }
  return patch;
}

export function MetaSection(): React.JSX.Element {
  const reset = useA11yStore((s) => s.reset);
  const update = useA11yStore((s) => s.update);
  const osPrefs = useOsPreferences();

  const handleResetToOs = React.useCallback((): void => {
    update(osPreferencesToStorePatch(osPrefs));
  }, [update, osPrefs]);

  return (
    <section aria-labelledby="a11y-meta-heading" className="flex flex-col gap-2">
      <h2 id="a11y-meta-heading" className="sr-only">
        Reset
      </h2>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={BUTTON_CLASSES} onClick={reset}>
          Reset to defaults
        </button>
        <button type="button" className={BUTTON_CLASSES} onClick={handleResetToOs}>
          Reset to OS preferences
        </button>
      </div>
    </section>
  );
}
