import * as React from 'react';

import { SettingCard } from '../controls/setting-card';
import { activateFont } from '../lib/font-loader';
import { useA11yStore } from '../store';

// Two-directional ramp around the 17px default (Smaller ← Normal → Largest).
// Numeric value is the % of the 17px root: 88/100/112/124/141.
const FONT_SIZE_OPTIONS = [
  { value: '88', label: 'Smaller' },
  { value: '100', label: 'Normal' },
  { value: '112', label: 'Larger' },
  { value: '124', label: 'Even larger' },
  { value: '141', label: 'Largest' },
] as const;
const FONT_SIZE_NEUTRAL_INDEX = 1;

// One-directional: '0' is the browser default (no extra letter-spacing), so
// Normal sits at index 0 and we ramp toward Wider. Adding negative letter-
// spacing isn't in scope.
const LETTER_SPACING_OPTIONS = [
  { value: '0', label: 'Normal' },
  { value: '0.05', label: 'Wide' },
  { value: '0.12', label: 'Wider' },
] as const;

// Two-directional for line height: '1.5' is both the schema default and the
// natural middle. Tight ← Normal → Wide.
const LINE_HEIGHT_OPTIONS = [
  { value: '1.0', label: 'Tight' },
  { value: '1.5', label: 'Normal' },
  { value: '2.0', label: 'Wide' },
] as const;
const LINE_HEIGHT_NEUTRAL_INDEX = 1;

// One-directional: Normal → Wide.
const PARAGRAPH_SPACING_OPTIONS = [
  { value: '1', label: 'Normal' },
  { value: '2', label: 'Wide' },
] as const;

const FONT_OPTIONS = [
  { value: 'system', label: 'Merriweather (default)' },
  { value: 'atkinson', label: 'Atkinson Hyperlegible (low vision)' },
  { value: 'lexend', label: 'Lexend (reading speed)' },
  { value: 'open-dyslexic', label: 'OpenDyslexic (dyslexia)' },
] as const;

export function TypographySection(): React.JSX.Element {
  const fontSize = useA11yStore((s) => s.fontSize);
  const letterSpacing = useA11yStore((s) => s.letterSpacing);
  const lineHeight = useA11yStore((s) => s.lineHeight);
  const paragraphSpacing = useA11yStore((s) => s.paragraphSpacing);
  const fontFamily = useA11yStore((s) => s.fontFamily);
  const update = useA11yStore((s) => s.update);

  return (
    <section aria-labelledby="a11y-typography-heading" className="flex flex-col gap-3">
      <h2 id="a11y-typography-heading" className="text-lg font-semibold">
        Text
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <SettingCard
          title="Text size"
          options={FONT_SIZE_OPTIONS}
          value={fontSize}
          neutralIndex={FONT_SIZE_NEUTRAL_INDEX}
          onChange={(v) => {
            update({ fontSize: v });
          }}
        />
        <SettingCard
          title="Space between letters"
          options={LETTER_SPACING_OPTIONS}
          value={letterSpacing}
          onChange={(v) => {
            update({ letterSpacing: v });
          }}
        />
        <SettingCard
          title="Space between lines"
          options={LINE_HEIGHT_OPTIONS}
          value={lineHeight}
          neutralIndex={LINE_HEIGHT_NEUTRAL_INDEX}
          onChange={(v) => {
            update({ lineHeight: v });
          }}
        />
        <SettingCard
          title="Space between paragraphs"
          options={PARAGRAPH_SPACING_OPTIONS}
          value={paragraphSpacing}
          onChange={(v) => {
            update({ paragraphSpacing: v });
          }}
        />
        <SettingCard
          title="Font"
          options={FONT_OPTIONS}
          value={fontFamily}
          onChange={(v) => {
            update({ fontFamily: v });
            if (v !== 'system') {
              void activateFont(v);
            }
          }}
          className="sm:col-span-2"
        />
      </div>
    </section>
  );
}
