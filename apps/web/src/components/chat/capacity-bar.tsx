import * as React from 'react';
import { cn } from '@lome-chat/ui';
import { CAPACITY_RED_THRESHOLD, CAPACITY_YELLOW_THRESHOLD } from '@lome-chat/shared';

interface CapacityBarProps {
  /** Current usage in tokens (input + min output buffer) */
  currentUsage: number;
  /** Model's maximum context length in tokens */
  maxCapacity: number;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Get fill color based on capacity percentage.
 * - Green: 0-32% (below yellow threshold)
 * - Yellow: 33-66% (between yellow and red thresholds)
 * - Red: 67%+ (at or above red threshold)
 */
function getFillColor(percentage: number): string {
  if (percentage >= CAPACITY_RED_THRESHOLD * 100) {
    return 'bg-red-500';
  }
  if (percentage >= CAPACITY_YELLOW_THRESHOLD * 100) {
    return 'bg-yellow-500';
  }
  return 'bg-green-500';
}

/**
 * Capacity progress bar showing model context usage.
 * Replaces the old x/y tokens indicator with a more intuitive visual.
 */
export function CapacityBar({
  currentUsage,
  maxCapacity,
  className,
}: CapacityBarProps): React.JSX.Element {
  const percentage = Math.round((currentUsage / maxCapacity) * 100);

  // Cap the visual fill at 100% but show actual percentage in label
  const fillWidth = Math.min(percentage, 100);
  const fillColor = getFillColor(percentage);

  return (
    <div data-testid="capacity-bar" className={cn('flex items-center gap-2', className)}>
      {/* Progress bar track */}
      <div data-testid="capacity-bar-track" className="bg-muted h-2 flex-1 overflow-hidden rounded">
        {/* Fill */}
        <div
          data-testid="capacity-bar-fill"
          className={cn('h-full rounded transition-all duration-300', fillColor)}
          style={{ width: `${String(fillWidth)}%` }}
        />
      </div>

      {/* Label */}
      <span className="text-muted-foreground text-sm whitespace-nowrap">
        Model {percentage}% filled
      </span>
    </div>
  );
}
