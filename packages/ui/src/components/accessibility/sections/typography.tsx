import * as React from 'react';

import { BooleanSwitchRow } from '../controls/boolean-switch-row';
import { CycleButton } from '../controls/cycle-button';
import { FontCard } from '../controls/font-card';
import { ACCESSIBILITY_FONTS, type AccessibilityFont } from '../fonts/registry';
import { activateFont } from '../lib/font-loader';
import { useA11yStore } from '../store';

const FONT_SIZE_VALUES = ['100', '125', '150', '175', '200'] as const;
const LETTER_SPACING_VALUES = ['0', '0.05', '0.12'] as const;
const LINE_HEIGHT_VALUES = ['1.0', '1.5', '2.0'] as const;
const PARAGRAPH_SPACING_VALUES = ['1', '2'] as const;

const formatPercent = (v: string): string => `${v}%`;
const formatLetterSpacing = (v: string): string => (v === '0' ? '0' : `${v}em`);
const formatParagraphSpacing = (v: string): string => `${v}em`;

/**
 * Convert a registry entry to the CSS font-family string used by the FontCard preview.
 * For 'system' there's no override, so fall back to the same stack the rest of the site uses.
 * For lazy-loaded fonts, the registry id matches the FontFace family name set by activateFont.
 */
function previewFontFamily(font: AccessibilityFont): string {
  if (font.id === 'system') return 'system-ui, sans-serif';
  return `"${font.id}", system-ui, sans-serif`;
}

export function TypographySection(): React.JSX.Element {
  const fontSize = useA11yStore((s) => s.fontSize);
  const letterSpacing = useA11yStore((s) => s.letterSpacing);
  const lineHeight = useA11yStore((s) => s.lineHeight);
  const paragraphSpacing = useA11yStore((s) => s.paragraphSpacing);
  const forceLeftAlign = useA11yStore((s) => s.forceLeftAlign);
  const fontFamily = useA11yStore((s) => s.fontFamily);
  const update = useA11yStore((s) => s.update);

  return (
    <section aria-labelledby="a11y-typography-heading" className="flex flex-col gap-2">
      <h2 id="a11y-typography-heading" className="mb-2 text-lg font-semibold">
        Typography
      </h2>
      <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <CycleButton
          label="Font size"
          values={FONT_SIZE_VALUES}
          value={fontSize}
          onChange={(v) => {
            update({ fontSize: v });
          }}
          formatValue={formatPercent}
        />
        <CycleButton
          label="Letter spacing"
          values={LETTER_SPACING_VALUES}
          value={letterSpacing}
          onChange={(v) => {
            update({ letterSpacing: v });
          }}
          formatValue={formatLetterSpacing}
        />
        <CycleButton
          label="Line height"
          values={LINE_HEIGHT_VALUES}
          value={lineHeight}
          onChange={(v) => {
            update({ lineHeight: v });
          }}
        />
        <CycleButton
          label="Paragraph spacing"
          values={PARAGRAPH_SPACING_VALUES}
          value={paragraphSpacing}
          onChange={(v) => {
            update({ paragraphSpacing: v });
          }}
          formatValue={formatParagraphSpacing}
        />
      </div>
      <BooleanSwitchRow
        label="Force left-align"
        checked={forceLeftAlign}
        onCheckedChange={(checked) => {
          update({ forceLeftAlign: checked });
        }}
      />
      <div role="radiogroup" aria-labelledby="a11y-font-family-heading">
        <h3 id="a11y-font-family-heading" className="mb-2 text-sm font-medium">
          Font family
        </h3>
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
          {ACCESSIBILITY_FONTS.map((font) => (
            <FontCard
              key={font.id}
              selected={fontFamily === font.id}
              purpose={font.purpose}
              fontName={font.displayName}
              fontFamily={previewFontFamily(font)}
              onSelect={() => {
                update({ fontFamily: font.id });
                // 'system' clears via applySettings/init-script; no FontFace work needed.
                if (font.id !== 'system') {
                  void activateFont(font.id);
                }
              }}
            />
          ))}
        </div>
      </div>
    </section>
  );
}
