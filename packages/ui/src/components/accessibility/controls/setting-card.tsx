import * as React from 'react';

import { cn } from '../../../lib/utilities';

export interface SettingCardOption<T extends string> {
  value: T;
  label: string;
}

export interface SettingCardProps<T extends string> {
  title: string;
  options: readonly SettingCardOption<T>[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
}

interface CardStyling {
  intensity: number;
  isOff: boolean;
  isDark: boolean;
  activeDotClass: string;
  inactiveDotClass: string;
  style: React.CSSProperties | undefined;
}

function nextIndex(length: number, current: number, delta: 1 | -1): number {
  return (current + delta + length) % length;
}

const KEY_TO_DELTA: Record<string, 1 | -1 | 'first' | 'last' | undefined> = {
  ArrowRight: 1,
  ArrowUp: 1,
  ' ': 1,
  Enter: 1,
  ArrowLeft: -1,
  ArrowDown: -1,
  Home: 'first',
  End: 'last',
};

function computeStyling(currentIndex: number, total: number): CardStyling {
  const intensity = total > 1 ? currentIndex / (total - 1) : 0;
  const isOff = currentIndex === 0;
  const isDark = intensity > 0.55;
  return {
    intensity,
    isOff,
    isDark,
    activeDotClass: isDark ? 'h-2 w-4 bg-white' : 'bg-foreground h-2 w-4',
    inactiveDotClass: isDark ? 'bg-white/40' : 'bg-foreground/25',
    style: isOff
      ? undefined
      : {
          ['--a11y-card-bg' as string]: `color-mix(in oklab, var(--color-brand-red) ${(intensity * 100).toFixed(0)}%, var(--background))`,
        },
  };
}

export function SettingCard<T extends string>({
  title,
  options,
  value,
  onChange,
  className,
}: Readonly<SettingCardProps<T>>): React.JSX.Element {
  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const currentLabel = options[currentIndex]?.label ?? '';
  const styling = computeStyling(currentIndex, options.length);

  const writeIndex = (index: number): void => {
    const next = options[index];
    if (next !== undefined) onChange(next.value);
  };

  const cycle = (delta: 1 | -1): void => {
    writeIndex(nextIndex(options.length, currentIndex, delta));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    const action = KEY_TO_DELTA[event.key];
    if (action === undefined) return;
    event.preventDefault();
    if (action === 'first') writeIndex(0);
    else if (action === 'last') writeIndex(options.length - 1);
    else cycle(action);
  };

  return (
    <button
      type="button"
      data-slot="setting-card"
      data-state={styling.isOff ? 'off' : 'on'}
      data-intensity={styling.intensity.toFixed(2)}
      onClick={() => {
        cycle(1);
      }}
      onKeyDown={handleKeyDown}
      aria-label={`${title}: ${currentLabel}`}
      style={styling.style}
      className={cn(
        'group border-input flex w-full flex-col items-stretch gap-2 rounded-lg border px-3 py-3 text-left transition-colors',
        'hover:border-foreground/40 focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
        styling.isOff ? 'bg-background text-foreground' : 'bg-[var(--a11y-card-bg)]',
        styling.isDark && !styling.isOff && 'text-white',
        className
      )}
    >
      <span className="text-xs font-medium opacity-80">{title}</span>
      <span className="text-base font-semibold">{currentLabel}</span>
      <span
        data-slot="setting-card-dots"
        aria-hidden="true"
        className="mt-1 flex items-center gap-1.5"
      >
        {options.map((option, index) => {
          const active = index === currentIndex;
          return (
            <span
              key={option.value}
              data-active={active ? 'true' : 'false'}
              className={cn(
                'h-1.5 w-1.5 rounded-full transition-all',
                active ? styling.activeDotClass : styling.inactiveDotClass
              )}
            />
          );
        })}
      </span>
    </button>
  );
}
