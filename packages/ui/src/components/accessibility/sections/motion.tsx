import * as React from 'react';

import { SettingCard } from '../controls/setting-card';
import { useA11yStore } from '../store';

const ANIMATION_OPTIONS = [
  { value: 'on', label: 'Allow' },
  { value: 'off', label: 'Stop' },
] as const;

export function MotionSection(): React.JSX.Element {
  const stopAnimations = useA11yStore((s) => s.stopAnimations);
  const update = useA11yStore((s) => s.update);

  return (
    <section aria-labelledby="a11y-motion-heading" className="flex flex-col gap-3">
      <h2 id="a11y-motion-heading" className="text-lg font-semibold">
        Motion
      </h2>
      <SettingCard
        title="Animations"
        options={ANIMATION_OPTIONS}
        value={stopAnimations ? 'off' : 'on'}
        onChange={(v) => {
          update({ stopAnimations: v === 'off' });
        }}
      />
    </section>
  );
}
