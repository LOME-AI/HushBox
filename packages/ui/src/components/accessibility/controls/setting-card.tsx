import { ChevronLeft, ChevronRight } from 'lucide-react';
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
  /**
   * Index of the option treated as the "neutral" middle. Options above this
   * index tint toward brand-red (more intense), options below tint toward the
   * info blue (less intense). Defaults to 0 — appropriate for one-directional
   * settings like "Off → On" or "Normal → Huge".
   */
  neutralIndex?: number;
  className?: string;
}

interface CardStyling {
  intensity: number;
  isNeutral: boolean;
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

const NEUTRAL_DOT_ACTIVE = 'bg-foreground h-2 w-4';
const NEUTRAL_DOT_INACTIVE = 'bg-foreground/25';

function computeStyling(currentIndex: number, total: number, neutralIndex: number): CardStyling {
  if (currentIndex === neutralIndex || total <= 1) {
    return {
      intensity: 0,
      isNeutral: true,
      isDark: false,
      activeDotClass: NEUTRAL_DOT_ACTIVE,
      inactiveDotClass: NEUTRAL_DOT_INACTIVE,
      style: undefined,
    };
  }
  const distance = currentIndex - neutralIndex;
  const maxDistance = distance > 0 ? total - 1 - neutralIndex : neutralIndex;
  const intensity = Math.abs(distance) / Math.max(maxDistance, 1);
  const isDark = intensity > 0.55;
  const tintColor = distance > 0 ? 'var(--color-brand-red)' : 'var(--color-info)';
  return {
    intensity,
    isNeutral: false,
    isDark,
    activeDotClass: isDark ? 'h-2 w-4 bg-white' : NEUTRAL_DOT_ACTIVE,
    inactiveDotClass: isDark ? 'bg-white/40' : NEUTRAL_DOT_INACTIVE,
    style: {
      ['--a11y-card-bg' as string]: `color-mix(in oklab, ${tintColor} ${(intensity * 100).toFixed(0)}%, var(--background))`,
    },
  };
}

export function SettingCard<T extends string>({
  title,
  options,
  value,
  onChange,
  neutralIndex = 0,
  className,
}: Readonly<SettingCardProps<T>>): React.JSX.Element {
  const currentIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const currentLabel = options[currentIndex]?.label ?? '';
  const styling = computeStyling(currentIndex, options.length, neutralIndex);

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

  const handleArrowClick =
    (delta: 1 | -1) =>
    (event: React.MouseEvent<HTMLSpanElement>): void => {
      event.stopPropagation();
      cycle(delta);
    };

  return (
    <button
      type="button"
      data-slot="setting-card"
      data-state={styling.isNeutral ? 'off' : 'on'}
      data-intensity={styling.intensity.toFixed(2)}
      onClick={() => {
        cycle(1);
      }}
      onKeyDown={handleKeyDown}
      aria-label={`${title}: ${currentLabel}`}
      style={styling.style}
      className={cn(
        'group border-foreground/20 flex w-full cursor-pointer flex-col items-stretch gap-2 rounded-lg border-2 px-3 py-3 text-left transition-colors',
        'hover:border-foreground/40 focus-visible:border-ring focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]',
        styling.isNeutral ? 'bg-background text-foreground' : 'bg-[var(--a11y-card-bg)]',
        styling.isDark && !styling.isNeutral && 'text-white',
        className
      )}
    >
      <span className="text-xs font-medium opacity-80">{title}</span>
      <span className="text-base font-semibold">{currentLabel}</span>
      <span className="-mt-1 flex items-center justify-center gap-2">
        <span
          data-slot="setting-card-prev"
          data-testid="setting-card-prev"
          aria-hidden="true"
          role="presentation"
          onClick={handleArrowClick(-1)}
          className="inline-flex cursor-pointer items-center justify-center rounded p-0.5 opacity-70 hover:opacity-100"
        >
          <ChevronLeft className="h-6 w-6" />
        </span>
        <span
          data-slot="setting-card-dots"
          aria-hidden="true"
          className="flex items-center gap-1.5"
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
        <span
          data-slot="setting-card-next"
          data-testid="setting-card-next"
          aria-hidden="true"
          role="presentation"
          onClick={handleArrowClick(1)}
          className="inline-flex cursor-pointer items-center justify-center rounded p-0.5 opacity-70 hover:opacity-100"
        >
          <ChevronRight className="h-6 w-6" />
        </span>
      </span>
    </button>
  );
}
