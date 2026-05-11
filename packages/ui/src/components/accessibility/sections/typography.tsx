import * as React from 'react';

import { SettingCard } from '../controls/setting-card';
import { activateFont } from '../lib/font-loader';
import { useA11yStore } from '../store';
import { ON_OFF_OPTIONS } from './_constants';

const FONT_SIZE_OPTIONS = [
  { value: '100', label: 'Normal' },
  { value: '125', label: 'Larger' },
  { value: '150', label: 'Large' },
  { value: '175', label: 'Very large' },
  { value: '200', label: 'Huge' },
] as const;

const LETTER_SPACING_OPTIONS = [
  { value: '0', label: 'Tight' },
  { value: '0.05', label: 'Normal' },
  { value: '0.12', label: 'Wide' },
] as const;

const LINE_HEIGHT_OPTIONS = [
  { value: '1.0', label: 'Tight' },
  { value: '1.5', label: 'Normal' },
  { value: '2.0', label: 'Wide' },
] as const;

const PARAGRAPH_SPACING_OPTIONS = [
  { value: '1', label: 'Normal' },
  { value: '2', label: 'Wide' },
] as const;

const FONT_OPTIONS = [
  { value: 'system', label: 'Default' },
  { value: 'atkinson', label: 'Atkinson Hyperlegible' },
  { value: 'lexend', label: 'Lexend' },
  { value: 'open-dyslexic', label: 'OpenDyslexic' },
] as const;

export function TypographySection(): React.JSX.Element {
  const fontSize = useA11yStore((s) => s.fontSize);
  const letterSpacing = useA11yStore((s) => s.letterSpacing);
  const lineHeight = useA11yStore((s) => s.lineHeight);
  const paragraphSpacing = useA11yStore((s) => s.paragraphSpacing);
  const forceLeftAlign = useA11yStore((s) => s.forceLeftAlign);
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
          title="Align text left"
          options={ON_OFF_OPTIONS}
          value={forceLeftAlign ? 'on' : 'off'}
          onChange={(v) => {
            update({ forceLeftAlign: v === 'on' });
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
        />
      </div>
    </section>
  );
}
