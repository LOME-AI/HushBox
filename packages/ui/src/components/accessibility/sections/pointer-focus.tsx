import * as React from 'react';

import { useIsTouchDevice } from '../../../hooks/use-is-touch-device';
import { SettingCard } from '../controls/setting-card';
import { useA11yStore } from '../store';
import { ON_OFF_OPTIONS } from './_constants';

const CURSOR_SIZE_OPTIONS = [
  { value: 'normal', label: 'Normal' },
  { value: 'large', label: 'Large' },
  { value: 'xlarge', label: 'Huge' },
] as const;

const CURSOR_COLOR_OPTIONS = [
  { value: 'black', label: 'Black' },
  { value: 'white', label: 'White' },
] as const;

const FOCUS_WIDTH_OPTIONS = [
  { value: '2', label: 'Thin' },
  { value: '4', label: 'Medium' },
  { value: '6', label: 'Thick' },
] as const;

const FOCUS_COLOR_OPTIONS = [
  { value: 'yellow', label: 'Yellow' },
  { value: 'magenta', label: 'Magenta' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'lime', label: 'Lime' },
  { value: 'red', label: 'Red' },
] as const;

export function PointerFocusSection(): React.JSX.Element {
  const cursorSize = useA11yStore((s) => s.cursorSize);
  const cursorColor = useA11yStore((s) => s.cursorColor);
  const focusWidth = useA11yStore((s) => s.focusWidth);
  const focusColor = useA11yStore((s) => s.focusColor);
  const focusHalo = useA11yStore((s) => s.focusHalo);
  const update = useA11yStore((s) => s.update);
  const isTouch = useIsTouchDevice();

  return (
    <section aria-labelledby="a11y-pointer-focus-heading" className="flex flex-col gap-3">
      <h2 id="a11y-pointer-focus-heading" className="text-lg font-semibold">
        Pointer &amp; focus
      </h2>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {!isTouch && (
          <>
            <SettingCard
              title="Pointer size"
              options={CURSOR_SIZE_OPTIONS}
              value={cursorSize}
              onChange={(v) => {
                update({ cursorSize: v });
              }}
            />
            <SettingCard
              title="Pointer color"
              options={CURSOR_COLOR_OPTIONS}
              value={cursorColor}
              onChange={(v) => {
                update({ cursorColor: v });
              }}
            />
          </>
        )}
        <SettingCard
          title="Focus ring thickness"
          options={FOCUS_WIDTH_OPTIONS}
          value={focusWidth}
          onChange={(v) => {
            update({ focusWidth: v });
          }}
        />
        <SettingCard
          title="Focus ring color"
          options={FOCUS_COLOR_OPTIONS}
          value={focusColor}
          onChange={(v) => {
            update({ focusColor: v });
          }}
        />
        <SettingCard
          title="Focus glow"
          options={ON_OFF_OPTIONS}
          value={focusHalo ? 'on' : 'off'}
          onChange={(v) => {
            update({ focusHalo: v === 'on' });
          }}
        />
      </div>
    </section>
  );
}
