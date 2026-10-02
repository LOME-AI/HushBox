import * as React from 'react';
import type { HeadlinePoint } from './headline-figures.js';

const WIDTH = 120;
const HEIGHT = 24;

/**
 * The path through a tile's weekly points, scaled to the tallest of them. A
 * flat series sits on the baseline rather than dividing by a zero range.
 */
export function sparklinePath(points: readonly HeadlinePoint[]): string | null {
  if (points.length < 2) return null;
  const values = points.map((point) => point.value);
  const highest = Math.max(...values);
  const lowest = Math.min(...values);
  const range = highest - lowest;
  const stepX = WIDTH / (points.length - 1);
  return values
    .map((value, index) => {
      const y = range === 0 ? HEIGHT : HEIGHT - ((value - lowest) / range) * HEIGHT;
      return `${index === 0 ? 'M' : 'L'}${(index * stepX).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}

/**
 * A tile's trend line, hidden from assistive technology.
 *
 * That hiding is only permissible while the tiles panel (`headline-tiles.tsx`)
 * renders every one of these points as a real table: the line's own shape is the
 * whole of what it conveys, so without that table a reader who cannot see it
 * loses the trend outright. A panel that drops the table must stop hiding this.
 */
export function Sparkline({
  points,
}: Readonly<{ points: readonly HeadlinePoint[] }>): React.JSX.Element | null {
  const path = sparklinePath(points);
  if (path === null) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
      preserveAspectRatio="none"
      className="mt-1 h-6 w-full"
    >
      <path d={path} className="stroke-chart-2 fill-none" strokeWidth={1.5} />
    </svg>
  );
}
