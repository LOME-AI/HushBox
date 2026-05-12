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
  { value: '0', label: 'Off' },
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
            // Color only matters when the ring is visible — bump thickness to Thin
            // if the ring is currently off so the chosen color is actually applied.
            update({
              focusColor: v,
              ...(focusWidth === '0' ? { focusWidth: '2' as const } : {}),
            });
          }}
        />
        <SettingCard
          title="Focus glow"
          options={ON_OFF_OPTIONS}
          value={focusHalo ? 'on' : 'off'}
          onChange={(v) => {
            // Glow is gated on a visible ring — turning it on while thickness is
            // Off would have no effect, so bump thickness to Thin in that case.
            const next = v === 'on';
            update({
              focusHalo: next,
              ...(next && focusWidth === '0' ? { focusWidth: '2' as const } : {}),
            });
          }}
        />
      </div>
    </section>
  );
}
