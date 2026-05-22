/**
 * Compute a quadratic Bezier path between two points. The control point is
 * lifted perpendicular to the chord by a fraction of the chord length so the
 * arc bulges away from the straight line. Used for both hierarchy edges
 * (subtle curve) and dependency edges (more pronounced curve).
 *
 * The lift sign is fixed (always above for left-to-right edges) so the same
 * pair of points always produces the same arc — important for the static
 * server-precomputed layouts we render.
 */
export interface ArcEndpoint {
  x: number;
  y: number;
}

export function quadraticArcPath(
  source: ArcEndpoint,
  target: ArcEndpoint,
  liftRatio = 0.18
): string {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) {
    return `M${formatNumber(source.x)},${formatNumber(source.y)} L${formatNumber(target.x)},${formatNumber(target.y)}`;
  }
  const midX = (source.x + target.x) / 2;
  const midY = (source.y + target.y) / 2;
  const lift = distance * liftRatio;
  const nx = -dy / distance;
  const ny = dx / distance;
  const controlX = midX + nx * lift;
  const controlY = midY + ny * lift;
  return `M${formatNumber(source.x)},${formatNumber(source.y)} Q${formatNumber(controlX)},${formatNumber(controlY)} ${formatNumber(target.x)},${formatNumber(target.y)}`;
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toString() : value.toFixed(2);
}
