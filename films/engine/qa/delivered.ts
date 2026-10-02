import { LEAD_FRAMES } from '../render/delivery-timing.js';

/** The film frame a delivered frame shows: the lead's copies all show frame 0. */
export function filmFrame(delivered: number): number {
  return Math.max(0, delivered - LEAD_FRAMES);
}
