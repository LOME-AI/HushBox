import * as React from 'react';

import { BooleanSwitchRow } from '../controls/boolean-switch-row';
import { useA11yStore } from '../store';
import type { AccessibilityPreferences } from '../store/schema';

interface SwitchRowSpec {
  key: keyof AccessibilityPreferences;
  label: string;
}

const SWITCH_SPECS: readonly SwitchRowSpec[] = [
  { key: 'magnifier', label: 'Magnifier' },
  { key: 'readingGuide', label: 'Reading guide' },
  { key: 'readerView', label: 'Reader view' },
  { key: 'pageStructure', label: 'Page structure' },
  { key: 'hideImages', label: 'Hide images' },
];

export function ReadingAidsSection(): React.JSX.Element {
  const state = useA11yStore();
  const update = state.update;

  return (
    <section aria-labelledby="a11y-reading-aids-heading" className="flex flex-col gap-1">
      <h2 id="a11y-reading-aids-heading" className="mb-2 text-lg font-semibold">
        Reading aids
      </h2>
      {SWITCH_SPECS.map((spec) => (
        <BooleanSwitchRow
          key={spec.key}
          label={spec.label}
          checked={state[spec.key] as boolean}
          onCheckedChange={(checked) => {
            update({ [spec.key]: checked } as Partial<AccessibilityPreferences>);
          }}
        />
      ))}
    </section>
  );
}
