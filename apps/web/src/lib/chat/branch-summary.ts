import { assistantAnswerText } from '@hushbox/shared';
import type { Message } from '@/lib/api/api';

export interface BranchFork {
  readonly id: string;
  readonly name: string;
  readonly tipMessageId: string | null;
}

export interface BranchSummary {
  readonly forkId: string;
  readonly name: string;
  /** The branch's first message after its fork point; empty when it has none yet. */
  readonly firstMessage: string;
  /** The number of the question at which the branches part, from 1; 0 when it is not known. */
  readonly forkPointOrdinal: number;
  /** The last message the parting branches share; null when it is not known. */
  readonly forkPointId: string | null;
}

/** The fork's messages from the root to its tip, by parent link. */
function pathTo(tipId: string | null, byId: ReadonlyMap<string, Message>): readonly Message[] {
  const path: Message[] = [];
  const seen = new Set<string>();
  let current = tipId === null ? undefined : byId.get(tipId);
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    const parentId = current.parentMessageId;
    current = parentId == null ? undefined : byId.get(parentId);
  }
  return path.toReversed();
}

function sharedPrefixLength(a: readonly Message[], b: readonly Message[]): number {
  let length = 0;
  while (length < a.length && length < b.length && a[length]?.id === b[length]?.id) length += 1;
  return length;
}

function displayText(message: Message | undefined): string {
  if (message === undefined) return '';
  return message.role === 'assistant' ? assistantAnswerText(message.content) : message.content;
}

/** The number of the question at which branches parting after `point` part. */
function partingQuestion(path: readonly Message[], point: Message, depth: number): number {
  const asked = path.slice(0, depth + 1).filter((m) => m.role === 'user').length;
  return point.role === 'user' ? asked : asked + 1;
}

interface Entry {
  readonly summary: BranchSummary;
  readonly depth: number;
  /** Keeps points at one depth on different branches apart, in the order they were first met. */
  readonly pointOrder: number;
  readonly forkIndex: number;
}

/**
 * One summary per fork and fork point, in thread order. A fork point is the last message two
 * branches share, and a branch is listed under every fork point it parts at, so a point's
 * count includes every branch that leaves it. A branch that shares nothing loaded with any
 * other is listed once, with no fork point.
 */
export function branchSummaries(
  messages: readonly Message[],
  forks: readonly BranchFork[]
): readonly BranchSummary[] {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const branches = forks.map((fork) => ({ fork, path: pathTo(fork.tipMessageId, byId) }));
  const entries: Entry[] = [];
  const pointOrders = new Map<string | null, number>();
  const orderOf = (pointId: string | null): number => {
    const known = pointOrders.get(pointId);
    if (known !== undefined) return known;
    pointOrders.set(pointId, pointOrders.size);
    return pointOrders.size - 1;
  };
  for (const [forkIndex, { fork, path }] of branches.entries()) {
    const partingDepths = new Set(
      branches
        .filter((other) => other.fork !== fork)
        .map((other) => sharedPrefixLength(path, other.path) - 1)
        .filter((depth) => depth >= 0)
    );
    if (partingDepths.size === 0) {
      entries.push({
        summary: {
          forkId: fork.id,
          name: fork.name,
          firstMessage: '',
          forkPointOrdinal: 0,
          forkPointId: null,
        },
        depth: Number.POSITIVE_INFINITY,
        pointOrder: orderOf(null),
        forkIndex,
      });
    }
    for (const [depth, point] of path.entries()) {
      if (!partingDepths.has(depth)) continue;
      entries.push({
        summary: {
          forkId: fork.id,
          name: fork.name,
          firstMessage: displayText(path[depth + 1]),
          forkPointOrdinal: partingQuestion(path, point, depth),
          forkPointId: point.id,
        },
        depth,
        pointOrder: orderOf(point.id),
        forkIndex,
      });
    }
  }
  return entries
    .toSorted(
      (a, b) => a.depth - b.depth || a.pointOrder - b.pointOrder || a.forkIndex - b.forkIndex
    )
    .map((entry) => entry.summary);
}
