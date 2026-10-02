function assertSpan(name: string, from: number, to: number): void {
  if (to <= from) {
    throw new RangeError(
      `${name} span [${String(from)}, ${String(to)}) holds no frames: to must come after from`
    );
  }
}

/**
 * A zoom from `z0` to `z1` across `[from, to)`, interpolated in log space so the
 * picture grows at a constant perceived speed; exactly `z0` up to `from` and
 * exactly `z1` from `to` on.
 */
export function logZoom(
  frame: number,
  from: number,
  to: number,
  [z0, z1]: readonly [number, number]
): number {
  if (!(z0 > 0 && z1 > 0)) {
    throw new RangeError(
      `logZoom from zoom ${String(z0)} to ${String(z1)}: both zooms must be above 0`
    );
  }
  assertSpan('logZoom', from, to);
  if (frame <= from) {
    return z0;
  }
  if (frame >= to) {
    return z1;
  }
  return z0 * (z1 / z0) ** ((frame - from) / (to - from));
}
