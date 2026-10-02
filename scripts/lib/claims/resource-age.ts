/**
 * How long an unowned resource is left standing, and the reading that answers
 * it.
 *
 * Ownership is settled before anything here is read, and never by it: a
 * resource some claim names is live or expired by the kernel's answer about
 * that claim's lock, and only a resource no claim names at all — one nothing on
 * the machine can attribute to a run — reaches the question this module
 * answers. So no age enters a liveness decision; what an age decides is how
 * long a resource nothing accounts for is reported before the next run takes
 * it, which is a question about accumulation rather than about whether anything
 * is alive.
 */

/**
 * The age past which a resource no claim accounts for is reclaimed rather than
 * reported.
 *
 * Its derivation, which is why it is this large rather than tuned: the longest
 * operation this machine has a measured figure for is the full test suite at
 * roughly twelve and a half minutes, and this is about two hundred times that.
 * Nothing here legitimately holds a resource for that long, so the one failure
 * worth sizing against — reclaiming something that is still in use, which is
 * worse than the accumulation the boundary replaces — cannot be reached by
 * anything doing ordinary work.
 *
 * A single figure for every class is the blunt instrument, and deliberately so
 * while no class has shown it needs its own: a sharper per-class boundary is a
 * drill's one drill and a snapshot's one end-to-end run, and it waits for a
 * class that is harmed by the generous answer.
 */
export const UNOWNED_RECLAIM_AFTER_MS = 48 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/** The boundary in the words every line about it prints, derived from the figure itself. */
export const RECLAIM_BOUNDARY_PHRASE = `${String(UNOWNED_RECLAIM_AFTER_MS / HOUR_MS)} hours`;

/**
 * How long a resource has stood, or why that could not be read.
 *
 * `unreadable` is a third answer rather than an age of zero, because the
 * boundary is only ever crossed by an age that was established: a resource
 * whose age nothing could answer is not past it, keeps the behaviour it has
 * today, and gets a line saying the age could not be read rather than one
 * implying it is fresh.
 */
export type ResourceAge =
  | { readonly kind: 'known'; readonly elapsedMs: number }
  | {
      readonly kind: 'unreadable';
      /** What stopped the reading, in the words the line prints. */
      readonly reason: string;
    };

/**
 * Whether a resource nothing accounts for has stood long enough for the next
 * run to take it. Only an established age answers yes — an unread one, and a
 * pass that took no reading at all, both leave the resource standing.
 */
export function pastReclaimBoundary(age: ResourceAge | undefined): boolean {
  return age?.kind === 'known' && age.elapsedMs > UNOWNED_RECLAIM_AFTER_MS;
}

/**
 * What a line says where the pass asked how long a resource has stood and was
 * not told. One spelling, because the reclaiming command and the report both
 * print it and a reader comparing the two must not meet two sentences.
 */
export function unreadAgeClause(reason: string): string {
  return (
    `how long it has stood could not be read (${reason}), so nothing here can say whether the ` +
    `${RECLAIM_BOUNDARY_PHRASE} past which a resource nothing accounts for is reclaimed has passed`
  );
}
