import * as React from 'react';
import { motion } from 'framer-motion';
import { cn } from '@hushbox/ui';
import type { PickerMode } from '@/stores/model';

interface PickerModeToggleProps {
  mode: PickerMode;
  onChange: (mode: PickerMode) => void;
  orientation: 'horizontal' | 'vertical';
  singleLabel: React.ReactNode;
  multiLabel: React.ReactNode;
  className?: string;
}

const PILL_LAYOUT_ID = 'picker-mode-toggle-pill';

interface OptionProps {
  value: PickerMode;
  active: boolean;
  testId: string;
  onSelect: (value: PickerMode) => void;
  onArrowToOther: () => void;
  arrowKeyToOther: 'ArrowRight' | 'ArrowDown' | 'ArrowLeft' | 'ArrowUp';
  children: React.ReactNode;
}

function PickerModeOption({
  value,
  active,
  testId,
  onSelect,
  onArrowToOther,
  arrowKeyToOther,
  children,
}: Readonly<OptionProps>): React.JSX.Element {
  const handleClick = (): void => {
    if (!active) onSelect(value);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === arrowKeyToOther) {
      e.preventDefault();
      onArrowToOther();
    }
  };

  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      data-active={active}
      data-testid={testId}
      tabIndex={active ? 0 : -1}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className={cn(
        'relative flex flex-1 items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium transition-colors',
        'focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none',
        active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground/80 cursor-pointer'
      )}
    >
      {active && (
        <motion.span
          layoutId={PILL_LAYOUT_ID}
          className="bg-background absolute inset-0 rounded-md shadow-sm"
          aria-hidden
          transition={{ type: 'spring', stiffness: 280, damping: 26 }}
        />
      )}
      <span className="relative z-10 flex items-center gap-2">{children}</span>
    </button>
  );
}

/**
 * Two-option segmented control for switching the model picker between
 * single-select and multi-select modes. Renders horizontally on mobile
 * (top of bottom sheet) and vertically on desktop (right-top of modal).
 *
 * The active-state pill slides between options via shared layoutId. Reduced
 * motion is handled globally by the root MotionConfig — no per-component
 * check needed.
 */
export function PickerModeToggle({
  mode,
  onChange,
  orientation,
  singleLabel,
  multiLabel,
  className,
}: Readonly<PickerModeToggleProps>): React.JSX.Element {
  const isHorizontal = orientation === 'horizontal';
  // Per option, the arrow key is the one that points TOWARDS the other option:
  // single (leftmost / topmost) → right/down. multi (rightmost / bottommost) → left/up.
  const singleArrowKey = isHorizontal ? 'ArrowRight' : 'ArrowDown';
  const multiArrowKey = isHorizontal ? 'ArrowLeft' : 'ArrowUp';

  const handleSelectFromSingle = (): void => {
    onChange('multi');
  };

  const handleSelectFromMulti = (): void => {
    onChange('single');
  };

  return (
    <div
      role="radiogroup"
      aria-orientation={orientation}
      data-testid="picker-mode-toggle"
      className={cn(
        'bg-muted/50 flex gap-1 rounded-lg p-1',
        isHorizontal ? 'flex-row' : 'flex-col',
        className
      )}
    >
      <PickerModeOption
        value="single"
        active={mode === 'single'}
        testId="picker-mode-single"
        onSelect={onChange}
        onArrowToOther={handleSelectFromSingle}
        arrowKeyToOther={singleArrowKey}
      >
        {singleLabel}
      </PickerModeOption>
      <PickerModeOption
        value="multi"
        active={mode === 'multi'}
        testId="picker-mode-multi"
        onSelect={onChange}
        onArrowToOther={handleSelectFromMulti}
        arrowKeyToOther={multiArrowKey}
      >
        {multiLabel}
      </PickerModeOption>
    </div>
  );
}
