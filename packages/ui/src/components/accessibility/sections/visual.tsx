import * as React from 'react';

import { SettingCard } from '../controls/setting-card';
import { useA11yStore } from '../store';

// Linear from less-intense → neutral → more-intense.
const CONTRAST_OPTIONS = [
  { value: 'low', label: 'Softer' },
  { value: 'normal', label: 'Normal' },
  { value: 'increased', label: 'Stronger' },
  { value: 'high', label: 'Strongest' },
] as const;
const CONTRAST_NEUTRAL_INDEX = 1;

const SATURATION_OPTIONS = [
  { value: '0', label: 'Grayscale' },
  { value: '50', label: 'Muted' },
  { value: '100', label: 'Normal' },
  { value: '150', label: 'Vivid' },
] as const;
const SATURATION_NEUTRAL_INDEX = 2;

const COLOR_VISION_OPTIONS = [
  { value: 'none', label: 'Off' },
  { value: 'protan', label: 'Protanopia (red-blind)' },
  { value: 'deutan', label: 'Deuteranopia (green-blind)' },
  { value: 'tritan', label: 'Tritanopia (blue-blind)' },
  { value: 'achroma', label: 'Achromatopsia (no color)' },
  { value: 'achromatomaly', label: 'Achromatomaly (faded color)' },
] as const;

export function VisualSection(): React.JSX.Element {
  const contrast = useA11yStore((s) => s.contrast);
  const saturation = useA11yStore((s) => s.saturation);
  const colorblindSimulate = useA11yStore((s) => s.colorblindSimulate);
  const update = useA11yStore((s) => s.update);

  return (
    <section aria-labelledby="a11y-visual-heading" className="flex flex-col gap-3">
      <h2 id="a11y-visual-heading" className="text-lg font-semibold">
        Visual
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <SettingCard
          title="Contrast"
          options={CONTRAST_OPTIONS}
          value={contrast}
          neutralIndex={CONTRAST_NEUTRAL_INDEX}
          onChange={(v) => {
            update({ contrast: v });
          }}
        />
        <SettingCard
          title="Color intensity"
          options={SATURATION_OPTIONS}
          value={saturation}
          neutralIndex={SATURATION_NEUTRAL_INDEX}
          onChange={(v) => {
            update({ saturation: v });
          }}
        />
        <SettingCard
          title="Color-blindness filter"
          options={COLOR_VISION_OPTIONS}
          value={colorblindSimulate}
          onChange={(v) => {
            update({ colorblindSimulate: v });
          }}
          className="sm:col-span-2"
        />
      </div>
    </section>
  );
}
