import * as React from 'react';

import { useIsTouchDevice } from '../../../hooks/use-is-touch-device';
import { BooleanSwitchRow } from '../controls/boolean-switch-row';
import { CycleButton } from '../controls/cycle-button';
import { PillRow } from '../controls/pill-row';
import { useA11yStore } from '../store';

const CURSOR_SIZE_VALUES = ['normal', 'large', 'xlarge'] as const;
const CURSOR_COLOR_VALUES = ['system', 'black', 'white'] as const;
const FOCUS_WIDTH_VALUES = ['2', '4', '6'] as const;

const FOCUS_COLOR_OPTIONS = [
  { value: 'yellow', label: 'Yellow' },
  { value: 'magenta', label: 'Magenta' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'lime', label: 'Lime' },
  { value: 'red', label: 'Red' },
] as const;

const formatTitleCase = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

const formatCursorSize = (v: (typeof CURSOR_SIZE_VALUES)[number]): string => {
  switch (v) {
    case 'normal': {
      return 'Normal';
    }
    case 'large': {
      return 'Large';
    }
    case 'xlarge': {
      return 'X-Large';
    }
  }
};

const formatPx = (v: string): string => `${v}px`;

interface CursorControlsProps {
  cursorSize: (typeof CURSOR_SIZE_VALUES)[number];
  cursorColor: (typeof CURSOR_COLOR_VALUES)[number];
  onCursorSizeChange: (next: (typeof CURSOR_SIZE_VALUES)[number]) => void;
  onCursorColorChange: (next: (typeof CURSOR_COLOR_VALUES)[number]) => void;
}

function CursorControls({
  cursorSize,
  cursorColor,
  onCursorSizeChange,
  onCursorColorChange,
}: Readonly<CursorControlsProps>): React.JSX.Element {
  return (
    <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
      <CycleButton
        label="Cursor size"
        values={CURSOR_SIZE_VALUES}
        value={cursorSize}
        onChange={onCursorSizeChange}
        formatValue={formatCursorSize}
      />
      <CycleButton
        label="Cursor color"
        values={CURSOR_COLOR_VALUES}
        value={cursorColor}
        onChange={onCursorColorChange}
        formatValue={formatTitleCase}
      />
    </div>
  );
}

export function PointerFocusSection(): React.JSX.Element {
  const cursorSize = useA11yStore((s) => s.cursorSize);
  const cursorColor = useA11yStore((s) => s.cursorColor);
  const focusWidth = useA11yStore((s) => s.focusWidth);
  const focusColor = useA11yStore((s) => s.focusColor);
  const focusHalo = useA11yStore((s) => s.focusHalo);
  const update = useA11yStore((s) => s.update);
  const isTouch = useIsTouchDevice();

  return (
    <section aria-labelledby="a11y-pointer-focus-heading" className="flex flex-col gap-2">
      <h2 id="a11y-pointer-focus-heading" className="mb-2 text-lg font-semibold">
        Pointer &amp; focus
      </h2>
      {!isTouch && (
        <CursorControls
          cursorSize={cursorSize}
          cursorColor={cursorColor}
          onCursorSizeChange={(v) => {
            update({ cursorSize: v });
          }}
          onCursorColorChange={(v) => {
            update({ cursorColor: v });
          }}
        />
      )}
      <CycleButton
        label="Focus width"
        values={FOCUS_WIDTH_VALUES}
        value={focusWidth}
        onChange={(v) => {
          update({ focusWidth: v });
        }}
        formatValue={formatPx}
      />
      <div className="flex flex-col gap-1">
        <span className="text-muted-foreground text-xs">Focus color</span>
        <PillRow
          ariaLabel="Focus color"
          options={FOCUS_COLOR_OPTIONS}
          value={focusColor}
          onChange={(v) => {
            update({ focusColor: v });
          }}
        />
      </div>
      <BooleanSwitchRow
        label="Focus halo"
        checked={focusHalo}
        onCheckedChange={(checked) => {
          update({ focusHalo: checked });
        }}
      />
    </section>
  );
}
