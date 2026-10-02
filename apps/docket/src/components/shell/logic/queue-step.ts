import type { FindingJson } from '@hushbox/docket';

/**
 * Which finding a queue section is showing. A focused id the section no longer
 * holds — a filter narrowed it away, or a link is stale — lands on the head of
 * the queue rather than on nothing.
 */
export function currentIn(
  queue: readonly FindingJson[],
  focus: string | null
): FindingJson | undefined {
  return queue.find((finding) => finding.id === focus) ?? queue[0];
}

/**
 * One step along the queue. `current` is what the reader is on now, which is
 * not the same question in both view modes: focus mode always has a finding on
 * screen, while a list with nothing selected has none, so the first step there
 * takes the head of the queue instead of the second row.
 */
/**
 * What a reader who cannot see the queue is told when a step moves them. The
 * step changes the whole pane without moving focus, so nothing else in the
 * console reports it; the position is the one the pane prints beside its own
 * step buttons, so both readers are given the same fact.
 */
export function stepAnnouncement(queue: readonly FindingJson[], id: string): string {
  const index = queue.findIndex((finding) => finding.id === id);
  return index === -1 ? '' : `${id}. ${String(index + 1)} of ${String(queue.length)}.`;
}

/**
 * What a reader who cannot see the pane is told when something other than their
 * own step moved them, which is undo: it puts them back on the finding it
 * restored, in whatever section that finding now belongs to. No position is
 * given, because an undo changes the counts it would be quoting.
 */
export function landAnnouncement(id: string): string {
  return `Moved to ${id}.`;
}

export function stepFrom(
  queue: readonly FindingJson[],
  current: string | null,
  direction: 1 | -1
): FindingJson | undefined {
  const index = queue.findIndex((finding) => finding.id === current);
  return index === -1 ? queue[0] : queue[index + direction];
}
