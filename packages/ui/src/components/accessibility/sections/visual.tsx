import * as React from 'react';

import { BooleanSwitchRow } from '../controls/boolean-switch-row';
import { CycleButton } from '../controls/cycle-button';
import { PillRow } from '../controls/pill-row';
import { useA11yStore } from '../store';

const THEME_VALUES = ['system', 'light', 'dark'] as const;
const CONTRAST_VALUES = ['normal', 'increased', 'high', 'low'] as const;
const SATURATION_VALUES = ['0', '50', '100', '150'] as const;
const INVERT_VALUES = ['off', 'on'] as const;

const SIMULATE_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'protan', label: 'Protan' },
  { value: 'deutan', label: 'Deutan' },
  { value: 'tritan', label: 'Tritan' },
  { value: 'achroma', label: 'Achroma' },
  { value: 'achromatomaly', label: 'Achromatomaly' },
] as const;

const CORRECT_OPTIONS = [
  { value: 'none', label: 'None' },
  { value: 'protan', label: 'Protan' },
  { value: 'deutan', label: 'Deutan' },
  { value: 'tritan', label: 'Tritan' },
  { value: 'achroma', label: 'Achroma' },
] as const;

const formatTitleCase = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);
const formatPercent = (v: string): string => `${v}%`;

export function VisualSection(): React.JSX.Element {
  const theme = useA11yStore((s) => s.theme);
  const contrast = useA11yStore((s) => s.contrast);
  const saturation = useA11yStore((s) => s.saturation);
  const invert = useA11yStore((s) => s.invert);
  const highlightLinks = useA11yStore((s) => s.highlightLinks);
  const colorblindSimulate = useA11yStore((s) => s.colorblindSimulate);
  const colorblindCorrect = useA11yStore((s) => s.colorblindCorrect);
  const update = useA11yStore((s) => s.update);

  return (
    <section aria-labelledby="a11y-visual-heading" className="flex flex-col gap-2">
      <h2 id="a11y-visual-heading" className="mb-2 text-lg font-semibold">
        Visual
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <CycleButton
          label="Theme"
          values={THEME_VALUES}
          value={theme}
          onChange={(v) => {
            update({ theme: v });
          }}
          formatValue={formatTitleCase}
        />
        <CycleButton
          label="Contrast"
          values={CONTRAST_VALUES}
          value={contrast}
          onChange={(v) => {
            update({ contrast: v });
          }}
          formatValue={formatTitleCase}
        />
        <CycleButton
          label="Saturation"
          values={SATURATION_VALUES}
          value={saturation}
          onChange={(v) => {
            update({ saturation: v });
          }}
          formatValue={formatPercent}
        />
        <CycleButton
          label="Invert"
          values={INVERT_VALUES}
          value={invert ? 'on' : 'off'}
          onChange={(v) => {
            update({ invert: v === 'on' });
          }}
          formatValue={formatTitleCase}
        />
      </div>
      <BooleanSwitchRow
        label="Highlight links"
        checked={highlightLinks}
        onCheckedChange={(checked) => {
          update({ highlightLinks: checked });
        }}
      />
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Color vision (simulate)</span>
        <PillRow
          ariaLabel="Color vision (simulate)"
          options={SIMULATE_OPTIONS}
          value={colorblindSimulate}
          onChange={(v) => {
            update({ colorblindSimulate: v });
          }}
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Color vision (correct)</span>
        <PillRow
          ariaLabel="Color vision (correct)"
          options={CORRECT_OPTIONS}
          value={colorblindCorrect}
          onChange={(v) => {
            update({ colorblindCorrect: v });
          }}
        />
      </div>
    </section>
  );
}
