/**
 * The fold every sampled run's memory record is assembled by: what the tree's
 * dearest reading held, how many lanes were live at that one reading, and the
 * most anything outside the lanes was ever read at.
 *
 * One implementation because the ladder these figures are read back off is one
 * ladder. `scripts/turbo-pool.ts` enumerates its lanes from the children it
 * spawned and `scripts/lib/vitest/workers.ts` from the runner's own children,
 * and those enumerations genuinely differ; what they do with a reading once it
 * is taken does not, and a `>=` here against a `>` there would leave one tool's
 * rows filed at a width the other's rule would have rejected, with nothing on
 * either side able to see it.
 *
 * The width is the lanes live at the one dearest reading, never the most lanes
 * any reading saw: the widest is a maximum over samples that never happened
 * together, and filing a dear reading at it would put a heavy row on a width
 * that never held it. Filed narrower than it was held is the harmful direction
 * — a low rung pinned high costs lanes at every wider count — which is why a
 * tie leaves the standing reading in place rather than taking the later one.
 *
 * Stopping is part of the fold rather than the caller's discipline. A reading
 * asked for while the run was live can land after the run has ended, and the
 * loop above drops that one; a fold that kept taking it would pair a width from
 * the dropped reading with a peak from an earlier one, which is the pairing
 * this whole shape exists to prevent. So the fold closes and the figures it
 * answers with afterwards are the ones it had reached.
 */

import type { AttributedTreePssKb } from './memory.js';

/** What a run's readings established about the tree they were taken over. */
export interface TreePeak {
  /** The largest total any one reading added up to; absent where none did. */
  readonly peakKb: number | undefined;
  /** Lanes live at that reading; absent for the same reason. */
  readonly lanesAtPeak: number | undefined;
  /** The largest reading taken outside every lane's subtree: the baseline. */
  readonly fixedKb: number | undefined;
}

export interface TreePeakFold {
  /**
   * Fold one reading taken over the given live lanes, and answer with that
   * reading's own total — the shape a peak-sampling loop drives, so the
   * baseline and the peak come out of one series of readings rather than two.
   *
   * A reading answers with a total whether or not the fold is still open: the
   * loop above asks for one to decide its own cadence, and the answer is about
   * the reading rather than about what the fold has kept.
   */
  readonly fold: (reading: AttributedTreePssKb, lanes: readonly number[]) => number | undefined;
  /** Close the fold and report what it reached. */
  readonly stop: () => TreePeak;
}

/** One reading added up over the lanes it was taken across, plus what sat outside them. */
function totalKb(reading: AttributedTreePssKb, lanes: readonly number[]): number | undefined {
  let total = reading.remainderKb;
  for (const pid of lanes) {
    const subtree = reading.rootsKb.get(pid);
    if (subtree === undefined) continue;
    total = (total ?? 0) + subtree;
  }
  return total;
}

export function foldTreePeak(): TreePeakFold {
  let peakKb: number | undefined;
  let lanesAtPeak: number | undefined;
  let fixedKb: number | undefined;
  let open = true;
  const peak = (): TreePeak => ({ peakKb, lanesAtPeak, fixedKb });
  return {
    fold: (reading, lanes) => {
      const total = totalKb(reading, lanes);
      if (!open) return total;
      const { remainderKb } = reading;
      if (remainderKb !== undefined) {
        fixedKb = fixedKb === undefined ? remainderKb : Math.max(fixedKb, remainderKb);
      }
      if (total !== undefined && (peakKb === undefined || total > peakKb)) {
        peakKb = total;
        lanesAtPeak = lanes.length;
      }
      return total;
    },
    stop: () => {
      open = false;
      return peak();
    },
  };
}
