import * as React from 'react';

import { CycleButton } from '../controls/cycle-button';
import { useA11yStore } from '../store';

const STOP_ANIMATIONS_VALUES = ['system', 'force-on', 'force-off'] as const;

const formatStopAnimations = (v: (typeof STOP_ANIMATIONS_VALUES)[number]): string => {
  switch (v) {
    case 'system': {
      return 'System';
    }
    case 'force-on': {
      return 'Force on';
    }
    case 'force-off': {
      return 'Force off';
    }
  }
};

export function MotionSection(): React.JSX.Element {
  const stopAnimations = useA11yStore((s) => s.stopAnimations);
  const update = useA11yStore((s) => s.update);

  return (
    <section aria-labelledby="a11y-motion-heading" className="flex flex-col gap-2">
      <h2 id="a11y-motion-heading" className="mb-2 text-lg font-semibold">
        Motion
      </h2>
      <CycleButton
        label="Stop animations"
        values={STOP_ANIMATIONS_VALUES}
        value={stopAnimations}
        onChange={(v) => {
          update({ stopAnimations: v });
        }}
        formatValue={formatStopAnimations}
      />
    </section>
  );
}
