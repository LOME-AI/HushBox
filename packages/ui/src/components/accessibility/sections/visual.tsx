import * as React from 'react';

import { SettingCard } from '../controls/setting-card';
import { useA11yStore } from '../store';
import { ON_OFF_OPTIONS } from './_constants';

const CONTRAST_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'increased', label: 'Stronger' },
  { value: 'high', label: 'Strongest' },
  { value: 'low', label: 'Softer' },
] as const;

const SATURATION_OPTIONS = [
  { value: '0', label: 'Grayscale' },
  { value: '50', label: 'Muted' },
  { value: '100', label: 'Normal' },
  { value: '150', label: 'Vivid' },
] as const;

const COLOR_VISION_OPTIONS = [
  { value: 'none', label: 'Off' },
  { value: 'protan', label: 'Red-blind' },
  { value: 'deutan', label: 'Green-blind' },
  { value: 'tritan', label: 'Blue-blind' },
  { value: 'achroma', label: 'No color' },
  { value: 'achromatomaly', label: 'Faded color' },
] as const;

export function VisualSection(): React.JSX.Element {
  const contrast = useA11yStore((s) => s.contrast);
  const saturation = useA11yStore((s) => s.saturation);
  const invert = useA11yStore((s) => s.invert);
  const highlightLinks = useA11yStore((s) => s.highlightLinks);
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
          onChange={(v) => {
            update({ contrast: v });
          }}
        />
        <SettingCard
          title="Color intensity"
          options={SATURATION_OPTIONS}
          value={saturation}
          onChange={(v) => {
            update({ saturation: v });
          }}
        />
        <SettingCard
          title="Reverse colors"
          options={ON_OFF_OPTIONS}
          value={invert ? 'on' : 'off'}
          onChange={(v) => {
            update({ invert: v === 'on' });
          }}
        />
        <SettingCard
          title="Underline links"
          options={ON_OFF_OPTIONS}
          value={highlightLinks ? 'on' : 'off'}
          onChange={(v) => {
            update({ highlightLinks: v === 'on' });
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
